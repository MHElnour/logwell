import { tagDisplaySegments, tagNamesOf, tagPath } from "../domain/tags";
import { dateToTt, isSyncable, priorityToTt, statusToTt, syncDateOf } from "../domain/ticktick/mapping";
import { isSyncedTag, pullableTagName, syncedTagLeaves } from "../domain/ticktick/tags";
import { TICKTICK_BATCH_MAX, TICKTICK_FREE_OPEN_MAX, type TtColumn, type TtMove, type TtTag, type TtTask, type TtTaskCreate, type TtTaskUpdate, type TtTaskWrite } from "../domain/ticktick/types";
import { type ID, syncLinkId, type Task } from "../domain/types";
import { type SettingsPort, type TickTickApi, TickTickError } from "./ports";
import type { AppStore } from "./store";
import type { TaskIndex } from "./taskIndex";
import { INBOX_ALIAS, InboxAliasApi } from "./tickTickInbox";
import { type NotePush, ownsNote } from "./syncNotes";
import { docFromTickTick, isChecklist, sameDoc, storedBase, ttNoteWrite } from "../domain/ticktick/noteText";
import { byList, draftContext, EMPTY_TAGS, failureOf, type Field, FIELDS, type LinkDraft, type ListPull, lwHashes, NO_SECTION_HASH, NOT_SECTIONED, OPEN_HASH, type Pair, type PullPlan, PushStop, putDraft, RemoteTags, STOPS_ALL, type SyncFailure, type SyncResult, TICKTICK_LINKS_LABEL } from "./syncModel";
import type { LinkBook } from "./syncLinkBook";

// The push: Logwell's changes of each linked list sent to TickTick (creates, updates, moves, completions, deletes,
// sections and tags), with what TickTick confirmed kept as link drafts for the bookkeeping.

export class Pusher {
	constructor(
		private readonly store: AppStore,
		private readonly settings: Pick<SettingsPort, "zone">,
		private readonly index: TaskIndex,
		/** The API, refusing every request once the sync is stopped. */
		private readonly api: TickTickApi,
		/** The layer under `api` that makes the Inbox's two spellings one project. */
		private readonly inbox: InboxAliasApi,
		private readonly links: LinkBook,
	) {}

	// -- the push ------------------------------------------------------------------------------------------------

	async push(
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
				const tag = state.tags.get(key);
				const labels = (tag === undefined ? null : tagDisplaySegments(tag)) ?? path;
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
				// A read never meets the limit; only a write to a full list is reported as it. TickTick answers a write past
				// its free plan's limit with a plain server error, and Logwell cannot see the plan: the notice says the limit
				// is the likely cause, not the only one, and keeps TickTick's reason.
				const openNow = open.get(pull.listId) ?? 0;
				const full = !err.read && err.failure.kind === "server" && openNow >= TICKTICK_FREE_OPEN_MAX;
				const reason = err.failure.message.replace(/^TickTick: /u, "");
				stopped.set(
					pull.listId,
					full
						? {
								...err.failure,
								kind: "list-limit",
								message: `TickTick: "${pull.name}" refused the change (${reason}). It has ${openNow} open tasks, and TickTick's free plan allows ${TICKTICK_FREE_OPEN_MAX} per list, so that limit is the likely cause; on a paid plan it is a TickTick error.`,
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
					if (this.links.creates.get(listId)?.get(t.id) != null) continue;
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
						if (err instanceof PushStop && err.maybePartial) this.links.remember(pull.listId, t.id, null);
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
						this.links.remember(pull.listId, t.id, { ttId: made.id, base: draft.base });
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
}
