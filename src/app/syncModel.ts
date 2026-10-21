import { DomainError } from "../domain/errors";
import { keyBetween } from "../domain/sortKey";
import { childTagPath, normalizeTagKey, tagDisplayPath, TagNames, tagNamesOf, tagPath } from "../domain/tags";
import { isSectionOf, requireTitle } from "../domain/tasks";
import { normalizedText } from "../domain/text";
import { instantOf } from "../domain/time";
import { dateFromTt, fieldHashes, priorityFromTt, pulledDatePatch, statusFromTt, syncDateOf, type SyncFields, tagsHash } from "../domain/ticktick/mapping";
import { isSyncedTag, pullableTagName, syncedTagLeaves, ttTagName } from "../domain/ticktick/tags";
import type { TtProjectData, TtTag, TtTask } from "../domain/ticktick/types";
import { type ID, paletteColor, type SyncLink, syncLinkId, type Task } from "../domain/types";
import { type TickTickApi, TickTickError, type TickTickErrorKind } from "./ports";
import type { TaskInput } from "./TaskService";
import type { TaskIndex } from "./taskIndex";
import type { LinkedList } from "./syncMarks";
import type { StoredNoteBase } from "../domain/ticktick/noteText";
import { sameLines } from "../domain/textMerge";
import type { Tx } from "./tx";
import type { WriteResult } from "./writes";

// What the sync's steps share: its labels and results, failures, the pull plan and link drafts, field hashes and
// TickTick's tags. The steps are in SyncService (the order and the reads), syncPull (the content command), syncPush
// (the push) and syncLinkBook (the bookkeeping).

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
export const PULL_REQUESTS_MAX = 90;
/** Completions are re-read from a little before the last pull, so clock skew cannot drop one. */
export const COMPLETED_OVERLAP_MS = 5 * 60_000;
/**
 * The completed-tasks query takes whole seconds (`ttStamp`) and whether its bounds are inclusive is not known, so the
 * halves of a split window share one second; a window of two such seconds or less is not split further.
 */
export const COMPLETED_WINDOW_MIN_MS = 1000;
/**
 * Per list and sync: full completed-tasks reads, each split in two until every half holds fewer than TickTick's
 * answer size. A list makes at most
 * twice this many reads, plus one.
 */
export const COMPLETED_READS_MAX = 32;
/**
 * A sync that wrote nothing else leaves `lastPulledAt` as it is, until it is this old. Two devices with sync on would
 * otherwise wake each other forever: every write reaches the other device as a reload, which syncs and writes again.
 * The next pull asks for completions since the stored time (less the overlap) either way, so none is missed.
 */
export const LAST_PULLED_REFRESH_MS = 60 * 60_000;

export const FIELDS = ["title", "status", "priority", "date", "parent", "section", "tags"] as const satisfies readonly (keyof SyncFields)[];
export type Field = (typeof FIELDS)[number];

const EMPTY_HASHES = fieldHashes({ title: "", status: "open", priority: 0, date: null, parent: null, section: null, tags: [] });
export const NO_SECTION_HASH = EMPTY_HASHES.section!;
export const OPEN_HASH = EMPTY_HASHES.status!;
export const EMPTY_TAGS = tagsHash([]);

/**
 * `list-limit`: TickTick refused a write to a list at its free plan's open-task limit. `list-gone`: the TickTick list a
 * list is linked to no longer exists (HTTP 404 for its data); that list is skipped and the others sync. `stopped`: the
 * session closed during the sync, which wrote nothing it had pulled.
 */
type SyncFailureKind = TickTickErrorKind | "list-limit" | "list-gone" | "stopped";

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

export interface ListPull extends Omit<LinkedList, "link"> {
	projectId: string;
	data: TtProjectData;
	/** Its completed tasks needed more than one read: `lastPulledAt` is written even by a quiet sync. */
	splitCompleted: boolean;
	/**
	 * A project no list links any more (its list was deleted) that task links still name, keyed by its project id and
	 * named as in TickTick. Its data holds only those tasks: they leave it like tasks moved out of a linked list, and
	 * nothing else comes from it.
	 */
	leaving?: true;
}

/** A Logwell task and its TickTick task after the pull: what the push compares. */
export interface Pair {
	logwellId: ID;
	ttId: string;
	/** Where the TickTick task is now. */
	ttProjectId: string;
	etag: string | null;
	/** The TickTick values now, hashed; a value that cannot be resolved reads as the link's base. */
	ttHashes: Record<string, string>;
}

export interface PullPlan {
	pairs: Pair[];
	/** Links of tasks deleted in Logwell or moved to a list that is not linked: deleted in TickTick. */
	deletes: SyncLink[];
	removeLinks: Set<string>;
	/** Links to mark `excluded`: the task repeats on one side. */
	exclude: Set<string>;
	newLinks: LinkDraft[];
	/** Entries of `LinkBook.creates` (list, task) the pull settled: forgotten once the links command has committed. */
	settled: [ID, ID][];
	needsConfirmation: PendingTrash[];
	/** Logwell tasks and sections written. */
	written: number;
	wrote: boolean;
}

