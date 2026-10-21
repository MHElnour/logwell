import { isDomainError } from "../domain/errors";
import { canBeParentOf, categoryNameKey, subtasksOf } from "../domain/tasks";
import { dateFromTt, isSyncable, priorityFromTt, pulledDatePatch, statusFromTt } from "../domain/ticktick/mapping";
import { isSyncedTag } from "../domain/ticktick/tags";
import type { TtTag, TtTask } from "../domain/ticktick/types";
import { type ID, type SyncLink, syncLinkId, type Task } from "../domain/types";
import type { SettingsPort } from "./ports";
import type { SectionService } from "./SectionService";
import type { TaskPatch, TaskService } from "./TaskService";
import type { TaskIndex } from "./taskIndex";
import { canonicalProjectId } from "./tickTickInbox";
import type { Tx } from "./tx";
import { type AnsweredCreate, type Field, FIELDS, type ListPull, lwHashes, MISSING_CONFIRM_MIN, NOT_SECTIONED, type PullPlan, type PullTags, pullTags, SortKeys, taskInputFromTt, trashedIds, ttFieldHashes, ttTitle } from "./syncModel";
import type { LinkBook } from "./syncLinkBook";

// The pull's content command: everything a sync read from TickTick, applied to Logwell in one write (tasks, sections,
// completions, moves, Trash and conflict copies), and the plan the push and the links work from.

export class PullApplier {
	constructor(
		private readonly tasks: TaskService,
		private readonly sections: SectionService,
		private readonly settings: Pick<SettingsPort, "zone">,
		private readonly index: TaskIndex,
		private readonly links: LinkBook,
	) {}

	// -- the pull ------------------------------------------------------------------------------------------------

