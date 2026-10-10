import { DomainError, isDomainError } from "../domain/errors";
import { compareSortKeys, keyBetween } from "../domain/sortKey";
import { TagNames, normalizeTagKey, tagDisplayPath, tagPath } from "../domain/tags";
import { categoryNameKey, requireTitle } from "../domain/tasks";
import {
	type SyncFields,
	dateFromTt,
	dateToTt,
	fieldHashes,
	isSyncable,
	priorityFromTt,
	priorityToTt,
	pulledDatePatch,
	statusFromTt,
	statusToTt,
	syncDateOf,
	tagsHash,
} from "../domain/ticktick/mapping";
import { isSyncedTag, pullableTagName, syncedTagLeaves, ttTagName, unsyncedTagKeys } from "../domain/ticktick/tags";
import {
	TICKTICK_BATCH_MAX,
	TICKTICK_COMPLETED_MAX,
	TICKTICK_FREE_OPEN_MAX,
	type TtColumn,
	type TtMove,
	type TtProjectData,
	type TtTag,
	type TtTask,
	type TtTaskCreate,
	type TtTaskUpdate,
	type TtTaskWrite,
} from "../domain/ticktick/types";
import { type ID, type Instant, type SyncLink, type Tag, type Task, paletteColor, syncLinkId } from "../domain/types";
import type { DbData } from "../persistence/schema";
import { type SettingsPort, type TickTickApi, TickTickError, type TickTickErrorKind } from "./ports";
import type { SectionService } from "./SectionService";
import type { AppStore } from "./store";
import type { TaskInput, TaskPatch, TaskService } from "./TaskService";
import { type ListIndex, SYNCED_LIST_OPEN_MAX } from "./listIndex";
import { INBOX_ALIAS, InboxAliasApi, canonicalProjectId } from "./tickTickInbox";
import { type NotePush, SyncNotes, type SyncNotesDeps, TICKTICK_NOTE_WARNING, ownsNote } from "./syncNotes";
import { type StoredNoteBase, docFromTickTick, isChecklist, sameDoc, storedBase, ttNoteWrite } from "../domain/ticktick/noteText";
import { sameLines } from "../domain/textMerge";
import type { Change, Tx } from "./tx";
import type { WriteResult } from "./writes";

// The TickTick sync engine. One sync pulls every linked list, merges per field,
// writes the pulled changes as one content command, pushes Logwell's changes, then writes the bookkeeping (syncLinks)
// as its own command that is never undoable. Pulls (background, Sync now, first sync) are not undoable either;
// only a confirmed bulk Move to Trash is, and undoing it restores unlinked tasks that the next sync creates again. No
// scheduler here: the session's `TickTickScheduler` (src/obsidian) decides when to sync.

/** The content command of a sync: pulled tasks, sections, completions, Trash. */
export const TICKTICK_SYNC_LABEL = "TickTick sync";
/** The confirmed Move to Trash of tasks missing from TickTick; the only undoable sync command. */
export const TICKTICK_TRASH_LABEL = "Move missing TickTick tasks to Trash";
/** The bookkeeping command: links, etags, field hashes. Never undoable. */
export const TICKTICK_LINKS_LABEL = "TickTick sync links";
export const TICKTICK_UNLINK_LABEL = "Unlink list from TickTick";
/** "Keep" for 5 or more tasks missing from TickTick: they stay in Logwell only. Bookkeeping, never undoable. */
export const TICKTICK_KEEP_LABEL = "Keep missing TickTick tasks in Logwell";
/**
 * The commands of the sync itself (and of its confirmations): they never trigger a push, or every sync would start
 * the next one. An undo of one of them is labelled "Undo …" and does.
 */
export const SYNC_OWN_LABELS: ReadonlySet<string> = new Set([TICKTICK_SYNC_LABEL, TICKTICK_TRASH_LABEL, TICKTICK_LINKS_LABEL, TICKTICK_UNLINK_LABEL, TICKTICK_KEEP_LABEL]);
/** A `SyncResult` warning: `GET /tag` failed (not for the token, a rate limit or the network); the sync went on. */
export const TICKTICK_TAGS_UNREAD_WARNING = "TickTick tags could not be read; tags were synced by name only.";
/** This many tasks missing from one project, or more, are not moved to Trash without confirmation. */
export const MISSING_CONFIRM_MIN = 5;
/** TickTick's name for the tasks of a kanban project that are in no column. */
export const NOT_SECTIONED = "Not Sectioned";
/**
 * Per sync, all lists together: the most lookups of linked tasks missing from the pull (completed, won't do or gone;
 * a retry in another linked project is one more). The rest wait for the next sync and are never offered for Trash.
 */
export const LOOKUP_MAX = 50;
/**
 * The pull's requests in one sync, to stay under TickTick's rate limit of about 100 a minute. It bounds the splits of
 * completed reads (a window still full past it counts as cut) and the lookups (none past it). Each list still gets its
 * project data and first completed read, so the pull makes at most this many requests plus two per linked list.
 */
const PULL_REQUESTS_MAX = 90;
/** Completions are re-read from a little before the last pull, so clock skew cannot drop one. */
const COMPLETED_OVERLAP_MS = 5 * 60_000;
/**
 * The completed-tasks query takes whole seconds (`ttStamp`) and whether its bounds are inclusive is not known, so the
 * halves of a split window share one second; a window of two such seconds or less is not split further.
 */
const COMPLETED_WINDOW_MIN_MS = 1000;
/**
 * Per list and sync: full completed-tasks reads, each split in two (TickTick sync rule 23). A list makes at most
 * twice this many reads, plus one.
 */
const COMPLETED_READS_MAX = 32;
/**
 * A sync that wrote nothing else leaves `lastPulledAt` as it is, until it is this old. Two devices with sync on would
 * otherwise wake each other forever: every write reaches the other device as a reload, which syncs and writes again.
 * The next pull asks for completions since the stored time (less the overlap) either way, so none is missed.
 */
const LAST_PULLED_REFRESH_MS = 60 * 60_000;

const FIELDS = ["title", "status", "priority", "date", "parent", "section", "tags"] as const satisfies readonly (keyof SyncFields)[];
type Field = (typeof FIELDS)[number];

const EMPTY_HASHES = fieldHashes({ title: "", status: "open", priority: 0, date: null, parent: null, section: null, tags: [] });
const NO_SECTION_HASH = EMPTY_HASHES.section!;
const OPEN_HASH = EMPTY_HASHES.status!;
const EMPTY_TAGS = tagsHash([]);

/** `list-limit`: TickTick refused a write to a list at its free plan's open-task limit. */
export type SyncFailureKind = TickTickErrorKind | "list-limit";

/** Why a sync stopped: the list it was working on and the reason. */
export interface SyncFailure {
	listId: ID | null;
	listName: string | null;
	kind: SyncFailureKind;
	message: string;
	/** HTTP 429 only: how long TickTick asked to wait. */
	retryAfterSec: number | null;
}

/** Tasks missing from TickTick that wait for "Move to Trash" or "Keep". Nothing was applied for them. */
export interface PendingTrash {
	listId: ID;
	/** `many`: 5 or more in the list; `emptied`: the project came back with no open task. */
	reason: "many" | "emptied";
	tasks: { id: ID; title: string }[];
}

export interface SyncResult {
	ok: boolean;
	/** The first failure; `failures` has one per list that stopped. */
	error: SyncFailure | null;
	failures: SyncFailure[];
	/** The content command (never on the undo stack): whether the pull wrote anything. */
	content: WriteResult;
	/** Logwell tasks written by the pull (created, changed, completed, moved to Trash). */
	pulled: number;
	/** TickTick writes that succeeded. */
	pushed: number;
	needsConfirmation: PendingTrash[];
	/** Problems that did not stop the sync, as sentences for the user (`TICKTICK_TAGS_UNREAD_WARNING`). */
	warnings: string[];
}

/** What a first sync will copy each way. */
export interface FirstSyncPlan {
	listId: ID;
	projectId: string;
	/** Open, syncable TickTick tasks that come into the list. */
	toLogwell: number;
	/** Open, non-repeating Logwell tasks that go up. */
	toTickTick: number;
}

interface LinkedList {
	listId: ID;
	name: string;
	link: SyncLink;
}

interface ListPull extends LinkedList {
	projectId: string;
	data: TtProjectData;
	/** Its completed tasks needed more than one read: `lastPulledAt` is written even by a quiet sync. */
	splitCompleted: boolean;
}

/** A Logwell task and its TickTick task after the pull: what the push compares. */
interface Pair {
	logwellId: ID;
	ttId: string;
	/** Where the TickTick task is now. */
	ttProjectId: string;
	etag: string | null;
	/** The TickTick values now, hashed; a value that cannot be resolved reads as the link's base. */
	ttHashes: Record<string, string>;
}

interface PullPlan {
	pairs: Pair[];
	/** Links of tasks deleted in Logwell or moved to a list that is not linked: deleted in TickTick. */
	deletes: SyncLink[];
	removeLinks: Set<string>;
	/** Links to mark `excluded`: the task repeats on one side. */
	exclude: Set<string>;
	newLinks: LinkDraft[];
	needsConfirmation: PendingTrash[];
	/** Logwell tasks and sections written. */
	written: number;
	wrote: boolean;
}

/** A create TickTick answered whose link could not be written: its id and the field hashes that were sent. */
interface AnsweredCreate {
	ttId: string;
	base: Record<string, string>;
}

type LinkDraft = Pick<SyncLink, "kind" | "logwellId" | "ttId" | "ttProjectId" | "etag" | "base"> & {
	/** The note text TickTick confirmed, the new `noteBase`; absent keeps the link's. */
	note?: StoredNoteBase;
};

function failureOf(err: unknown, list: { listId: ID; name: string } | null): SyncFailure {
	if (!(err instanceof TickTickError)) throw err;
	return { listId: list?.listId ?? null, listName: list?.name ?? null, kind: err.kind, message: err.message, retryAfterSec: err.retryAfterSec };
}

function isNotFound(err: unknown): boolean {
	return err instanceof TickTickError && err.kind === "not-found";
}

/** An epoch time cut to the whole second, as `ttStamp` sends it. */
function wholeSecond(ms: number): number {
	return Math.floor(ms / 1000) * 1000;
}

/** An instant in the form of TickTick's queries (`2026-10-08T00:00:00+0000`). */
function ttStamp(ms: number): string {
	return `${new Date(ms).toISOString().slice(0, 19)}+0000`;
}

/** A TickTick title as Logwell stores it; an empty one becomes "Untitled". */
function ttTitle(raw: string | undefined): string {
	try {
		return requireTitle(raw ?? "");
	} catch {
		return "Untitled";
	}
}

/**
 * A new Logwell task with a TickTick task's priority, date and tags (an import or a conflict copy). The section is kept
 * only when it is in `categoryId`.
 */
function taskInputFromTt(tx: Tx, tt: TtTask, zone: string, tags: PullTags, title: string, categoryId: ID, parentId: ID | null, sectionId: ID | null): TaskInput {
	const dates = pulledDatePatch(null, dateFromTt(tt, zone));
	return {
		title,
		categoryId,
		parentId,
		sectionId: sectionId !== null && tx.get("sections", sectionId)?.categoryId === categoryId ? sectionId : null,
		priority: priorityFromTt(tt.priority),
		scheduled: dates.scheduled ?? null,
		deadline: dates.deadline ?? null,
		tagKeys: tags.keysOf(tt),
	};
}

function sameBase(a: Record<string, string>, b: Record<string, string>): boolean {
	const ka = Object.keys(a);
	if (ka.length !== Object.keys(b).length) return false;
	return ka.every((k) => a[k] === b[k]);
}