/** A create TickTick answered whose link could not be written: its id and the field hashes that were sent. */
export interface AnsweredCreate {
	ttId: string;
	base: Record<string, string>;
}

/** `LinkBook.creates` from what this device stored (`TickTickPending`); an entry that cannot be read is left out. */
export function readPending(stored: unknown): Map<ID, Map<ID, AnsweredCreate | null>> {
	const out = new Map<ID, Map<ID, AnsweredCreate | null>>();
	const lists = (stored as { lists?: unknown } | null)?.lists;
	if (typeof lists !== "object" || lists === null) return out;
	const isHashes = (v: unknown): v is Record<string, string> => typeof v === "object" && v !== null && Object.values(v).every((h) => typeof h === "string");
	for (const [listId, entries] of Object.entries(lists)) {
		if (typeof entries !== "object" || entries === null) continue;
		const pending = new Map<ID, AnsweredCreate | null>();
		for (const [logwellId, a] of Object.entries(entries as Record<string, unknown>)) {
			if (a === null) pending.set(logwellId, null);
			else if (typeof a === "object" && typeof (a as AnsweredCreate).ttId === "string" && isHashes((a as AnsweredCreate).base)) {
				pending.set(logwellId, { ttId: (a as AnsweredCreate).ttId, base: { ...(a as AnsweredCreate).base } });
			}
		}
		if (pending.size > 0) out.set(listId, pending);
	}
	return out;
}

export type LinkDraft = Pick<SyncLink, "kind" | "logwellId" | "ttId" | "ttProjectId" | "etag" | "base"> & {
	/** The note text TickTick confirmed, the new `noteBase`; absent keeps the link's. */
	note?: StoredNoteBase;
};

export function failureOf(err: unknown, list: { listId: ID; name: string } | null): SyncFailure {
	if (!(err instanceof TickTickError)) throw err;
	return { listId: list?.listId ?? null, listName: list?.name ?? null, kind: err.kind, message: err.message, retryAfterSec: err.retryAfterSec };
}

/** A failure's message without the "TickTick: " its errors start with, for a text that names TickTick already. */
export function failureReason(message: string): string {
	return message.replace(/^TickTick: /u, "");
}

export function isNotFound(err: unknown): boolean {
	return err instanceof TickTickError && err.kind === "not-found";
}

/** An epoch time cut to the whole second, as `ttStamp` sends it. */
export function wholeSecond(ms: number): number {
	return Math.floor(ms / 1000) * 1000;
}

/** An instant in the form of TickTick's queries (`2026-10-08T00:00:00+0000`). */
export function ttStamp(ms: number): string {
	return `${instantOf(ms).slice(0, 19)}+0000`;
}

