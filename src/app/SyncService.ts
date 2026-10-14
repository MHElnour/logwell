import { tagNamesOf } from "../domain/tags";
import { isSyncable, statusFromTt } from "../domain/ticktick/mapping";
import { pullableTagName } from "../domain/ticktick/tags";
import { TICKTICK_COMPLETED_MAX, type TtProjectData, type TtTask } from "../domain/ticktick/types";
import { type ID, type Instant, type SyncLink, syncLinkId } from "../domain/types";
import { MemoryTickTickPending, type SettingsPort, type TickTickApi, type TickTickPendingPort } from "./ports";
import type { SectionService } from "./SectionService";
import type { AppStore } from "./store";
import type { TaskService } from "./TaskService";
import type { TaskIndex } from "./taskIndex";
import { canonicalProjectId, InboxAliasApi } from "./tickTickInbox";
import { assertLinkable, countPushable } from "./tickTickLink";
import { linkedLists } from "./syncMarks";
import { type NotePush, SyncNotes, type SyncNotesDeps, TICKTICK_NOTE_WARNING } from "./syncNotes";
import type { WriteResult } from "./writes";
import { assertTaskProject, COMPLETED_OVERLAP_MS, COMPLETED_READS_MAX, COMPLETED_WINDOW_MIN_MS, draftContext, failed, failureOf, type FirstSyncPlan, isNotFound, type LinkDraft, type ListPull, LOOKUP_MAX, lwHashes, OPEN_HASH, type PendingTrash, PULL_REQUESTS_MAX, PushStop, putDraft, RemoteTags, sameBase, stoppable, stoppedFailure, type SyncFailure, type SyncResult, TICKTICK_KEEP_LABEL, TICKTICK_LINKS_LABEL, TICKTICK_SYNC_LABEL, TICKTICK_TAGS_UNREAD_WARNING, TICKTICK_TRASH_LABEL, TICKTICK_UNLINK_LABEL, ttFieldHashes, ttStamp, wholeSecond } from "./syncModel";
import { LinkBook } from "./syncLinkBook";
import { PullApplier } from "./syncPull";
import { Pusher } from "./syncPush";

// The TickTick sync engine. One sync pulls every linked list, merges per field,
// writes the pulled changes as one content command, pushes Logwell's changes, then writes the bookkeeping (syncLinks)
// as its own command that is never undoable. Pulls (background, Sync now, first sync) are not undoable either;
// only a confirmed bulk Move to Trash is, and undoing it restores unlinked tasks that the next sync creates again. No
// scheduler here: the session's `TickTickScheduler` (src/obsidian) decides when to sync.

/** Every field of a TickTick answer but its id and etag, in a fixed order: what a change there can touch. */
const READ_FIELDS = [
	"projectId", "title", "content", "desc", "startDate", "dueDate", "timeZone", "isAllDay", "isFloating", "priority", "status", "tags", "parentId",
	"childIds", "columnId", "columnName", "repeatFlag", "kind", "items", "sortOrder", "etimestamp", "completedTime", "createdTime", "modifiedTime",
] as const satisfies readonly (keyof TtTask)[];

/**
 * What a lookup read of a task, for a later read of the same task to compare: its etag, or for an answer without one
 * TickTick's own fields as they came (never equal to an etag).
 */
function readMark(tt: TtTask): string {
	return tt.etag ?? `#${JSON.stringify(READ_FIELDS.map((k) => tt[k] ?? null))}`;
}

export class SyncService {
	/** The running `sync()`, for single flight. */
	private running: Promise<SyncResult> | null = null;
	/** Every sync, first sync, confirmation and unlink runs after the one before. */
	private tail: Promise<unknown> = Promise.resolve();
	/** The API, refusing every request once `stop` was called. */
	private readonly api: TickTickApi;
	/** The layer under `api` that makes the Inbox's two spellings one project. */
	private readonly inbox: InboxAliasApi;
	/** Runs started by `serial` and not finished. */
	private inFlight = 0;
	/** Set by `stop`: every request is refused from then on. */
	private stopped = false;
	/** TickTick ids a lookup found gone, kept for the next sync while their tasks stay missing and undecided. */
	private goneInTickTick = new Set<string>();
	/**
	 * TickTick ids read once open in their own list with a new etag, missing from its data, with what was read
	 * (`readMark`). That is a delete there, or a change TickTick's list data left out: gone only when a later sync
	 * reads the same. Dropped once the task is seen. In memory: after a restart the task is read twice again.
	 */
	private firstReads = new Map<string, string>();