/** The tag names of the state's tags, memoized per tags map (a committed state's maps never change). */
const namesMemo = new WeakMap<ReadonlyMap<string, Tag>, TagNames>();
function tagNamesOf(tags: ReadonlyMap<string, Tag>): TagNames {
	let names = namesMemo.get(tags);
	if (names === undefined) {
		names = TagNames.of(tags.values());
		namesMemo.set(tags, names);
	}
	return names;
}

/**
 * Hashes of a Logwell task's synced values, memoized per record (records are immutable) and tag names (which tags
 * sync depends on every tag; a task with no tags does not depend on them, `names` null).
 */
const lwMemo = new WeakMap<Task, { names: TagNames | null; h: Record<string, string> }>();
function lwHashes(t: Task, names: TagNames): Record<string, string> {
	const memo = lwMemo.get(t);
	if (memo !== undefined && (memo.names === null || memo.names === names)) return memo.h;
	const h = fieldHashes({
		title: t.title,
		status: t.status,
		priority: t.priority,
		date: syncDateOf(t),
		parent: t.parentId,
		// A subtask follows its parent's section, so its own is not compared.
		section: t.parentId === null ? t.sectionId : null,
		tags: t.tagKeys.length === 0 ? [] : syncedTagLeaves(names, t.tagKeys),
	});
	lwMemo.set(t, { names: t.tagKeys.length === 0 ? null : names, h });
	return h;
}

/** The pullable tag names of a TickTick task, lowercase, each once. */
function ttLeaves(tt: TtTask, names: TagNames): string[] {
	if (tt.tags === undefined || tt.tags.length === 0) return [];
	const out = new Set<string>();
	for (const raw of tt.tags) {
		const name = pullableTagName(names, raw);
		if (name !== null) out.add(name);
	}
	return [...out].sort();
}

/**
 * TickTick's tags (`GET /tag`), read at most once per sync and only when needed: to name and nest a tag Logwell does
 * not know, or to learn which tag records are missing before a push sends a tag.
 */
class RemoteTags {
	private read: Map<string, TtTag> | null = null;
	/** The read failed (not fatally): reported as a warning. */
	unread = false;

	constructor(private readonly api: TickTickApi) {}

	/** What was read; null when nothing was. */
	get known(): ReadonlyMap<string, TtTag> | null {
		return this.read;
	}

	/**
	 * Reads once per sync. The endpoint is undocumented, so a failure that concerns only it (a server error, an
	 * unreadable answer) leaves TickTick's tags unknown for the rest of the sync, as an empty map, and is not read
	 * again: an unknown pulled name then becomes a tag of that name, and the push creates each record it sends
	 * (creating a name TickTick has is a silent no-op). A token, rate-limit or network error is thrown as usual.
	 */
	async load(): Promise<Map<string, TtTag>> {
		if (this.read === null) {
			const map = new Map<string, TtTag>();
			try {
				for (const t of await this.api.listTags()) map.set(t.name.toLowerCase(), t);
			} catch (err) {
				if (!(err instanceof TickTickError) || STOPS_ALL.has(err.kind)) throw err;
				this.unread = true;
				console.debug("Logwell: TickTick tags could not be read.", err.message);
			}
			this.read = map;
		}
		return this.read;
	}
}

/** The tag side of one pull: Logwell keys for TickTick names, creating the tags Logwell lacks (in the content tx). */
interface PullTags {
	readonly names: TagNames;
	/** The Logwell keys of a TickTick task's pullable names, in its order. */
	keysOf(tt: TtTask): string[];
}

/** Sort keys for many new tasks: the end of each (list, parent) group, then onwards. */
class SortKeys {
	private readonly ends = new Map<string, string>();
	private readonly read = new Set<ID>();

	constructor(
		private readonly tx: Tx,
		private readonly index: ListIndex,
	) {}

	next(categoryId: ID, parentId: ID | null): string {
		if (!this.read.has(categoryId)) {
			this.read.add(categoryId);
			for (const t of this.index.tasksOf((id) => this.tx.get("tasks", id), categoryId)) {
				const k = `${t.categoryId}|${t.parentId ?? ""}`;
				const end = this.ends.get(k);
				if (end === undefined || t.sortKey > end) this.ends.set(k, t.sortKey);
			}
		}
		const k = `${categoryId}|${parentId ?? ""}`;
		const key = keyBetween(this.ends.get(k) ?? null, null);
		this.ends.set(k, key);
		return key;
	}
}

export class SyncService {
	/** The running `sync()`, for single flight. */
	private running: Promise<SyncResult> | null = null;
	/** A trigger that came while a sync ran: exactly one more run after it. */
	private rerun = false;
	/** Every sync, first sync, confirmation and unlink runs after the one before. */
	private tail: Promise<unknown> = Promise.resolve();
	/** The API, refusing every request once `stop` was called. */
	private readonly api: TickTickApi;
	/** The layer under `api` that makes the Inbox's two spellings one project. */
	private readonly inbox: InboxAliasApi;
	/** Runs started by `serial` and not finished. */
	private inFlight = 0;
	/** Set by `stop`: a queued rerun is dropped and none is queued again. */
	private stopped = false;
	/**
	 * Logwell tasks created in TickTick but not linked, per list, so a later pull links them instead of
	 * importing a duplicate. Two cases: `createTask` failed in a way that may have created the task anyway
	 * (`maybePartial`: the answer and the new id were lost; value null), matched by title on the next sync only;
	 * or TickTick answered but writing the link failed (the store turned read-only; value: TickTick's id and the
	 * hashes that were sent), matched by that id whatever the copy's status, and looked up by id if the pull does
	 * not see it. The hashes sent are the base, so later edits on either side merge as usual. In memory only: after a
	 * reload such a task can come in twice.
	 */
	private readonly pendingCreates = new Map<ID, Map<ID, AnsweredCreate | null>>();
	/** TickTick ids a lookup found gone, kept for the next sync while their tasks stay missing and undecided. */
	private goneInTickTick = new Set<string>();

	/** See `pendingCreates`: what TickTick answered (the link write failed), or null when the answer was lost. */
	private remember(listId: ID, logwellId: ID, answer: AnsweredCreate | null): void {
		const pending = this.pendingCreates.get(listId) ?? new Map<ID, AnsweredCreate | null>();
		pending.set(logwellId, answer);
		this.pendingCreates.set(listId, pending);
	}

	private readonly index: ListIndex;
	/** Description notes; null when the host gives no vault (the sync never touches a note). */
	private readonly notes: SyncNotes | null;
	/** Links being marked `pendingDelete` after a change removed their task (see `onChanged`); a sync waits for it. */
	private marking: Promise<unknown> = Promise.resolve();
	/** Tasks whose `pendingDelete` marking failed: tried again at the start of the next sync. */
	private readonly unmarked = new Set<ID>();

	constructor(
		private readonly store: AppStore,
		private readonly tasks: TaskService,
		private readonly sections: SectionService,
		private readonly settings: Pick<SettingsPort, "zone">,
		api: TickTickApi,
		notes?: SyncNotesDeps,
	) {
		this.index = tasks.lists;
		this.notes = notes === undefined ? null : new SyncNotes(notes, store, tasks, { content: TICKTICK_SYNC_LABEL, links: TICKTICK_LINKS_LABEL });
		// The Inbox's two spellings (`inbox` and `inbox<digits>`) are one project to everything below this line.
		// The stop guard wraps both sides: the Inbox wrapper's own follow-up calls (learning the real id, moving a stray
		// create) also stop once the sync is stopped.
		this.inbox = new InboxAliasApi(stoppable(api, () => this.stopped));
		this.api = stoppable(this.inbox, () => this.stopped);
		store.bus.on("changed", (e) => this.onChanged(e.changes));
	}

	/**
	 * A command that removes a linked task without moving it to Trash (an undo of its create, duplicate or Quick
	 * Add) leaves no trace for the sync to find. The link is marked `pendingDelete` in a links command of its own
	 * (never undoable), as a purge does, so the next sync deletes the TickTick copy. The store stays generic: it only
	 * reports what changed. An excluded link is marked too: the sync then removes it, deleting the TickTick copy
	 * only when that copy is plain (never a repeating one).
	 */
	private onChanged(changes: readonly Change[] | undefined): void {
		if (changes === undefined) return;
		const removed: ID[] = [];
		for (const ch of changes) {
			if (ch.c === "tasks" && ch.before !== undefined && ch.after === undefined) removed.push(ch.id);
		}
		if (removed.length === 0) return;
		const state = this.store.state;
		const candidates = removed.filter((id) => {
			const link = state.syncLinks.get(syncLinkId("task", id));
			return link !== undefined && link.pendingDelete !== true;
		});
		if (candidates.length > 0) void this.markRemoved(candidates);
	}

	/**
	 * Marks the links of tasks that are gone (and not in Trash) `pendingDelete`. A marking that fails (the store
	 * turned read-only) is kept and tried again at the start of the next sync.
	 */
	private markRemoved(ids: readonly ID[]): Promise<unknown> {
		this.marking = this.marking.then(() =>
			this.store
				.run(
					TICKTICK_LINKS_LABEL,
					(tx) => {
						const trashed = trashedIds(tx);
						for (const id of ids) {
							this.unmarked.delete(id);
							const link = tx.get("syncLinks", syncLinkId("task", id));
							if (link === undefined || link.pendingDelete === true) continue;
							if (tx.get("tasks", id) !== undefined || trashed.has(id)) continue;
							tx.put("syncLinks", { ...link, pendingDelete: true, modifiedAt: tx.now });
						}
					},
					{ undoable: false },
				)
				.catch(() => {
					for (const id of ids) this.unmarked.add(id);
				}),
		);
		return this.marking;
	}


	// -- entry points --------------------------------------------------------------------------------------------

	/**
	 * Syncs every linked list ("Sync now" and background pulls alike; neither is undoable). A call while a sync runs
	 * returns the running sync and queues exactly one more run after it.
	 */
	sync(): Promise<SyncResult> {
		if (this.running !== null) {
			if (!this.stopped) this.rerun = true;
			return this.running;
		}
		return this.start();
	}

	/**
	 * Whether a vault change at `path` is the user's edit of a description note the sync keeps in step with
	 * TickTick (the host then pushes it soon, as for a task edit). The sync's own note writes are not.
	 */
	isSyncNoteEdit(path: string): boolean {
		return this.notes?.edited(path) ?? false;
	}

	/** Whether a sync, first sync, confirmation or unlink is running or waiting to run. */
	get busy(): boolean {
		return this.inFlight > 0;
	}

	/**
	 * The session is closing. No further request is sent: each fails as a network error before it goes out, so at most
	 * the one already in flight completes, and what TickTick answered is still linked. A sync stopped before it wrote
	 * its pull writes nothing. The rerun queued by a trigger during a sync is dropped, and no new one is queued.
	 */
	stop(): void {
		this.stopped = true;
		this.rerun = false;
	}

	/** Resolves when no sync runs and none is queued. */
	async idle(): Promise<void> {
		for (;;) {
			const current = this.running ?? this.tail;
			await current.catch(() => undefined);
			if (this.running === null && !this.rerun && current === this.tail) return;
		}
	}