/** A TickTick title as Logwell stores it; an empty one becomes "Untitled". */
export function ttTitle(raw: string | undefined): string {
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
export function taskInputFromTt(tx: Tx, tt: TtTask, zone: string, tags: PullTags, title: string, categoryId: ID, parentId: ID | null, sectionId: ID | null): TaskInput {
	const dates = pulledDatePatch(null, dateFromTt(tt, zone));
	return {
		title,
		categoryId,
		parentId,
		sectionId: sectionId !== null && isSectionOf(tx.get("sections", sectionId), categoryId) ? sectionId : null,
		priority: priorityFromTt(tt.priority),
		scheduled: dates.scheduled ?? null,
		deadline: dates.deadline ?? null,
		tagKeys: tags.keysOf(tt),
	};
}

export function sameBase(a: Record<string, string>, b: Record<string, string>): boolean {
	const ka = Object.keys(a);
	if (ka.length !== Object.keys(b).length) return false;
	return ka.every((k) => a[k] === b[k]);
}

/**
 * Hashes of a Logwell task's synced values, memoized per record (records are immutable) and tag names (which tags
 * sync depends on every tag; a task with no tags does not depend on them, `names` null).
 */
const lwMemo = new WeakMap<Task, { names: TagNames | null; h: Record<string, string> }>();
export function lwHashes(t: Task, names: TagNames): Record<string, string> {
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

/**
 * Hashes of a TickTick task's synced values, compared with a link's base and with `lwHashes`. `parent` and `section`
 * are Logwell ids the caller resolved; undefined (cannot be resolved) reads as `fallback`'s value.
 */
export function ttFieldHashes(
	tt: TtTask,
	fallback: Record<string, string>,
	parent: ID | null | undefined,
	section: ID | null | undefined,
	zone: string,
	names: TagNames,
): Record<string, string> {
	const h = fieldHashes({
		title: ttTitle(tt.title),
		status: statusFromTt(tt.status),
		priority: priorityFromTt(tt.priority),
		date: dateFromTt(tt, zone),
		parent: parent ?? null,
		section: section ?? null,
		tags: ttLeaves(tt, names),
	});
	if (parent === undefined && fallback.parent !== undefined) h.parent = fallback.parent;
	if (section === undefined && fallback.section !== undefined) h.section = fallback.section;
	return h;
}

/** The pullable tag names of a TickTick task, lowercase, each once. */
export function ttLeaves(tt: TtTask, names: TagNames): string[] {
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
export class RemoteTags {
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
				// Keyed as the lookups key their names (`ttTagName`); a name Logwell cannot hold is never looked up.
				for (const t of await this.api.listTags()) {
					const name = ttTagName(t.name);
					if (name !== null) map.set(name, t);
				}
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
export interface PullTags {
	readonly names: TagNames;
	/** The Logwell keys of a TickTick task's pullable names, in its order. */
	keysOf(tt: TtTask): string[];
}

/** Sort keys for many new tasks: the end of each (list, parent) group, then onwards. */
export class SortKeys {
	private readonly ends = new Map<string, string>();
	private readonly read = new Set<ID>();

	constructor(
		private readonly tx: Tx,
		private readonly index: TaskIndex,
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
		// Not `keyAfter`: it scans every key of the group per call; the running end is kept so a bulk insert stays linear.
		const key = keyBetween(this.ends.get(k) ?? null, null);
		this.ends.set(k, key);
		return key;
	}
}

interface DraftContext {
	projects: ReadonlySet<string>;
	/** Read on first need. */
	trashed: Set<ID> | null;
}

export function draftContext(tx: Tx): DraftContext {
	return { projects: linkedProjects(tx), trashed: null };
}

/**
 * Writes a link that syncs (its mode left out, so an excluded link syncs again), never over a localOnly one, unless its
 * project is no longer linked (the list was unlinked meanwhile) or it would change nothing. A link marked `pendingDelete` meanwhile (a purge or an undo
 * during the sync) is never overwritten, nor the link of a task that is gone. A new link for a task that is gone
 * and not in Trash is written `pendingDelete`, so the next sync deletes the TickTick copy.
 */
export function putDraft(tx: Tx, d: LinkDraft, ctx: DraftContext): void {
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
 * casing. An unknown name becomes a new tag, named and nested from TickTick's record when there is one (`remote`): its
 * label, and its parent (created first when Logwell lacks it), one level only; a parent whose name a Logwell child tag
 * owns is not nested under.
 */
export function pullTags(tx: Tx, remote: ReadonlyMap<string, TtTag> | null): PullTags {
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
		return label !== undefined && normalizeTagKey(label) === name ? normalizedText(label) : name;
	};
	const keyFor = (name: string): string | null => {
		const owner = names.owner(name);
		if (owner !== undefined) return owner;
		let parentKey: string | null = null;
		const parentRaw = remote?.get(name)?.parent;
		const parentName = parentRaw === undefined ? null : ttTagName(parentRaw);
		if (parentName !== null && parentName !== name) {
			const parentOwner = names.owner(parentName);
			if (parentOwner === undefined) {
				ensure(parentName, labelOf(parentName));
				parentKey = parentName;
			} else if (tagPath(parentOwner).length === 1 && isSyncedTag(names, parentOwner)) {
				parentKey = parentOwner;
			}
		}
		const key = childTagPath(parentKey, name);
		if (names.clash(key) !== null) return null;
		ensure(key, childTagPath(parentKey === null ? null : display(parentKey), labelOf(name)));
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

export function trashedIds(tx: Tx): Set<ID> {
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
export const STOPS_ALL: ReadonlySet<SyncFailureKind> = new Set(["unauthorized", "rate-limited", "network", "stopped"]);

/** Groups items by list, keeping their order. */
export function byList<T>(items: readonly T[], listOf: (item: T) => ID): T[][] {
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
export class PushStop extends Error {
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

export function stoppedFailure(): SyncFailure {
	return { listId: null, listName: null, kind: "stopped", message: STOPPED_MESSAGE, retryAfterSec: null };
}

/** The API, but every call fails as a network error, before anything is sent, once `stopped()` is true. */
export function stoppable(api: TickTickApi, stopped: () => boolean): TickTickApi {
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

export function failed(error: SyncFailure): SyncResult {
	return { ok: false, error, failures: [error], content: { wrote: false, label: TICKTICK_SYNC_LABEL }, pulled: 0, pushed: 0, needsConfirmation: [], warnings: [] };
}

/** A note project cannot be linked. */
export function assertTaskProject(data: TtProjectData): void {
	if (data.project.kind === "NOTE") throw new DomainError("InvalidValue", "A TickTick note list cannot be linked.");
}