	private readonly index: TaskIndex;
	/** Links and link marks outside the pull's own commands, and the creates waiting to be linked. */
	private readonly links: LinkBook;
	/** Applies a pull in the content command. */
	private readonly puller: PullApplier;
	/** Sends Logwell's changes. */
	private readonly pusher: Pusher;
	/** Description notes; null when the host gives no vault (the sync never touches a note). */
	private readonly notes: SyncNotes | null;

	constructor(
		private readonly store: AppStore,
		tasks: TaskService,
		sections: SectionService,
		private readonly settings: Pick<SettingsPort, "zone">,
		api: TickTickApi,
		notes?: SyncNotesDeps,
		/** Where the TickTick tasks waiting to be linked are kept on this device (`LinkBook`). */
		pendingPort: TickTickPendingPort = new MemoryTickTickPending(),
	) {
		this.index = tasks.lists;
		this.notes = notes === undefined ? null : new SyncNotes(notes, store, tasks, { content: TICKTICK_SYNC_LABEL, links: TICKTICK_LINKS_LABEL });
		// The Inbox's two spellings (`inbox` and `inbox<digits>`) are one project to everything below this line.
		// The stop guard wraps both sides: the Inbox wrapper's own follow-up calls (learning the real id, moving a stray
		// create) also stop once the sync is stopped.
		this.inbox = new InboxAliasApi(stoppable(api, () => this.stopped));
		this.api = stoppable(this.inbox, () => this.stopped);
		this.links = new LinkBook(store, pendingPort);
		this.puller = new PullApplier(tasks, sections, settings, this.index, this.links);
		this.pusher = new Pusher(store, settings, this.index, this.api, this.inbox, this.links);
	}

	// -- entry points --------------------------------------------------------------------------------------------