	/** The first-sync preview. Writes nothing. */
	async planFirstSync(listId: ID, projectId: string): Promise<FirstSyncPlan> {
		this.assertLinkable(this.store.state, listId, projectId);
		const data = await this.api.getProjectData(projectId);
		assertTaskProject(data);
		let toTickTick = 0;
		const tasks = this.store.state.tasks;
		for (const t of this.index.tasksOf((id) => tasks.get(id), listId)) {
			if (t.status === "open" && t.recurrence === null) toTickTick++;
		}
		const toLogwell = data.tasks.filter((t) => statusFromTt(t.status) === "open" && isSyncable(t)).length;
		return { listId, projectId, toLogwell, toTickTick };
	}

	/**
	 * Links the list to the project and runs the first sync (not undoable). No matching:
	 * TickTick's open tasks and sections come in, Logwell's open tasks go up.
	 */
	applyFirstSync(listId: ID, projectId: string): Promise<SyncResult> {
		return this.serial(async () => {
			this.assertLinkable(this.store.state, listId, projectId);
			let data: TtProjectData;
			try {
				data = await this.api.getProjectData(projectId);
			} catch (err) {
				const name = this.store.state.categories.get(listId)?.name ?? null;
				return failed(failureOf(err, { listId, name: name ?? "" }));
			}
			assertTaskProject(data);
			// A backup of the database as it is, before the first sync writes anything. One that cannot be
			// taken stops the first sync.
			await this.store.snapshot("pre-sync");
			await this.store.run(
				TICKTICK_LINKS_LABEL,
				(tx) => {
					this.assertLinkable(tx.base, listId, projectId);
					tx.put("syncLinks", {
						kind: "list",
						logwellId: listId,
						ttId: canonicalProjectId(projectId),
						ttProjectId: null,
						etag: null,
						base: {},
						noteBySync: false,
						lastPulledAt: null,
						modifiedAt: tx.now,
					});
				},
				{ undoable: false },
			);
			return this.runSync();
		});
	}

	/** "Move to Trash" after confirmation: one undoable step; their links go in the bookkeeping. */
	trashMissing(listId: ID, taskIds: readonly ID[]): Promise<WriteResult> {
		return this.serial(async () => {
			let wrote = false;
			await this.store.run(TICKTICK_TRASH_LABEL, (tx) => {
				for (const id of taskIds) {
					const t = tx.get("tasks", id);
					if (t === undefined || t.categoryId !== listId) continue;
					this.tasks.deleteIn(tx, id);
					wrote = true;
				}
			});
			await this.store.run(
				TICKTICK_LINKS_LABEL,
				(tx) => {
					for (const id of taskIds) if (tx.get("tasks", id) === undefined) tx.remove("syncLinks", syncLinkId("task", id));
				},
				{ undoable: false },
			);
			return { wrote, label: TICKTICK_TRASH_LABEL };
		});
	}

	/**
	 * "Keep" after confirmation. `many`: the tasks stay in Logwell only: their links become `localOnly`,
	 * so they are never pushed, deleted, pulled or imported again, and never created in TickTick again. `emptied` (the
	 * project came back empty): the list is unlinked and every task stays on both sides. Only links are written, so
	 * like every links command it is not undoable and offers no Undo.
	 */
	keepMissing(listId: ID, taskIds: readonly ID[], reason: PendingTrash["reason"]): Promise<WriteResult> {
		if (reason === "emptied") return this.unlinkList(listId);
		return this.serial(async () => {
			let wrote = false;
			await this.store.run(
				TICKTICK_KEEP_LABEL,
				(tx) => {
					const project = this.projectOfList(tx, listId);
					if (project === undefined) return;
					for (const id of taskIds) {
						const link = tx.get("syncLinks", syncLinkId("task", id));
						if (link === undefined || canonicalProjectId(link.ttProjectId ?? "") !== project || link.mode === "localOnly") continue;
						tx.put("syncLinks", { ...link, mode: "localOnly", modifiedAt: tx.now });
						wrote = true;
					}
				},
				{ undoable: false },
			);
			return { wrote, label: TICKTICK_KEEP_LABEL };
		});
	}

	/** Removes the list's links. Every task stays on both sides. Not undoable. */
	unlinkList(listId: ID): Promise<WriteResult> {
		return this.serial(async () => {
			let wrote = false;
			await this.store.run(
				TICKTICK_UNLINK_LABEL,
				(tx) => {
					const listLink = tx.get("syncLinks", syncLinkId("list", listId));
					if (listLink === undefined) return;
					const project = canonicalProjectId(listLink.ttId);
					for (const l of tx.all("syncLinks")) {
						const ofList =
							l === listLink ||
							(l.ttProjectId !== null && canonicalProjectId(l.ttProjectId) === project) ||
							(l.kind === "task" && tx.get("tasks", l.logwellId)?.categoryId === listId) ||
							(l.kind === "section" && tx.get("sections", l.logwellId)?.categoryId === listId);
						if (ofList) tx.remove("syncLinks", syncLinkId(l.kind, l.logwellId));
					}
					wrote = true;
				},
				{ undoable: false },
			);
			this.pendingCreates.delete(listId);
			return { wrote, label: TICKTICK_UNLINK_LABEL };
		});
	}

	/**
	 * The tags of a task that do not sync with TickTick ("Not synced"): a later tag whose name an older one owns,
	 * a tag nested deeper than one level, or one whose parent's name is owned elsewhere. Empty for a task that does not
	 * sync (not in a linked list, repeating, or kept in Logwell only).
	 */
	unsyncedTagKeys(taskId: ID): string[] {
		const state = this.store.state;
		const t = state.tasks.get(taskId);
		if (t === undefined || t.tagKeys.length === 0 || t.recurrence !== null) return [];
		if (!state.syncLinks.has(syncLinkId("list", t.categoryId))) return [];
		const link = state.syncLinks.get(syncLinkId("task", t.id));
		if (link !== undefined && (link.mode ?? "sync") !== "sync") return [];
		return unsyncedTagKeys(tagNamesOf(state.tags), t.tagKeys);
	}

	/** Whether a task the pull may take in carries a tag name Logwell does not know. */
	private needsRemoteTags(seen: ReadonlyMap<string, TtTask>): boolean {
		const state = this.store.state;
		const names = tagNamesOf(state.tags);
		let linkByTt: Map<string, SyncLink> | null = null;
		for (const tt of seen.values()) {
			if (tt.tags === undefined || tt.tags.length === 0) continue;
			const unknown = tt.tags.some((raw) => {
				const name = pullableTagName(names, raw);
				return name !== null && names.owner(name) === undefined;
			});
			if (!unknown) continue;
			// A linked copy TickTick has not changed since the last sync brings nothing in.
			if (linkByTt === null) {
				linkByTt = new Map();
				for (const l of state.syncLinks.values()) if (l.kind === "task") linkByTt.set(l.ttId, l);
			}
			const link = linkByTt.get(tt.id);
			// Never taken in: a repeating task or a note, an unlinked one that is not open, a link that does not sync.
			if (!isSyncable(tt)) continue;
			if (link === undefined) {
				if (statusFromTt(tt.status) === "open") return true;
				continue;
			}
			if ((link.mode ?? "sync") !== "sync" || link.pendingDelete === true) continue;
			if (tt.etag === undefined || tt.etag !== link.etag) return true;
		}
		return false;
	}

	// -- flight control ------------------------------------------------------------------------------------------

	private serial<T>(fn: () => Promise<T>): Promise<T> {
		this.inFlight++;
		const run = this.tail.then(fn);
		this.tail = run.then(
			() => void this.inFlight--,
			() => void this.inFlight--,
		);
		return run;
	}

	private start(): Promise<SyncResult> {
		const run = this.serial(() => this.runSync());
		this.running = run;
		const settle = (): void => {
			if (this.running === run) this.running = null;
			const again = this.rerun;
			this.rerun = false;
			if (again) void this.start().catch(() => undefined);
		};
		run.then(settle, settle);
		return run;
	}

	// -- checks --------------------------------------------------------------------------------------------------

	private assertLinkable(state: DbData, listId: ID, projectId: string): void {
		const list = state.categories.get(listId);
		if (list === undefined) throw new DomainError("NotFound", "The list no longer exists.");
		if (state.syncLinks.has(syncLinkId("list", listId))) throw new DomainError("InvalidValue", "This list is already linked to TickTick.");
		// Completed tasks do not count.
		if (this.index.openCount(listId) > SYNCED_LIST_OPEN_MAX) {
			throw new DomainError(
				"SyncedListFull",
				`Can't link the list: ${list.name} has more than ${SYNCED_LIST_OPEN_MAX} open tasks, the most a list synced with TickTick can hold.`,
			);
		}
		for (const l of state.syncLinks.values()) {
			if (l.kind === "list" && canonicalProjectId(l.ttId) === canonicalProjectId(projectId)) throw new DomainError("InvalidValue", "That TickTick list is already linked to another list.");
		}
	}

	/** The linked lists whose Logwell list exists, in list order. A link whose list has not arrived is skipped. */
	private linkedLists(state: DbData): LinkedList[] {
		const out: LinkedList[] = [];
		for (const link of state.syncLinks.values()) {
			if (link.kind !== "list") continue;
			const list = state.categories.get(link.logwellId);
			if (list !== undefined) out.push({ listId: list.id, name: list.name, link });
		}
		return out.sort((a, b) => compareSortKeys(state.categories.get(a.listId)!.sortKey, state.categories.get(b.listId)!.sortKey));
	}

	// -- one sync ------------------------------------------------------------------------------------------------

	/**
	 * A list link written with the Inbox's real id (`inbox<digits>`, by an early build) is the same project as `inbox`:
	 * the links of that list are rewritten to the alias, in a links command that is not undoable.
	 */
	private async healInboxLinks(): Promise<void> {
		const links = this.store.state.syncLinks;
		let stale = false;
		for (const l of links.values()) if (l.kind === "list" && l.ttId !== canonicalProjectId(l.ttId)) stale = true;
		if (!stale) return;
		await this.store.run(
			TICKTICK_LINKS_LABEL,
			(tx) => {
				for (const l of tx.all("syncLinks")) {
					const ttId = l.kind === "list" ? canonicalProjectId(l.ttId) : l.ttId;
					const ttProjectId = l.ttProjectId === null ? null : canonicalProjectId(l.ttProjectId);
					if (ttId !== l.ttId || ttProjectId !== l.ttProjectId) tx.put("syncLinks", { ...l, ttId, ttProjectId, modifiedAt: tx.now });
				}
			},
			{ undoable: false },
		);
	}

	/**
	 * Adds the tasks of `projectId` completed in `[fromMs, toMs]` (whole seconds) to `found`, by id. TickTick answers
	 * at most TICKTICK_COMPLETED_MAX per read, so a full answer may be cut: its window is read again in two halves
	 * (TickTick sync rule 23). Only full reads count against `budget`; a split adds its two reads to `spent.requests`
	 * before making them, and is not made past PULL_REQUESTS_MAX (the caller counts the first read). True when an
	 * answer stayed cut (a full window too short to split, no splits left, or no requests left): `found` then holds
	 * what was read, and may lack completions.
	 */
	private async completedIn(
		projectId: string,
		fromMs: number,
		toMs: number,
		budget: { splits: number },
		spent: { requests: number },
		found: Map<string, TtTask>,
	): Promise<boolean> {
		const tasks = await this.api.listCompleted({ projectIds: [projectId], startDate: ttStamp(fromMs), endDate: ttStamp(toMs) });
		for (const t of tasks) if (!found.has(t.id)) found.set(t.id, t);
		if (tasks.length < TICKTICK_COMPLETED_MAX) return false;
		if (toMs - fromMs <= 2 * COMPLETED_WINDOW_MIN_MS || budget.splits >= COMPLETED_READS_MAX || spent.requests + 2 > PULL_REQUESTS_MAX) return true;
		budget.splits++;
		spent.requests += 2;
		const mid = fromMs + wholeSecond((toMs - fromMs) / 2);
		const left = await this.completedIn(projectId, fromMs, mid + COMPLETED_WINDOW_MIN_MS, budget, spent, found);
		const right = await this.completedIn(projectId, mid, toMs, budget, spent, found);
		return left || right;
	}