	applyPull(
		tx: Tx,
		pulls: ListPull[],
		seen: Map<string, TtTask>,
		missing: ReadonlySet<string>,
		waiting: ReadonlySet<ID>,
		listOfProject: Map<string, ListPull>,
		/** The projects of linked lists whose TickTick list no longer exists: their tasks wait. */
		held: ReadonlySet<string>,
		remoteTags: ReadonlyMap<string, TtTag> | null,
	): PullPlan {
		const zone = this.settings.zone();
		const tags = pullTags(tx, remoteTags);
		const plan: PullPlan = { pairs: [], deletes: [], removeLinks: new Set(), newLinks: [], settled: [], exclude: new Set(), needsConfirmation: [], written: 0, wrote: false };
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
		const ttHashes = (tt: TtTask, fallback: Record<string, string>): Record<string, string> => ttFieldHashes(tt, fallback, parentOf(tt), sectionOf(tt), zone, tags.names);
		const keys = new SortKeys(tx, this.index);

		// Creates not linked yet, as this pull settles them; what it settles goes in `plan.settled`, forgotten only once
		// the links are written.
		const pendingCreates = new Map([...this.links.creates].map(([listId, pending]) => [listId, new Map(pending)]));

		// Creates that TickTick answered but whose link was not written (the store turned read-only): linked now by
		// TickTick's id, whatever the copy's status, with Logwell's values as the base, so a change made there since
		// (a completion) is pulled like any other.
		const answered = new Set<string>();
		for (const pending of pendingCreates.values()) {
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
			const pending = pendingCreates.get(pull.listId);
			const match = pending === undefined ? undefined : this.matchPending(tx, pending, pull.listId, ttTitle(tt.title));
			if (match !== undefined) {
				pending!.delete(match.id);
				imported.set(tt.id, match.id);
				plan.pairs.push({ logwellId: match.id, ttId: tt.id, ttProjectId: tt.projectId, etag: tt.etag ?? null, ttHashes: ttHashes(tt, lwHashes(match, tags.names)) });
				continue;
			}
			let parentId = parentOf(tt) ?? null;
			const parent = parentId === null ? undefined : tx.get("tasks", parentId);
			if (!canBeParentOf(parent) || parent.recurrence !== null) parentId = null;
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
		for (const [listId, pending] of this.links.creates) {
			for (const [logwellId, answer] of pending) {
				if (answer === null || pendingCreates.get(listId)?.has(logwellId) !== true) plan.settled.push([listId, logwellId]);
			}
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
			const project = this.projectOfList(tx, t.categoryId) ?? "";
			// Moved to a list whose TickTick list no longer exists: it waits with that list's tasks.
			if (held.has(project)) continue;
			if (!listOfProject.has(project)) {
				// Moved to a list that is not linked: it leaves TickTick.
				leave(link, id);
				continue;
			}
			const tt = seen.get(link.ttId);
			if (tt === undefined) {
				// Only a task TickTick confirmed gone; one not looked up yet waits for the next sync. One that left a
				// deleted list is judged with the tasks of the linked list it is in now.
				if (missing.has(link.ttId)) {
					const listId = home.leaving === true ? listOfProject.get(project)!.listId : home.listId;
					const group = missingByList.get(listId) ?? [];
					group.push(t);
					missingByList.set(listId, group);
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
		// nothing yet, as Keep would unlink it while some of them may be completed there. Nothing goes to Trash before every
		// task of its list was looked up.
		for (const [listId, group] of missingByList) {
			const pull = pulls.find((p) => p.listId === listId)!;
			const emptied = pull.data.tasks.length === 0;
			if (waiting.has(listId) && (emptied || group.length < MISSING_CONFIRM_MIN)) continue;
			if (emptied || group.length >= MISSING_CONFIRM_MIN) {
				plan.needsConfirmation.push({ listId, reason: emptied ? "emptied" : "many", tasks: group.map((t) => ({ id: t.id, title: t.title })) });
				continue;
			}
			plan.written += this.trashGoneIn(tx, new Set(group.map((t) => t.id)));
			for (const t of group) plan.removeLinks.add(syncLinkId("task", t.id));
		}
		// `finish` is pure: whether this command writes anything, for the result and its Undo notice.
		plan.wrote = tx.finish().ops.length > 0;
		return plan;
	}

	/**
	 * Moves tasks gone from TickTick to Trash, each with its subtasks that are gone too. A subtask that is not gone
	 * (alive in TickTick, or never sent) stays, as a top-level task: in Trash it would be deleted in TickTick by the next
	 * sync. Returns the tasks written.
	 */
	trashGoneIn(tx: Tx, gone: ReadonlySet<ID>): number {
		let written = 0;
		for (const id of gone) {
			if (tx.get("tasks", id) === undefined) continue;
			for (const sub of subtasksOf(tx.all("tasks"), id)) {
				if (gone.has(sub.id)) continue;
				this.tasks.setParentIn(tx, sub.id, null);
				written++;
			}
			this.tasks.deleteIn(tx, id);
			written++;
		}
		return written;
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
		// Moved to another linked list in TickTick and still in its list here: TickTick's list wins. A subtask leaves its
		// parent for it (a subtask shares its parent's list), whether TickTick names no parent or still the old one,
		// unless its parent changed here since the last sync.
		const pullList = ttList !== homeList && t.categoryId === homeList && (t.parentId === null || ours.parent === link.base.parent);
		let written = 0;
		/** Runs one pulled write; false when Logwell's rules refuse it. */
		const applies = (write: () => void): boolean => {
			try {
				write();
				return true;
			} catch (err) {
				// A pulled value Logwell's rules refuse stays Logwell's; the push sends it back up.
				if (!isDomainError(err)) throw err;
				return false;
			}
		};
		const attempt = (write: () => void): void => {
			if (applies(write)) written++;
		};

		// The parent first, so a subtask that leaves its parent can follow TickTick's list.
		const parent = pull.has("parent") ? parentOf(tt) : undefined;
		if (parent !== undefined) attempt(() => this.tasks.setParentIn(tx, t.id, parent));
		else if (pullList && t.parentId !== null) attempt(() => this.tasks.setParentIn(tx, t.id, null));
		const topLevel = (tx.get("tasks", t.id) ?? t).parentId === null;

		// One patch per pulled value, the list first so a column of the new list follows it: a value Logwell's rules
		// refuse (a column of a list the task left) is skipped, never the others with it. The task counts as one write.
		const patches: TaskPatch[] = [];
		if (pullList) patches.push({ categoryId: ttList });
		if (pull.has("title")) patches.push({ title: ttTitle(tt.title) });
		if (pull.has("priority")) patches.push({ priority: priorityFromTt(tt.priority) });
		if (pull.has("date")) patches.push(pulledDatePatch(t, dateFromTt(tt, zone)));
		if (pull.has("section") && topLevel) {
			const section = sectionOf(tt);
			if (section !== undefined) patches.push({ sectionId: section });
		}
		if (pull.has("tags")) {
			const pulled = tags.keysOf(tt);
			// A tag that does not sync stays.
			const keep = t.tagKeys.filter((k) => !isSyncedTag(tags.names, k) || pulled.includes(k));
			const next = [...keep, ...pulled.filter((k) => !keep.includes(k))];
			if (next.length !== t.tagKeys.length || next.some((k, i) => k !== t.tagKeys[i])) patches.push({ tagKeys: next });
		}
		let patched = false;
		for (const patch of patches) {
			if (Object.keys(patch).length === 0) continue;
			applies(() => {
				if (this.tasks.updateIn(tx, t.id, patch).changed) patched = true;
			});
		}
		if (patched) written++;
		if (pull.has("status")) {
			attempt(() => (statusFromTt(tt.status) === "completed" ? this.tasks.completeOneIn(tx, t.id) : this.tasks.reopenIn(tx, t.id)));
		}
		if (conflict) {
			const now = tx.get("tasks", t.id) ?? t;
			const section = sectionOf(tt);
			attempt(() => {
				const { task } = this.tasks.createIn(tx, taskInputFromTt(tx, tt, zone, tags, `${ttTitle(tt.title)} (TickTick)`, now.categoryId, null, section ?? null));
				// TickTick's version as it is there: completed or won't do there is completed here, and a completed task is
				// never created in TickTick.
				if (statusFromTt(tt.status) === "completed") this.tasks.completeOneIn(tx, task.id);
			});
		}
		return written;
	}

	projectOfList(tx: Tx, listId: ID): string | undefined {
		const id = tx.get("syncLinks", syncLinkId("list", listId))?.ttId;
		return id === undefined ? undefined : canonicalProjectId(id);
	}
}