	/**
	 * Syncs every linked list ("Sync now" and background pulls alike; neither is undoable). A call while a sync runs
	 * returns the running sync. The one queue of triggers is the scheduler's (`TickTickScheduler`), which runs a
	 * trigger that came during a sync once after it.
	 */
	sync(): Promise<SyncResult> {
		return this.running ?? this.start();
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
	 * its pull writes nothing.
	 */
	stop(): void {
		this.stopped = true;
	}

	/** Resolves when no sync, first sync, confirmation or unlink runs or waits. */
	async idle(): Promise<void> {
		for (;;) {
			const current = this.running ?? this.tail;
			await current.catch(() => undefined);
			if (this.running === null && current === this.tail) return;
		}
	}

	/**
	 * The first-sync preview. Writes nothing. As in `applyFirstSync`, a refusal (the list cannot be linked, a note
	 * list) is thrown, and a TickTick request that fails is a failed result naming the list.
	 */
	async planFirstSync(listId: ID, projectId: string): Promise<FirstSyncPlan | SyncResult> {
		assertLinkable(this.store.state, this.index, listId, projectId);
		const data = await this.readFirstProject(listId, projectId);
		if (!("project" in data)) return data;
		assertTaskProject(data);
		const toTickTick = countPushable(this.store.state, this.index, listId);
		const toLogwell = data.tasks.filter((t) => statusFromTt(t.status) === "open" && isSyncable(t)).length;
		return { listId, projectId, toLogwell, toTickTick };
	}

	/** The project a first sync reads, or the failed result of a TickTick request that failed. */
	private async readFirstProject(listId: ID, projectId: string): Promise<TtProjectData | SyncResult> {
		try {
			return await this.api.getProjectData(projectId);
		} catch (err) {
			const name = this.store.state.categories.get(listId)?.name ?? null;
			return failed(failureOf(err, { listId, name: name ?? "" }));
		}
	}

	/**
	 * Links the list to the project and runs the first sync (not undoable). No matching:
	 * TickTick's open tasks and sections come in, Logwell's open tasks go up. A refusal is thrown; a TickTick failure
	 * is in the result.
	 */
	applyFirstSync(listId: ID, projectId: string): Promise<SyncResult> {
		return this.serial(async () => {
			assertLinkable(this.store.state, this.index, listId, projectId);
			const data = await this.readFirstProject(listId, projectId);
			if (!("project" in data)) return data;
			assertTaskProject(data);
			// A backup of the database as it is, before the first sync writes anything. One that cannot be
			// taken stops the first sync.
			await this.store.snapshot("pre-sync");
			await this.store.run(
				TICKTICK_LINKS_LABEL,
				(tx) => {
					assertLinkable(tx.base, this.index, listId, projectId);
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
				const gone = taskIds.filter((id) => tx.get("tasks", id)?.categoryId === listId);
				wrote = this.puller.trashGoneIn(tx, new Set(gone)) > 0;
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
					const project = this.puller.projectOfList(tx, listId);
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
			this.links.load();
			if (this.links.creates.delete(listId)) this.links.save();
			return { wrote, label: TICKTICK_UNLINK_LABEL };
		});
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
		};
		run.then(settle, settle);
		return run;
	}

	// -- checks --------------------------------------------------------------------------------------------------


	// -- one sync ------------------------------------------------------------------------------------------------

	/**
	 * Heals the list links, in a links command that is not undoable. A list link written with the Inbox's real id
	 * (`inbox<digits>`, by an early build) is the same project as `inbox`: the links of that list are rewritten to the
	 * alias. A list link whose list is gone (deleted by an earlier version, which left its links) goes with its sections'
	 * links; its tasks keep theirs, so they leave its project like the tasks of a list deleted now.
	 */
	private async healListLinks(): Promise<void> {
		const { syncLinks: links, categories } = this.store.state;
		let stale = false;
		for (const l of links.values()) if (l.kind === "list" && (l.ttId !== canonicalProjectId(l.ttId) || !categories.has(l.logwellId))) stale = true;
		if (!stale) return;
		await this.store.run(
			TICKTICK_LINKS_LABEL,
			(tx) => {
				const gone = new Set<string>();
				for (const l of tx.all("syncLinks")) {
					if (l.kind !== "list" || tx.get("categories", l.logwellId) !== undefined) continue;
					gone.add(canonicalProjectId(l.ttId));
					tx.remove("syncLinks", syncLinkId("list", l.logwellId));
				}
				for (const l of tx.all("syncLinks")) {
					if (l.kind === "section" && tx.get("sections", l.logwellId) === undefined && gone.has(canonicalProjectId(l.ttProjectId ?? ""))) {
						tx.remove("syncLinks", syncLinkId("section", l.logwellId));
						continue;
					}
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
	 * until each holds fewer than that, within the splits a list may make. Only full reads count against `budget`; a split adds its two reads to `spent.requests`
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
		await this.links.settleMarks();
		await this.healListLinks();
		this.links.load();
		const startedAt: Instant = this.store.now();
		/** The state when the sync started: unchanged at the end means the sync wrote nothing. */
		const stateAtStart = this.store.state;
		const lists = linkedLists(this.store.state);

		// 1. Pull every linked list. A project that fails to load stops the sync before anything is written, except one
		// that no longer exists (HTTP 404), which stops its list only.
		const pulls: ListPull[] = [];
		const seen = new Map<string, TtTask>();
		/**
		 * Seen in TickTick: no earlier verdict on it stands, even when this sync stops before its end. A later omission
		 * is judged afresh.
		 */
		const see = (t: TtTask): void => {
			seen.set(t.id, t);
			this.firstReads.delete(t.id);
			this.goneInTickTick.delete(t.id);
		};
		/** Some list's completed tasks may lack some: a cut answer that could not be narrowed (200 or more within about two seconds, or no splits or requests left). */
		let anyCut = false;
		/**
		 * Requests made by the pull so far: project data and completed reads. Every list gets its project data and its
		 * first completed read even past PULL_REQUESTS_MAX, so a list is never skipped; only splits stop there.
		 */
		const spent = { requests: 0 };
		/** The projects of linked lists whose TickTick list no longer exists, and their failures. */
		const held = new Set<string>();
		const gone: SyncFailure[] = [];
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
				for (const t of completed) if (!seen.has(t.id)) see(t);
				// The open tasks are read first and win: a task reopened after its completion is open.
				for (const t of data.tasks) see(t);
			} catch (err) {
				if (!isNotFound(err)) return failed(failureOf(err, l));
				// A TickTick list that no longer exists stops its list only: nothing of it is pulled or pushed, and its
				// tasks and links stay as they are until the list is unlinked.
				held.add(projectId);
				gone.push({ listId: l.listId, listName: l.name, kind: "list-gone", message: `The TickTick list linked to "${l.name}" no longer exists.`, retryAfterSec: null });
			}
		}
		const listOfProject = new Map(pulls.map((p) => [p.projectId, p]));
		// 1b. The projects of deleted lists that task links still name: read once, for the copies of those tasks. Gone
		// in TickTick too, their copies went with them: only the links go.
		const leavingLinks = new Map<string, Map<string, ID>>();
		for (const link of this.store.state.syncLinks.values()) {
			if (link.kind !== "task" || link.mode === "localOnly" || link.ttProjectId === null || listOfProject.has(link.ttProjectId) || held.has(link.ttProjectId)) continue;
			const group = leavingLinks.get(link.ttProjectId) ?? new Map<string, ID>();
			group.set(link.ttId, syncLinkId("task", link.logwellId));
			leavingLinks.set(link.ttProjectId, group);
		}
		const dropLinks = new Set<string>();
		for (const [projectId, group] of leavingLinks) {
			try {
				const data = await this.api.getProjectData(projectId);
				spent.requests++;
				const tasks = data.tasks.filter((t) => group.has(t.id));
				listOfProject.set(projectId, { listId: projectId, name: data.project.name, projectId, data: { ...data, tasks }, splitCompleted: false, leaving: true });
				for (const t of tasks) see(t);
			} catch (err) {
				if (!isNotFound(err)) return failed(failureOf(err, null));
				for (const id of group.values()) dropLinks.add(id);
			}
		}

		// 2. Linked tasks expected open but not seen: one lookup each. Completed or won't do there is completed here;
		// not found in any linked project is missing; open but missing from its own project is missing once a second
		// read, at a later sync, finds the same etag (until then its list waits). At most LOOKUP_MAX in all, second reads
		// included, and none past PULL_REQUESTS_MAX requests; the rest wait for the next sync and are never offered for
		// Trash, so a task goes to Trash only once every task of its list was looked up.
		/** TickTick ids confirmed gone: looked up this sync or an earlier one. */
		const missing = new Set<string>();
		/** Lists with linked tasks left for the next sync (beyond the lookups of this one). */
		const waiting = new Set<ID>();
		let lookupsLeft = Math.min(LOOKUP_MAX, Math.max(0, PULL_REQUESTS_MAX - spent.requests));
		/** Every lookup this sync made: the task, or null when TickTick did not find it. */
		const lookedUp = new Map<string, TtTask | null>();
		/** `firstReads` for the next sync: this sync's first reads, and earlier ones of tasks not read again yet. */
		const nextReads = new Map<string, string>();
		// A cut answer may hide a completion of a task an earlier sync found gone (it came back and was completed in
		// the burst): no earlier verdict is kept or used while any window was cut.
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
				const firstRead = this.firstReads.get(link.ttId);
				if (this.goneInTickTick.has(link.ttId)) {
					missing.add(link.ttId);
					if (firstRead !== undefined) nextReads.set(link.ttId, firstRead);
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
						// Completed or won't do; or open under another linked project: moved there after its pull. Open under its
						// own project and unchanged since the last sync, the pull left it out and it is still there. Changed (a
						// delete gives it a new etag; the answer has no deleted flag), it may also be a change the list's data
						// left out: gone only when a later sync reads it again with the same etag. The first read waits. An
						// answer with no etag is changed when its synced values differ from the base; parent and section are
						// read as the base here (unchanged, so the pull takes it and resolves them).
						const changed = tt.etag === undefined ? !sameBase(ttFieldHashes(tt, link.base, undefined, undefined, this.settings.zone(), names), link.base) : tt.etag !== link.etag;
						if (statusFromTt(tt.status) === "completed" || projectId !== link.ttProjectId || !changed) {
							verdict = "found";
							see(tt);
						} else {
							const mark = readMark(tt);
							nextReads.set(link.ttId, mark);
							// Kept at once too: a sync that stops later (a rate limit) does not lose the read.
							this.firstReads.set(link.ttId, mark);
							verdict = firstRead === mark ? "gone" : "waiting";
						}
						break;
					} catch (err) {
						if (!isNotFound(err)) return failed(failureOf(err, pull));
					}
				}
				if (verdict === "waiting") {
					// A first read, or not read this sync: its list waits, so its gone tasks are judged together.
					if (firstRead !== undefined && !nextReads.has(link.ttId)) nextReads.set(link.ttId, firstRead);
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
			// Kept through a cut sync too: the read itself is whole, only the Trash verdict waits.
			this.firstReads = nextReads;
			// Creates that TickTick answered but whose link was not written: their copy is looked up by its id when
			// the pull did not see it (completed outside the window). Gone there, the entry is dropped and the
			// Logwell task goes up again as new.
			const goneCopies: [ID, ID][] = [];
			for (const [listId, pending] of this.links.creates) {
				const pull = pulls.find((p) => p.listId === listId);
				if (pull === undefined) continue;
				for (const [logwellId, answer] of pending) {
					if (answer === null || seen.has(answer.ttId)) continue;
					const ttId = answer.ttId;
					try {
						const tt = await this.api.getTask(pull.projectId, ttId);
						lookedUp.set(ttId, tt);
						if (statusFromTt(tt.status) === "completed") see(tt);
						else goneCopies.push([listId, logwellId]);
					} catch (err) {
						if (!isNotFound(err)) {
							this.links.forget(goneCopies);
							return failed(failureOf(err, pull));
						}
						goneCopies.push([listId, logwellId]);
					}
				}
			}
			this.links.forget(goneCopies);
		}
		// A cut completed answer may lack completions, which would read as gone: no Trash verdict this sync, in any list.
		// Everything else is applied and the window moves on; a hidden completion is found by a lookup at a later sync,
		// and the verdicts come back once the window no longer covers the cut: a sync whose windows were all read in full.
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
		const plan = await this.store.run(TICKTICK_SYNC_LABEL, (tx) => this.puller.applyPull(tx, pulls, seen, missing, waiting, listOfProject, held, remoteTags.known), {
			undoable: false,
		});
		const result: SyncResult = {
			ok: gone.length === 0,
			error: gone[0] ?? null,
			failures: gone,
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
		// Linked now, the creates the pull settled are forgotten. A command that failed above keeps them for the next sync.
		this.links.forget(plan.settled);

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
		const removeLinks = new Set([...plan.removeLinks, ...dropLinks]);
		try {
			await this.pusher.push(plan, pulls, listOfProject, seen, lookedUp, drafts, removeLinks, result, remoteTags, notePushes);
		} catch (err) {
			if (!(err instanceof PushStop)) throw err;
			result.ok = false;
			result.error ??= err.failure;
			result.failures.push(err.failure);
		}
		if (remoteTags.unread) result.warnings.push(TICKTICK_TAGS_UNREAD_WARNING);
		await this.links.writeLinks(drafts, removeLinks, plan.exclude, pulls, startedAt, stateAtStart);
		return result;
	}
}