	private async runSync(): Promise<SyncResult> {
		await this.marking;
		if (this.unmarked.size > 0) await this.markRemoved([...this.unmarked]);
		await this.healInboxLinks();
		const startedAt: Instant = this.store.now();
		/** The state when the sync started: unchanged at the end means the sync wrote nothing. */
		const stateAtStart = this.store.state;
		const lists = this.linkedLists(this.store.state);

		// 1. Pull every linked list. A project that fails to load stops the sync before anything is written.
		const pulls: ListPull[] = [];
		const seen = new Map<string, TtTask>();
		/** Some list's completed tasks may lack some: a cut answer that could not be narrowed (TickTick sync rule 23). */
		let anyCut = false;
		/**
		 * Requests made by the pull so far: project data and completed reads. Every list gets its project data and its
		 * first completed read even past PULL_REQUESTS_MAX, so a list is never skipped; only splits stop there.
		 */
		const spent = { requests: 0 };
		for (const l of lists) {
			const projectId = canonicalProjectId(l.link.ttId);
			try {
				const data = await this.api.getProjectData(projectId);
				spent.requests++;
				let completed: TtTask[] = [];
				const budget = { splits: 0 };
				let thisCut = false;
				if (l.link.lastPulledAt !== null) {
					const from = Date.parse(l.link.lastPulledAt) - COMPLETED_OVERLAP_MS;
					const to = Date.parse(this.store.now()) + COMPLETED_OVERLAP_MS;
					const found = new Map<string, TtTask>();
					spent.requests++;
					thisCut = await this.completedIn(projectId, wholeSecond(from), wholeSecond(to), budget, spent, found);
					anyCut ||= thisCut;
					completed = [...found.values()];
				}
				pulls.push({ ...l, projectId, data, splitCompleted: budget.splits > 0 || thisCut });
				for (const t of completed) if (!seen.has(t.id)) seen.set(t.id, t);
				// The open tasks are read first and win: a task reopened after its completion is open.
				for (const t of data.tasks) seen.set(t.id, t);
			} catch (err) {
				return failed(failureOf(err, l));
			}
		}
		const listOfProject = new Map(pulls.map((p) => [p.projectId, p]));

		// 2. Linked tasks expected open but not seen: one lookup each. Completed or won't do there is completed here;
		// not found, or open but missing from the project, is missing. At most LOOKUP_MAX in all, and none past
		// PULL_REQUESTS_MAX requests; the rest wait for the next sync and are never offered for Trash (TickTick sync
		// rule 10).
		/** TickTick ids confirmed gone: looked up this sync or an earlier one. */
		const missing = new Set<string>();
		/** Lists with linked tasks left for the next sync (beyond the lookups of this one). */
		const waiting = new Set<ID>();
		let lookupsLeft = Math.min(LOOKUP_MAX, Math.max(0, PULL_REQUESTS_MAX - spent.requests));
		/** Every lookup this sync made: the task, or null when TickTick did not find it. */
		const lookedUp = new Map<string, TtTask | null>();
		// A cut answer may hide a completion of a task an earlier sync found gone (it came back and was completed in
		// the burst): no earlier verdict is kept or used (TickTick sync rule 23).
		if (anyCut) this.goneInTickTick.clear();
		{
			const state = this.store.state;
			const names = tagNamesOf(state.tags);
			for (const link of state.syncLinks.values()) {
				if (link.kind !== "task" || link.pendingDelete === true || link.mode === "localOnly" || seen.has(link.ttId) || link.ttProjectId === null) continue;
				const pull = listOfProject.get(link.ttProjectId);
				if (pull === undefined) continue;
				const t = state.tasks.get(link.logwellId);
				if (t === undefined || t.recurrence !== null) continue;
				// An excluded link whose task no longer repeats resumes: it needs TickTick's current state.
				const expectedOpen = link.base.status === OPEN_HASH;
				if (link.mode !== "excluded" && !expectedOpen && sameBase(lwHashes(t, names), link.base)) continue;
				// Confirmed gone by an earlier sync and still undecided: not looked up again, so the lookups reach the
				// tasks not checked yet. One that came back is in the pull and never gets here.
				if (this.goneInTickTick.has(link.ttId)) {
					missing.add(link.ttId);
					continue;
				}
				// Its own project first. Not found there means not under it (a deleted task still reads), so the other
				// linked projects are asked: it may have moved. Each call counts against the lookups.
				const projects = [link.ttProjectId, ...pulls.map((p) => p.projectId).filter((id) => id !== link.ttProjectId)];
				let verdict: "gone" | "found" | "waiting" = "gone";
				for (const projectId of projects) {
					if (lookupsLeft <= 0) {
						verdict = "waiting";
						break;
					}
					lookupsLeft--;
					try {
						const tt = await this.api.getTask(projectId, link.ttId);
						lookedUp.set(link.ttId, tt);
						// Completed or won't do; or open under another linked project: moved there after its pull.
						verdict = statusFromTt(tt.status) === "completed" || projectId !== link.ttProjectId ? "found" : "gone";
						if (verdict === "found") seen.set(tt.id, tt);
						break;
					} catch (err) {
						if (!isNotFound(err)) return failed(failureOf(err, pull));
					}
				}
				if (verdict === "waiting") {
					waiting.add(pull.listId);
					continue;
				}
				if (verdict === "gone") {
					if (!lookedUp.has(link.ttId)) lookedUp.set(link.ttId, null);
					missing.add(link.ttId);
					// Kept at once: a sync that stops later (a rate limit) does not look it up again.
					if (!anyCut) this.goneInTickTick.add(link.ttId);
				}
			}
			// The confirmed verdicts carry to the next sync while their tasks stay missing and undecided.
			if (!anyCut) this.goneInTickTick = new Set(missing);
			// Creates that TickTick answered but whose link was not written: their copy is looked up by its id when
			// the pull did not see it (completed outside the window). Gone there, the entry is dropped and the
			// Logwell task goes up again as new.
			for (const [listId, pending] of this.pendingCreates) {
				const pull = pulls.find((p) => p.listId === listId);
				if (pull === undefined) continue;
				for (const [logwellId, answer] of pending) {
					if (answer === null || seen.has(answer.ttId)) continue;
					const ttId = answer.ttId;
					try {
						const tt = await this.api.getTask(pull.projectId, ttId);
						lookedUp.set(ttId, tt);
						if (statusFromTt(tt.status) === "completed") seen.set(tt.id, tt);
						else pending.delete(logwellId);
					} catch (err) {
						if (isNotFound(err)) pending.delete(logwellId);
						else return failed(failureOf(err, pull));
					}
				}
			}
		}
		// A cut completed answer may lack completions, which would read as gone: no Trash verdict this sync, in any list.
		// Everything else is applied and the window moves on; a hidden completion is found by a lookup at a later sync,
		// and the verdicts come back once the window no longer covers the cut (TickTick sync rule 23).
		if (anyCut) missing.clear();

		// A tag name Logwell does not know, on a task the pull reads: TickTick's tags are read once, for its label
		// and parent.
		const remoteTags = new RemoteTags(this.api);
		if (this.needsRemoteTags(seen)) {
			try {
				await remoteTags.load();
			} catch (err) {
				return failed(failureOf(err, null));
			}
		}

		// Stopped while pulling: nothing pulled is written (the session is closing).
		if (this.stopped) return failed(stoppedFailure());

		// 3. The content command: everything pulled, one write.
		const plan = await this.store.run(TICKTICK_SYNC_LABEL, (tx) => this.applyPull(tx, pulls, seen, missing, waiting, listOfProject, remoteTags.known), {
			undoable: false,
		});
		const result: SyncResult = {
			ok: true,
			error: null,
			failures: [],
			content: { wrote: plan.wrote, label: TICKTICK_SYNC_LABEL },
			pulled: plan.written,
			pushed: 0,
			needsConfirmation: plan.needsConfirmation,
			warnings: [],
		};

		// 4. What the pull settled is linked before any push: the sections and tasks it brought in, and every pulled
		// pair at TickTick's state now (its etag, and TickTick's values as the base). A push that fails, or a reload
		// meanwhile, then never imports them twice, and a retry only sends Logwell's side: no second conflict copy.
		const pulledLinks: LinkDraft[] = [...plan.newLinks];
		for (const pair of plan.pairs) {
			pulledLinks.push({ kind: "task", logwellId: pair.logwellId, ttId: pair.ttId, ttProjectId: pair.ttProjectId, etag: pair.etag, base: pair.ttHashes });
		}
		if (pulledLinks.length > 0) {
			await this.store.run(
				TICKTICK_LINKS_LABEL,
				(tx) => {
					const ctx = draftContext(tx);
					for (const d of pulledLinks) putDraft(tx, d, ctx);
				},
				{ undoable: false },
			);
		}

		// 4b. Description notes, between the pull and the push (vault I/O, outside any command).
		let notePushes: NotePush[] = [];
		if (this.notes !== null && !this.stopped) {
			let warned = false;
			notePushes = await this.notes.run(plan.pairs, seen, new Set(pulls.map((p) => p.listId)), () => this.stopped, () => {
				if (!warned) result.warnings.push(TICKTICK_NOTE_WARNING);
				warned = true;
			});
		}

		// 5. Push, 6. bookkeeping (always, with what TickTick confirmed).
		const drafts = new Map<string, LinkDraft>();
		const removeLinks = new Set(plan.removeLinks);
		try {
			await this.push(plan, pulls, listOfProject, seen, lookedUp, drafts, removeLinks, result, remoteTags, notePushes);
		} catch (err) {
			if (!(err instanceof PushStop)) throw err;
			result.ok = false;
			result.error ??= err.failure;
			result.failures.push(err.failure);
		}
		if (remoteTags.unread) result.warnings.push(TICKTICK_TAGS_UNREAD_WARNING);
		await this.writeLinks(drafts, removeLinks, plan.exclude, pulls, startedAt, stateAtStart);
		return result;
	}

	// -- the pull ------------------------------------------------------------------------------------------------

	private applyPull(
		tx: Tx,
		pulls: ListPull[],
		seen: Map<string, TtTask>,
		missing: ReadonlySet<string>,
		waiting: ReadonlySet<ID>,
		listOfProject: Map<string, ListPull>,
		remoteTags: ReadonlyMap<string, TtTag> | null,
	): PullPlan {
		const zone = this.settings.zone();
		const tags = pullTags(tx, remoteTags);
		const plan: PullPlan = { pairs: [], deletes: [], removeLinks: new Set(), newLinks: [], exclude: new Set(), needsConfirmation: [], written: 0, wrote: false };
		const linkByTt = new Map<string, SyncLink>();
		const sectionByColumn = new Map<string, ID | null>();
		const sectionLinkByColumn = new Map<string, SyncLink>();
		const linkedSections = new Set<ID>();
		for (const l of tx.all("syncLinks")) {
			if (l.kind === "task") linkByTt.set(l.ttId, l);
			else if (l.kind === "section") {
				sectionLinkByColumn.set(l.ttId, l);
				linkedSections.add(l.logwellId);
			}
		}

		// Sections: a column is its linked section, else the unlinked section of that name, else a new section.
		for (const p of pulls) {
			for (const col of p.data.columns) {
				if (col.name === NOT_SECTIONED) {
					sectionByColumn.set(col.id, null);
					continue;
				}
				const linked = sectionLinkByColumn.get(col.id);
				if (linked !== undefined) {
					// A linked section that has not arrived stays unresolved.
					if (tx.get("sections", linked.logwellId) !== undefined) sectionByColumn.set(col.id, linked.logwellId);
					continue;
				}
				const key = categoryNameKey(col.name);
				let section = tx.all("sections").find((s) => s.categoryId === p.listId && s.nameKey === key && !linkedSections.has(s.id));
				if (section === undefined) {
					try {
						section = this.sections.createIn(tx, p.listId, col.name);
						plan.written++;
					} catch (err) {
						if (!isDomainError(err)) throw err;
						continue;
					}
				}
				linkedSections.add(section.id);
				sectionByColumn.set(col.id, section.id);
				plan.newLinks.push({ kind: "section", logwellId: section.id, ttId: col.id, ttProjectId: p.projectId, etag: null, base: {} });
			}
		}

		const imported = new Map<string, ID>();
		/** A TickTick parent as a Logwell id; undefined when it cannot be resolved. */
		const parentOf = (tt: TtTask): ID | null | undefined => {
			if (tt.parentId === undefined || tt.parentId === "") return null;
			return linkByTt.get(tt.parentId)?.logwellId ?? imported.get(tt.parentId);
		};
		const sectionOf = (tt: TtTask): ID | null | undefined => {
			if (tt.parentId !== undefined && tt.parentId !== "") return null;
			if (tt.columnId === undefined || tt.columnId === "") return null;
			return sectionByColumn.has(tt.columnId) ? sectionByColumn.get(tt.columnId)! : undefined;
		};
		const ttHashes = (tt: TtTask, fallback: Record<string, string>): Record<string, string> => {
			const parent = parentOf(tt);
			const section = sectionOf(tt);
			const h = fieldHashes({
				title: ttTitle(tt.title),
				status: statusFromTt(tt.status),
				priority: priorityFromTt(tt.priority),
				date: dateFromTt(tt, zone),
				parent: parent ?? null,
				section: section ?? null,
				tags: ttLeaves(tt, tags.names),
			});
			if (parent === undefined && fallback.parent !== undefined) h.parent = fallback.parent;
			if (section === undefined && fallback.section !== undefined) h.section = fallback.section;
			return h;
		};
		const keys = new SortKeys(tx, this.index);

		// Creates that TickTick answered but whose link was not written (the store turned read-only): linked now by
		// TickTick's id, whatever the copy's status, with Logwell's values as the base, so a change made there since
		// (a completion) is pulled like any other.
		const answered = new Set<string>();
		for (const pending of this.pendingCreates.values()) {
			for (const [logwellId, answer] of pending) {
				if (answer === null) continue;
				const tt = seen.get(answer.ttId);
				if (tt === undefined) continue;
				pending.delete(logwellId);
				const ttId = answer.ttId;
				if (tx.get("syncLinks", syncLinkId("task", logwellId)) !== undefined || linkByTt.has(ttId) || !listOfProject.has(tt.projectId)) continue;
				// Never imported again, whatever happened to the Logwell task.
				answered.add(ttId);
				const t = tx.get("tasks", logwellId);
				if (t === undefined || t.recurrence !== null) {
					// In Trash, gone or now repeating: linked as it was sent, so the usual rules apply from the next sync
					// (in Trash or gone: deleted through the delete guard; repeating: excluded).
					plan.newLinks.push({ kind: "task", logwellId, ttId, ttProjectId: tt.projectId, etag: tt.etag ?? null, base: answer.base });
					continue;
				}
				const prior: SyncLink = { kind: "task", logwellId, ttId, ttProjectId: tt.projectId, etag: null, base: answer.base, noteBySync: false, lastPulledAt: null, modifiedAt: tx.now };
				const theirs = ttHashes(tt, prior.base);
				plan.written += this.merge(tx, t, tt, prior, theirs, listOfProject, parentOf, sectionOf, zone, tags);
				plan.pairs.push({ logwellId, ttId, ttProjectId: tt.projectId, etag: tt.etag ?? null, ttHashes: theirs });
				imported.set(ttId, logwellId);
			}
		}


		// New TickTick tasks: open, syncable, not linked. Parents first, so subtasks find them.
		const fresh: { tt: TtTask; pull: ListPull }[] = [];
		for (const p of pulls) {
			for (const tt of p.data.tasks) {
				if (linkByTt.has(tt.id) || answered.has(tt.id) || statusFromTt(tt.status) !== "open" || !isSyncable(tt)) continue;
				fresh.push({ tt, pull: p });
			}
		}
		fresh.sort((a, b) => (a.tt.parentId ? 1 : 0) - (b.tt.parentId ? 1 : 0));
		for (const { tt, pull } of fresh) {
			const pending = this.pendingCreates.get(pull.listId);
			const match = pending === undefined ? undefined : this.matchPending(tx, pending, pull.listId, ttTitle(tt.title));
			if (match !== undefined) {
				pending!.delete(match.id);
				imported.set(tt.id, match.id);
				plan.pairs.push({ logwellId: match.id, ttId: tt.id, ttProjectId: tt.projectId, etag: tt.etag ?? null, ttHashes: ttHashes(tt, lwHashes(match, tags.names)) });
				continue;
			}
			let parentId = parentOf(tt) ?? null;
			const parent = parentId === null ? undefined : tx.get("tasks", parentId);
			if (parent === undefined || parent.parentId !== null || parent.recurrence !== null) parentId = null;
			const sectionId = parentId === null ? (sectionOf(tt) ?? null) : null;
			const categoryId = parentId === null ? pull.listId : parent!.categoryId;
			const { task } = this.tasks.createIn(
				tx,
				taskInputFromTt(tx, tt, zone, tags, ttTitle(tt.title), categoryId, parentId, sectionId),
				keys.next(categoryId, parentId),
			);
			imported.set(tt.id, task.id);
			plan.written++;
			plan.pairs.push({ logwellId: task.id, ttId: tt.id, ttProjectId: tt.projectId, etag: tt.etag ?? null, ttHashes: ttHashes(tt, lwHashes(task, tags.names)) });
		}
		// Title matches are for this sync only; an answered create waits until its copy is seen (looked up above).
		for (const pending of this.pendingCreates.values()) {
			for (const [logwellId, answer] of pending) if (answer === null) pending.delete(logwellId);
		}

		// Linked tasks, parents first so a moved parent takes its subtasks along.
		const trashed = trashedIds(tx);
		const links = tx.all("syncLinks").filter((l) => l.kind === "task");
		const isSub = (l: SyncLink) => (tx.get("tasks", l.logwellId)?.parentId ?? null) !== null;
		links.sort((a, b) => (isSub(a) ? 1 : 0) - (isSub(b) ? 1 : 0));
		const missingByList = new Map<ID, Task[]>();
		/** A synced task that leaves: its TickTick copy is deleted, unless that copy now repeats (only the link goes). */
		const leave = (link: SyncLink, id: string): void => {
			const copy = seen.get(link.ttId);
			if (copy !== undefined && !isSyncable(copy)) plan.removeLinks.add(id);
			else plan.deletes.push(link);
		};
		for (const link of links) {
			const home = link.ttProjectId === null ? undefined : listOfProject.get(link.ttProjectId);
			if (home === undefined) continue;
			const id = syncLinkId("task", link.logwellId);
			if (link.mode === "localOnly") {
				// Kept in Logwell only (Keep): never pushed, deleted, pulled or imported again; the link keeps
				// TickTick's id so that copy is never imported. Once the task is gone for good only the link goes.
				if (link.pendingDelete === true) plan.removeLinks.add(id);
				continue;
			}
			if (link.mode === "excluded") {
				// Excluded (it repeats on one side). In Trash, trashed or moved out: nothing changes, and the TickTick copy is never
				// deleted while the Logwell task may come back. Once it is gone for good (`pendingDelete`: purged, or
				// removed by an undo), a repeating TickTick copy only loses the link (it is never imported); a plain
				// one is deleted there like any task deleted in Logwell. One that was not seen only loses the link.
				const t = tx.get("tasks", link.logwellId);
				if (t === undefined) {
					if (link.pendingDelete === true) {
						const copy = seen.get(link.ttId);
						if (copy !== undefined && isSyncable(copy)) plan.deletes.push(link);
						else plan.removeLinks.add(id);
					}
					continue;
				}
				if (t.recurrence !== null || !listOfProject.has(this.projectOfList(tx, t.categoryId) ?? "")) continue;
				// The Logwell task no longer repeats. While TickTick's copy repeats it stays excluded; once both are
				// plain the sync resumes with Logwell's values as the new base (pushed, never pulled). A copy that is
				// gone in TickTick only loses its link: the Logwell task then goes up as new.
				const tt = seen.get(link.ttId);
				if (tt === undefined) {
					if (missing.has(link.ttId)) plan.removeLinks.add(id);
				} else if (isSyncable(tt)) {
					plan.pairs.push({ logwellId: t.id, ttId: tt.id, ttProjectId: tt.projectId, etag: tt.etag ?? null, ttHashes: ttHashes(tt, lwHashes(t, tags.names)) });
				}
				continue;
			}
			if (link.pendingDelete === true) {
				// Purged from Trash before a sync saw it: deleted in TickTick now.
				leave(link, id);
				continue;
			}
			const t = tx.get("tasks", link.logwellId);
			if (t === undefined) {
				// Deleted in Logwell: deleted in TickTick. A task that is neither here nor in Trash (nor purged, see
				// `pendingDelete`) has not arrived.
				if (trashed.has(link.logwellId)) leave(link, id);
				continue;
			}
			if (t.recurrence !== null) {
				// A synced task that became repeating is excluded; its TickTick copy stays as it is and is
				// never imported again.
				plan.exclude.add(id);
				continue;
			}
			if (!listOfProject.has(this.projectOfList(tx, t.categoryId) ?? "")) {
				// Moved to a list that is not linked: it leaves TickTick.
				leave(link, id);
				continue;
			}
			const tt = seen.get(link.ttId);
			if (tt === undefined) {
				// Only a task TickTick confirmed gone; one not looked up yet waits for the next sync.
				if (missing.has(link.ttId)) {
					const group = missingByList.get(home.listId) ?? [];
					group.push(t);
					missingByList.set(home.listId, group);
				}
				continue;
			}
			if (!isSyncable(tt)) {
				// Made repeating in TickTick: excluded, both copies stay.
				plan.exclude.add(id);
				continue;
			}
			const ttChanged = tt.etag === undefined || tt.etag !== link.etag || tt.projectId !== link.ttProjectId;
			const theirs = ttChanged ? ttHashes(tt, link.base) : link.base;
			plan.written += this.merge(tx, t, tt, link, theirs, listOfProject, parentOf, sectionOf, zone, tags);
			plan.pairs.push({ logwellId: t.id, ttId: tt.id, ttProjectId: tt.projectId, etag: tt.etag ?? null, ttHashes: theirs });
		}

		// Missing from TickTick. Fewer than 5 in a list go to Trash; 5 or more, or a project that came back
		// empty, wait for confirmation and nothing is applied. While a list has tasks still to look up, fewer than 5
		// wait (kept as found gone) so they are judged with the rest, never moved a few at a time; an emptied list asks
		// nothing yet, as Keep would unlink it while some of them may be completed there (TickTick sync rule 10).
		for (const [listId, group] of missingByList) {
			const pull = pulls.find((p) => p.listId === listId)!;
			const emptied = pull.data.tasks.length === 0;
			if (waiting.has(listId) && (emptied || group.length < MISSING_CONFIRM_MIN)) continue;
			if (emptied || group.length >= MISSING_CONFIRM_MIN) {
				plan.needsConfirmation.push({ listId, reason: emptied ? "emptied" : "many", tasks: group.map((t) => ({ id: t.id, title: t.title })) });
				continue;
			}
			for (const t of group) {
				if (tx.get("tasks", t.id) !== undefined) {
					this.tasks.deleteIn(tx, t.id);
					plan.written++;
				}
				plan.removeLinks.add(syncLinkId("task", t.id));
			}
		}
		// `finish` is pure: whether this command writes anything, for the result and its Undo notice.
		plan.wrote = tx.finish().ops.length > 0;
		return plan;
	}

	/** An unlinked, open Logwell task of the list whose create may have reached TickTick, by title. */
	private matchPending(tx: Tx, pending: Map<ID, AnsweredCreate | null>, listId: ID, title: string): Task | undefined {
		const usable = (id: ID): Task | undefined => {
			const t = tx.get("tasks", id);
			if (t === undefined || t.categoryId !== listId) return undefined;
			return tx.get("syncLinks", syncLinkId("task", id)) === undefined ? t : undefined;
		};
		// Only creates whose answer was lost; an answered one is paired by its id before the imports.
		for (const [id, known] of pending) {
			if (known !== null) continue;
			const t = usable(id);
			if (t !== undefined && t.title === title) return t;
		}
		return undefined;
	}

	/**
	 * The merge of one linked task: a field TickTick changed and Logwell did not is pulled. Changed on both sides to
	 * different values, Logwell's stays and TickTick's version becomes a copy (one per task per sync). Returns the
	 * number of Logwell writes.
	 */
	private merge(
		tx: Tx,
		t: Task,
		tt: TtTask,
		link: SyncLink,
		theirs: Record<string, string>,
		listOfProject: Map<string, ListPull>,
		parentOf: (tt: TtTask) => ID | null | undefined,
		sectionOf: (tt: TtTask) => ID | null | undefined,
		zone: string,
		tags: PullTags,
	): number {
		const ours = lwHashes(t, tags.names);
		const pull = new Set<Field>();
		let conflict = false;
		for (const f of FIELDS) {
			const base = link.base[f];
			if (theirs[f] === base) continue;
			if (ours[f] === base) pull.add(f);
			else if (ours[f] !== theirs[f]) conflict = true;
		}
		const homeList = listOfProject.get(link.ttProjectId ?? "")!.listId;
		const ttList = listOfProject.get(tt.projectId)?.listId ?? homeList;
		const pullList = ttList !== homeList && t.categoryId === homeList && t.parentId === null;
		let written = 0;
		const attempt = (write: () => void): void => {
			try {
				write();
				written++;
			} catch (err) {
				// A pulled value Logwell's rules refuse stays Logwell's; the push sends it back up.
				if (!isDomainError(err)) throw err;
			}
		};

		const patch: TaskPatch = {};
		if (pullList) patch.categoryId = ttList;
		if (pull.has("title")) patch.title = ttTitle(tt.title);
		if (pull.has("priority")) patch.priority = priorityFromTt(tt.priority);
		if (pull.has("date")) Object.assign(patch, pulledDatePatch(t, dateFromTt(tt, zone)));
		if (pull.has("section") && t.parentId === null) {
			const section = sectionOf(tt);
			if (section !== undefined) patch.sectionId = section;
		}
		if (pull.has("tags")) {
			const pulled = tags.keysOf(tt);
			// A tag that does not sync stays.
			const keep = t.tagKeys.filter((k) => !isSyncedTag(tags.names, k) || pulled.includes(k));
			const next = [...keep, ...pulled.filter((k) => !keep.includes(k))];
			if (next.length !== t.tagKeys.length || next.some((k, i) => k !== t.tagKeys[i])) patch.tagKeys = next;
		}
		if (Object.keys(patch).length > 0) {
			attempt(() => {
				if (!this.tasks.updateIn(tx, t.id, patch).changed) written--;
			});
		}
		if (pull.has("parent")) {
			const parent = parentOf(tt);
			if (parent !== undefined) attempt(() => this.tasks.setParentIn(tx, t.id, parent));
		}
		if (pull.has("status")) {
			attempt(() => (statusFromTt(tt.status) === "completed" ? this.tasks.completeOneIn(tx, t.id) : this.tasks.reopenIn(tx, t.id)));
		}
		if (conflict) {
			const now = tx.get("tasks", t.id) ?? t;
			const section = sectionOf(tt);
			attempt(() => this.tasks.createIn(tx, taskInputFromTt(tx, tt, zone, tags, `${ttTitle(tt.title)} (TickTick)`, now.categoryId, null, section ?? null)));
		}
		return written;
	}

	private projectOfList(tx: Tx, listId: ID): string | undefined {
		const id = tx.get("syncLinks", syncLinkId("list", listId))?.ttId;
		return id === undefined ? undefined : canonicalProjectId(id);
	}

	// -- the push ------------------------------------------------------------------------------------------------

	private async push(
		plan: PullPlan,
		pulls: ListPull[],
		listOfProject: Map<string, ListPull>,
		seen: ReadonlyMap<string, TtTask>,
		lookedUp: ReadonlyMap<string, TtTask | null>,
		drafts: Map<string, LinkDraft>,
		removeLinks: Set<string>,
		result: SyncResult,
		remoteTags: RemoteTags,
		notePushes: readonly NotePush[],
	): Promise<void> {
		const zone = this.settings.zone();
		const state = this.store.state;
		const names = tagNamesOf(state.tags);
		const lw = (t: Task): Record<string, string> => lwHashes(t, names);
		const pullOfList = new Map(pulls.map((p) => [p.listId, p]));
		const ttIdOfTask = (id: ID): string | undefined => {
			const d = drafts.get(syncLinkId("task", id));
			return d !== undefined ? d.ttId : state.syncLinks.get(syncLinkId("task", id))?.ttId;
		};
		const pairOf = new Map(plan.pairs.map((p) => [p.logwellId, p]));
		const ttParentOf = (t: Task): string | undefined => (t.parentId === null ? undefined : (ttIdOfTask(t.parentId) ?? pairOf.get(t.parentId)?.ttId));
		const columnFor = async (sectionId: ID | null, pull: ListPull): Promise<string> => {
			if (sectionId === null) return pull.data.columns.find((c) => c.name === NOT_SECTIONED)?.id ?? "";
			const key = syncLinkId("section", sectionId);
			const known = drafts.get(key) ?? state.syncLinks.get(key);
			if (known !== undefined && known.ttProjectId === pull.projectId) return known.ttId;
			const section = state.sections.get(sectionId);
			if (section === undefined) return "";
			const col: TtColumn = await this.call(pull, () => this.api.createColumn(pull.projectId, section.name));
			result.pushed++;
			drafts.set(key, { kind: "section", logwellId: sectionId, ttId: col.id, ttProjectId: pull.projectId, etag: null, base: {} });
			return col.id;
		};
		/**
		 * TickTick holds a tag record for each synced tag of the task: the missing ones are created, parent first
		 * (TickTick's tags are read once per sync). A name TickTick has, under any parent, is used as it is.
		 */
		const ensureTags = async (t: Task, pull: ListPull): Promise<void> => {
			const synced = t.tagKeys.filter((key) => isSyncedTag(names, key));
			// A change that only removes tags needs no record.
			if (synced.length === 0) return;
			let remote: Map<string, TtTag>;
			try {
				remote = await this.call(pull, () => remoteTags.load());
			} catch (err) {
				if (err instanceof PushStop) throw new PushStop(err.failure, false, false, true);
				throw err;
			}
			const create = async (name: string, label: string, parent: string | undefined): Promise<void> => {
				if (remote.has(name)) return;
				// TickTick nests one level: a parent that has a parent there is left out.
				const under = parent !== undefined && remote.get(parent)?.parent === undefined ? parent : undefined;
				const tag: TtTag = { name, label, ...(under === undefined ? {} : { parent: under }) };
				await this.call(pull, () => this.api.createTag(tag));
				result.pushed++;
				remote.set(name, tag);
			};
			for (const key of synced) {
				const path = tagPath(key);
				const name = path[path.length - 1]!;
				// A name TickTick has, under any parent, is used as it is: no parent record is made for it.
				if (remote.has(name)) continue;
				const shown = tagDisplayPath(state.tags, key).split("/");
				const labels = shown.length === path.length ? shown : path;
				if (path.length === 2) await create(path[0]!, labels[0]!, undefined);
				await create(name, labels[labels.length - 1]!, path.length === 2 ? path[0] : undefined);
			}
		};
		/** The names to send: the synced tags' names, and the TickTick ones Logwell cannot hold (kept there). */
		const tagsOf = (t: Task, copy: TtTask | null | undefined): string[] => {
			const kept = (copy?.tags ?? []).filter((raw) => pullableTagName(names, raw) === null);
			return [...syncedTagLeaves(names, t.tagKeys), ...kept];
		};
		const fieldsOf = async (t: Task, fields: Iterable<Field>, pull: ListPull, copy?: TtTask | null): Promise<TtTaskWrite> => {
			const w: TtTaskWrite = {};
			for (const f of fields) {
				if (f === "tags") {
					await ensureTags(t, pull);
					w.tags = tagsOf(t, copy);
				} else if (f === "title") w.title = t.title;
				else if (f === "status") w.status = statusToTt(t.status);
				else if (f === "priority") w.priority = priorityToTt(t.priority);
				else if (f === "date") {
					const spec = syncDateOf(t);
					// No date: both cleared with null (TickTick ignores an empty string).
					Object.assign(w, spec === null ? { startDate: null, dueDate: null } : dateToTt(spec, zone));
				} else if (f === "parent") {
					const parent = t.parentId === null ? "" : ttParentOf(t);
					if (parent !== undefined) w.parentId = parent;
				} else if (t.parentId === null) w.columnId = await columnFor(t.sectionId, pull);
			}
			return w;
		};

		// TickTick's per-list limit counts open tasks, so the push runs from what frees room to what uses it: deletes,
		// completions, moves, plain field updates, reopens, then creates. Each list stops on its own: a write TickTick
		// refuses stops that list's later steps, and the other lists go on. A move counts against the list it goes
		// to. An error that concerns every list (token, rate limit, network) stops the whole push.
		const stopped = new Map<ID, SyncFailure>();
		const open = new Map(pulls.map((p) => [p.listId, p.data.tasks.length]));
		const openIds = new Set(pulls.flatMap((p) => p.data.tasks.map((t) => t.id)));
		const count = (listId: ID | undefined, delta: number): void => {
			if (listId !== undefined) open.set(listId, (open.get(listId) ?? 0) + delta);
		};
		const guard = async (pull: ListPull, write: () => Promise<void>): Promise<boolean> => {
			if (stopped.has(pull.listId)) return false;
			try {
				await write();
				return true;
			} catch (err) {
				if (!(err instanceof PushStop) || STOPS_ALL.has(err.failure.kind)) throw err;
				// A read never meets the limit; only a write to a full list is reported as it.
				const full = !err.read && err.failure.kind === "server" && (open.get(pull.listId) ?? 0) >= TICKTICK_FREE_OPEN_MAX;
				stopped.set(
					pull.listId,
					full
						? {
								...err.failure,
								kind: "list-limit",
								message: `TickTick: "${pull.name}" has ${TICKTICK_FREE_OPEN_MAX} open tasks, the limit of TickTick's free plan.`,
							}
						: err.failure,
				);
				return false;
			}
		};

		try {
			// 1. Deleted in Logwell, or moved to a list that is not linked: deleted in TickTick without asking.
			for (const link of plan.deletes) {
				const pull = listOfProject.get(link.ttProjectId ?? "")!;
				// RULE: a TickTick task that repeats (or is a note) is never deleted by the sync, whatever queued
				// the delete; its link goes instead. This is the one place every TickTick delete passes through. A copy
				// the pull did not see (completed outside the window) and not looked up yet is read once first. Not
				// found: it is already gone, only the link goes. A lookup that fails deletes nothing: the link stays for
				// the next sync and the list reports the failure.
				const copy = seen.get(link.ttId) ?? lookedUp.get(link.ttId);
				if (copy !== undefined && copy !== null && !isSyncable(copy)) {
					removeLinks.add(syncLinkId("task", link.logwellId));
					continue;
				}
				await guard(pull, async () => {
					let current = copy;
					if (current === undefined) {
						try {
							current = await this.call(pull, () => this.api.getTask(link.ttProjectId!, link.ttId));
						} catch (err) {
							if (!(err instanceof PushStop)) throw err;
							if (!err.notFound) throw new PushStop(err.failure, false, false, true);
							current = null;
						}
					}
					if (current === null || !isSyncable(current)) {
						removeLinks.add(syncLinkId("task", link.logwellId));
						return;
					}
					try {
						await this.call(pull, () => this.api.deleteTask(link.ttProjectId!, link.ttId));
						result.pushed++;
						if (openIds.has(link.ttId)) count(pull.listId, -1);
					} catch (err) {
						if (!(err instanceof PushStop) || err.notFound !== true) throw err;
					}
					removeLinks.add(syncLinkId("task", link.logwellId));
				});
			}

			// Existing pairs: what differs between Logwell now and TickTick now goes up.
			type Update = { pair: Pair; t: Task; update: TtTaskUpdate; pull: ListPull };
			const moves: { pair: Pair; t: Task; move: TtMove; pull: ListPull }[] = [];
			const completions: Update[] = [];
			const plain: Update[] = [];
			const reopens: Update[] = [];
			for (const pair of plan.pairs) {
				const t = state.tasks.get(pair.logwellId);
				if (t === undefined || t.recurrence !== null) {
					drafts.set(syncLinkId("task", pair.logwellId), { kind: "task", logwellId: pair.logwellId, ttId: pair.ttId, ttProjectId: pair.ttProjectId, etag: pair.etag, base: pair.ttHashes });
					continue;
				}
				const pull = pullOfList.get(t.categoryId);
				if (pull === undefined) continue;
				const ours = lw(t);
				const changed = FIELDS.filter((f) => ours[f] !== pair.ttHashes[f]);
				const moved = pull.projectId !== pair.ttProjectId;
				// A value that cannot be sent (a parent not in TickTick) is not sent; the base takes Logwell's.
				let write: TtTaskWrite = {};
				const copy = seen.get(pair.ttId) ?? lookedUp.get(pair.ttId);
				if (changed.length > 0 && !(await guard(pull, async () => void (write = await fieldsOf(t, changed, pull, copy))))) continue;
				if (Object.keys(write).length === 0 && !moved) {
					drafts.set(syncLinkId("task", t.id), { kind: "task", logwellId: t.id, ttId: pair.ttId, ttProjectId: pair.ttProjectId, etag: pair.etag, base: ours });
					continue;
				}
				if (moved) moves.push({ pair, t, pull, move: { fromProjectId: pair.ttProjectId, toProjectId: pull.projectId, taskId: pair.ttId } });
				if (Object.keys(write).length === 0) continue;
				if (write.status !== undefined && write.status !== 0) {
					// Sent before the move, under the project the task is in now: it frees room there.
					const here = listOfProject.get(pair.ttProjectId) ?? pull;
					completions.push({ pair, t, pull: here, update: { id: pair.ttId, projectId: pair.ttProjectId, ...write } });
				} else {
					(write.status === 0 ? reopens : plain).push({ pair, t, pull, update: { id: pair.ttId, projectId: pull.projectId, ...write } });
				}
			}

			const confirmed = (u: Update, etag: string): void => {
				drafts.set(syncLinkId("task", u.t.id), { kind: "task", logwellId: u.t.id, ttId: u.pair.ttId, ttProjectId: u.update.projectId, etag, base: lw(u.t) });
			};
			/** Per list, chunks of 50, each sent through `guard`; a list's first chunk that fails stops its later ones. */
			const forEachBatch = async <T extends { pull: ListPull }>(items: T[], send: (chunk: T[], pull: ListPull) => Promise<void>): Promise<void> => {
				for (const group of byList(items, (x) => x.pull.listId)) {
					const pull = group[0]!.pull;
					for (let i = 0; i < group.length; i += TICKTICK_BATCH_MAX) {
						const chunk = group.slice(i, i + TICKTICK_BATCH_MAX);
						const sent = await guard(pull, () => send(chunk, pull));
						if (!sent) break;
					}
				}
			};
			/** Batched updates; `delta` is what each confirmed write does to the list's open tasks. */
			const sendBatches = (updates: Update[], delta: number): Promise<void> =>
				forEachBatch(updates, async (chunk, pull) => {
					const answer = await this.call(pull, () => this.api.batchTasks({ update: chunk.map((u) => u.update) }));
					let rejected: Update | undefined;
					for (const u of chunk) {
						const etag = answer.id2etag[u.pair.ttId];
						if (etag !== undefined) {
							confirmed(u, etag);
							result.pushed++;
							count(pull.listId, delta);
						} else if (answer.id2error[u.pair.ttId] !== undefined) rejected ??= u;
					}
					if (rejected !== undefined) {
						throw new PushStop({
							listId: pull.listId,
							listName: pull.name,
							kind: "bad-response",
							message: `TickTick refused a change to "${rejected.t.title}".`,
							retryAfterSec: null,
						});
					}
				});

			// 2. Completions, 3. moves, 4. plain updates, 5. reopens.
			await sendBatches(completions, -1);
			await forEachBatch(moves, async (chunk, pull) => {
				const answer = await this.call(pull, () => this.api.moveTasks(chunk.map((m) => m.move)));
				const etags = new Map(answer.map((m) => [m.id, m.etag ?? ""]));
				for (const m of chunk) {
					const etag = etags.get(m.pair.ttId);
					if (etag === undefined) continue;
					const key = syncLinkId("task", m.t.id);
					// Fields not sent yet keep TickTick's values as their base, so a failed update is sent again.
					const base = drafts.get(key)?.base ?? m.pair.ttHashes;
					drafts.set(key, { kind: "task", logwellId: m.t.id, ttId: m.pair.ttId, ttProjectId: m.pull.projectId, etag, base });
					result.pushed++;
					// Counted by TickTick's status: a copy completed there takes no room in either list.
					if (m.pair.ttHashes.status === OPEN_HASH) {
						count(listOfProject.get(m.pair.ttProjectId)?.listId, -1);
						count(pull.listId, 1);
					}
				}
			});
			await sendBatches(plain, 0);
			await sendBatches(reopens, 1);

			// 5b. Description notes the sync created, one update each, after the field updates. TickTick's copy is
			// read again first: its checklist items get new ids on every update (ours included), and a text TickTick
			// changed since the pull is not overwritten (the next sync merges it). Sent only while the link still owns
			// the note, where the task is now; the etag TickTick answers goes in the link.
			for (const np of notePushes) {
				const t = this.store.state.tasks.get(np.logwellId);
				const pair = pairOf.get(np.logwellId);
				const pull = t === undefined ? undefined : pullOfList.get(t.categoryId);
				if (t === undefined || pair === undefined || pull === undefined) continue;
				const key = syncLinkId("task", t.id);
				await guard(pull, async () => {
					if (!ownsNote(this.store, t.id, np.path)) return;
					const projectId = drafts.get(key)?.ttProjectId ?? pair.ttProjectId;
					let fresh: TtTask;
					try {
						fresh = await this.call(pull, () => this.api.getTask(projectId, np.ttId));
					} catch (err) {
						if (!(err instanceof PushStop)) throw err;
						if (err.notFound) return;
						throw new PushStop(err.failure, false, false, true);
					}
					if (isChecklist(fresh) !== np.checklist || !sameDoc(docFromTickTick(fresh), np.pulled)) return;
					if (!ownsNote(this.store, t.id, np.path)) return;
					const answer = await this.call(pull, () => this.api.updateTask({ id: np.ttId, projectId, ...ttNoteWrite(np.doc, np.checklist, fresh.items ?? []) }));
					result.pushed++;
					const note = storedBase(np.doc, np.checklist);
					const d = drafts.get(key);
					drafts.set(
						key,
						d !== undefined
							? { ...d, etag: answer.etag ?? d.etag, note }
							: { kind: "task", logwellId: t.id, ttId: np.ttId, ttProjectId: projectId, etag: answer.etag ?? pair.etag, base: pair.ttHashes, note },
					);
				});
			}

			// 6. New Logwell tasks: open, not repeating, not linked, in a linked list. Parents first.
			const fresh: Task[] = [];
			for (const listId of pullOfList.keys()) {
				for (const t of this.index.tasksOf((id) => state.tasks.get(id), listId)) {
					if (t.status !== "open" || t.recurrence !== null) continue;
					if (pairOf.has(t.id) || state.syncLinks.has(syncLinkId("task", t.id))) continue;
					// Waits to be linked to the copy TickTick already made.
					if (this.pendingCreates.get(listId)?.get(t.id) != null) continue;
					fresh.push(t);
				}
			}
			fresh.sort((a, b) => (a.parentId === null ? 0 : 1) - (b.parentId === null ? 0 : 1));
			for (const t of fresh) {
				const pull = pullOfList.get(t.categoryId)!;
				await guard(pull, async () => {
					// A section of the Inbox needs a column, and a column needs the Inbox's real id, which an empty Inbox shows only
					// in the answer to its first created task: that task is created without the column, which follows.
					const sectionKey = t.sectionId === null || t.parentId !== null ? null : syncLinkId("section", t.sectionId);
					const known = sectionKey === null ? undefined : (drafts.get(sectionKey) ?? state.syncLinks.get(sectionKey));
					const deferColumn = pull.projectId === INBOX_ALIAS && !this.inbox.knowsId && sectionKey !== null && known?.ttProjectId !== pull.projectId;
					const wanted: Field[] = lw(t).tags === EMPTY_TAGS ? ["title", "priority", "date", "section"] : ["title", "priority", "date", "section", "tags"];
					const fields = await fieldsOf(t, deferColumn ? wanted.filter((f) => f !== "section") : wanted, pull);
					const parent = ttParentOf(t);
					const create: TtTaskCreate = { ...fields, projectId: pull.projectId, title: t.title, ...(parent === undefined ? {} : { parentId: parent }) };
					if (syncDateOf(t) === null) {
						delete create.startDate;
						delete create.dueDate;
					}
					if (create.columnId === "") delete create.columnId;
					let made: TtTask;
					try {
						made = await this.call(pull, () => this.api.createTask(create));
					} catch (err) {
						// The answer may be lost although the task was made: the next pull links it by title.
						if (err instanceof PushStop && err.maybePartial) this.remember(pull.listId, t.id, null);
						throw err;
					}
					result.pushed++;
					count(pull.listId, 1);
					// Until its column is set the task counts as not sectioned, so a failed follow-up is sent again.
					const draft: LinkDraft = { kind: "task", logwellId: t.id, ttId: made.id, ttProjectId: pull.projectId, etag: made.etag ?? null, base: deferColumn ? { ...lw(t), section: NO_SECTION_HASH } : lw(t) };
					drafts.set(syncLinkId("task", t.id), draft);
					// Linked at once, in its own command: a reload before the end of the sync cannot lose the new id. If
					// that write fails (the store turned read-only), the next pull links the task by its id instead.
					try {
						await this.store.run(TICKTICK_LINKS_LABEL, (tx) => putDraft(tx, draft, draftContext(tx)), { undoable: false });
					} catch (err) {
						this.remember(pull.listId, t.id, { ttId: made.id, base: draft.base });
						throw err;
					}
					if (deferColumn) {
						const columnId = await columnFor(t.sectionId, pull);
						const set = await this.call(pull, () => this.api.updateTask({ id: made.id, projectId: pull.projectId, columnId }));
						result.pushed++;
						const done: LinkDraft = { ...draft, etag: set.etag ?? null, base: lw(t) };
						drafts.set(syncLinkId("task", t.id), done);
						await this.store.run(TICKTICK_LINKS_LABEL, (tx) => putDraft(tx, done, draftContext(tx)), { undoable: false });
					}
				});
			}

		} finally {
			// Lists that stopped on their own are reported even when a later error stopped the whole push.
			for (const failure of stopped.values()) {
				result.ok = false;
				result.error ??= failure;
				result.failures.push(failure);
			}
		}
	}

	/** One TickTick write. A failure stops the push. */
	private async call<T>(pull: ListPull, write: () => Promise<T>): Promise<T> {
		try {
			return await write();
		} catch (err) {
			if (!(err instanceof TickTickError)) throw err;
			throw new PushStop(failureOf(err, pull), err.kind === "not-found", err.maybePartial);
		}
	}

	// -- bookkeeping ---------------------------------------------------------------------------------------------

	/**
	 * The links, as their own command that is never undoable. A write that changes nothing is skipped.
	 * `lastPulledAt` is written only when something else was written since `stateAtStart` (by this sync or meanwhile;
	 * the file changes anyway), when this command writes other links, when the list's completed tasks needed more
	 * than one read, or when the stored time is missing or an hour old (`LAST_PULLED_REFRESH_MS`). A sync that found nothing to do therefore runs a command that changes nothing,
	 * which writes, records and emits nothing.
	 */
	private async writeLinks(
		drafts: Map<string, LinkDraft>,
		removeLinks: Set<string>,
		exclude: Set<string>,
		pulls: ListPull[],
		pulledAt: Instant,
		stateAtStart: DbData,
	): Promise<void> {
		await this.store.run(
			TICKTICK_LINKS_LABEL,
			(tx) => {
				for (const id of removeLinks) tx.remove("syncLinks", id);
				const ctx = draftContext(tx);
				for (const [id, d] of drafts) if (!removeLinks.has(id)) putDraft(tx, d, ctx);
				for (const id of exclude) {
					const current = tx.get("syncLinks", id);
					// Only a link that syncs becomes excluded; a localOnly one stays as the user chose.
					if (current !== undefined && (current.mode ?? "sync") === "sync") tx.put("syncLinks", { ...current, mode: "excluded", modifiedAt: tx.now });
				}
				const quiet = this.store.state === stateAtStart && tx.finish().ops.length === 0;
				for (const p of pulls) {
					const current = tx.get("syncLinks", syncLinkId("list", p.listId));
					if (current === undefined || current.ttId !== p.projectId) continue;
					const fresh = current.lastPulledAt !== null && Date.parse(pulledAt) - Date.parse(current.lastPulledAt) < LAST_PULLED_REFRESH_MS;
					// A split read moves the window on even when quiet, or each next sync would split it again.
					if (quiet && fresh && !p.splitCompleted) continue;
					tx.put("syncLinks", { ...current, lastPulledAt: pulledAt, modifiedAt: tx.now });
				}
			},
			{ undoable: false },
		);
	}
}

interface DraftContext {
	projects: ReadonlySet<string>;
	/** Read on first need. */
	trashed: Set<ID> | null;
}

function draftContext(tx: Tx): DraftContext {
	return { projects: linkedProjects(tx), trashed: null };
}

/**
 * Writes a link that syncs (its mode left out, so an excluded link syncs again), never over a localOnly one, unless its
 * project is no longer linked (the list was unlinked meanwhile) or it would change nothing. A link marked `pendingDelete` meanwhile (a purge or an undo
 * during the sync) is never overwritten, nor the link of a task that is gone. A new link for a task that is gone
 * and not in Trash is written `pendingDelete`, so the next sync deletes the TickTick copy.
 */
function putDraft(tx: Tx, d: LinkDraft, ctx: DraftContext): void {
	if (!ctx.projects.has(d.ttProjectId ?? "")) return;
	const id = syncLinkId(d.kind, d.logwellId);
	const current = tx.get("syncLinks", id);
	// A task kept in Logwell only never syncs again.
	if (current?.pendingDelete === true || current?.mode === "localOnly") return;
	let gone = false;
	if (d.kind === "task" && tx.get("tasks", d.logwellId) === undefined) {
		if (current !== undefined) return;
		ctx.trashed ??= trashedIds(tx);
		gone = !ctx.trashed.has(d.logwellId);
	}
	// The note fields stay as they are, unless TickTick confirmed a note's new text while the sync still owns
	// the note (the user may have unlinked it meanwhile).
	const { note: confirmed, ...draft } = d;
	const note: StoredNoteBase | null =
		confirmed !== undefined && current?.noteBySync === true
			? confirmed
			: current?.noteBase !== undefined
				? { noteBase: current.noteBase, ...(current.noteItems === undefined ? {} : { noteItems: current.noteItems }) }
				: null;
	if (
		current !== undefined &&
		current.ttId === d.ttId &&
		current.ttProjectId === d.ttProjectId &&
		current.etag === d.etag &&
		sameBase(current.base, d.base) &&
		current.mode === undefined &&
		current.noteBase === note?.noteBase &&
		sameIds(current.noteItems, note?.noteItems)
	) {
		return;
	}
	// `mode` is left out (sync): a draft is a link that syncs.
	tx.put("syncLinks", {
		...draft,
		noteBySync: current?.noteBySync ?? false,
		...(note ?? {}),
		lastPulledAt: null,
		...(gone ? { pendingDelete: true } : {}),
		modifiedAt: tx.now,
	});
}

function sameIds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return sameLines(a, b);
}

/**
 * The tag side of a pull. A TickTick name maps to the Logwell tag that owns it, keeping Logwell's key and
 * casing (an implicit parent gets its record). An unknown name becomes a new tag, named and nested from TickTick's
 * record when there is one (`remote`): its label, and its parent (created too when Logwell lacks it), one level only;
 * a parent whose name a Logwell child tag owns is not nested under.
 */
function pullTags(tx: Tx, remote: ReadonlyMap<string, TtTag> | null): PullTags {
	// The state's names (whose hashes are memoized) until the pull creates a tag; then a copy that takes it in.
	let names = tagNamesOf(tx.base.tags);
	let copied = false;
	const resolved = new Map<string, string | null>();
	const display = (key: string): string => tagDisplayPath(tx.map("tags"), key);
	const ensure = (key: string, displayName: string): void => {
		if (tx.get("tags", key) !== undefined) return;
		tx.put("tags", { key, displayName, color: paletteColor(tx.map("tags").size), createdAt: tx.now, modifiedAt: tx.now });
		if (!copied) {
			names = names.clone();
			copied = true;
		}
		names.add(key, tx.now);
	};
	/** TickTick's label when it spells the name (any casing), else the name. */
	const labelOf = (name: string): string => {
		const label = remote?.get(name)?.label;
		return label !== undefined && normalizeTagKey(label) === name ? label.normalize("NFC").trim() : name;
	};
	const keyFor = (name: string): string | null => {
		const owner = names.owner(name);
		if (owner !== undefined) {
			ensure(owner, display(owner));
			return owner;
		}
		let parentKey: string | null = null;
		const parentRaw = remote?.get(name)?.parent;
		const parentName = parentRaw === undefined ? null : ttTagName(parentRaw);
		if (parentName !== null && parentName !== name) {
			const parentOwner = names.owner(parentName);
			if (parentOwner === undefined) {
				ensure(parentName, labelOf(parentName));
				parentKey = parentName;
			} else if (tagPath(parentOwner).length === 1 && isSyncedTag(names, parentOwner)) {
				ensure(parentOwner, display(parentOwner));
				parentKey = parentOwner;
			}
		}
		const key = parentKey === null ? name : `${parentKey}/${name}`;
		if (names.clash(key) !== null) return null;
		ensure(key, parentKey === null ? labelOf(name) : `${display(parentKey)}/${labelOf(name)}`);
		return key;
	};
	return {
		get names() {
			return names;
		},
		keysOf(tt) {
			const out: string[] = [];
			for (const raw of tt.tags ?? []) {
				const name = pullableTagName(names, raw);
				if (name === null) continue;
				let key = resolved.get(name);
				if (key === undefined) {
					key = keyFor(name);
					resolved.set(name, key);
				}
				if (key !== null && !out.includes(key)) out.push(key);
			}
			return out;
		},
	};
}

function trashedIds(tx: Tx): Set<ID> {
	const out = new Set<ID>();
	for (const e of tx.all("trash")) for (const t of e.tasks) out.add(t.id);
	return out;
}

function linkedProjects(tx: Tx): Set<string> {
	const out = new Set<string>();
	for (const l of tx.all("syncLinks")) if (l.kind === "list") out.add(l.ttId);
	return out;
}

/** Errors that concern every list: the push stops at once. */
const STOPS_ALL: ReadonlySet<SyncFailureKind> = new Set(["unauthorized", "rate-limited", "network"]);

/** Groups items by list, keeping their order. */
function byList<T>(items: readonly T[], listOf: (item: T) => ID): T[][] {
	const groups = new Map<ID, T[]>();
	for (const item of items) {
		const id = listOf(item);
		const g = groups.get(id);
		if (g === undefined) groups.set(id, [item]);
		else g.push(item);
	}
	return [...groups.values()];
}

/** Thrown inside the push to stop it with the failure to report. */
class PushStop extends Error {
	constructor(
		readonly failure: SyncFailure,
		readonly notFound = false,
		readonly maybePartial = false,
		/** The failed call was a read (a lookup), not a write. */
		readonly read = false,
	) {
		super(failure.message);
	}
}

const STOPPED_MESSAGE = "TickTick: sync stopped because the database is closing.";

function stoppedFailure(): SyncFailure {
	return { listId: null, listName: null, kind: "network", message: STOPPED_MESSAGE, retryAfterSec: null };
}

/** The API, but every call fails as a network error, before anything is sent, once `stopped()` is true. */
function stoppable(api: TickTickApi, stopped: () => boolean): TickTickApi {
	return new Proxy(api, {
		get(target, key, receiver) {
			const value: unknown = Reflect.get(target, key, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]): unknown => {
				if (stopped()) return Promise.reject(new TickTickError("network", STOPPED_MESSAGE));
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	});
}

function failed(error: SyncFailure): SyncResult {
	return { ok: false, error, failures: [error], content: { wrote: false, label: TICKTICK_SYNC_LABEL }, pulled: 0, pushed: 0, needsConfirmation: [], warnings: [] };
}

/** A note project cannot be linked. */
function assertTaskProject(data: TtProjectData): void {
	if (data.project.kind === "NOTE") throw new DomainError("InvalidValue", "A TickTick note list cannot be linked.");
}
