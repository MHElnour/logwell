import type { TickTickApi } from "../app/ports";
import type { FirstSyncPlan, PendingTrash, SyncResult, SyncService } from "../app/SyncService";
import { TICKTICK_TRASH_LABEL } from "../app/SyncService";
import { type LinkOption, type LinkTarget, countPushable, defaultOption, loadLinkOptions } from "../app/tickTickLink";
import { type TaskIndex, SYNCED_LIST_OPEN_MAX } from "../app/taskIndex";
import { isListSynced } from "../app/syncMarks";
import { DomainError } from "../domain/errors";
import type { ID } from "../domain/types";
import type { DbData } from "../persistence/schema";
import type { LinkFormDeps, PreviewFormDeps } from "./tickTickDialogs";
import { failureText } from "./tickTickScheduler";

// What happens around the dialogs. No Obsidian import: the dialogs, notices and
// the engine are passed in, so each step is tested with scripted answers.

export const NOT_READY_TEXT = "Add your TickTick token and turn on sync for this device in Settings > Logwell first.";

export interface LinkFlowDeps {
	state: () => DbData;
	/** Token set and the device switch on. */
	ready: () => boolean;
	api: Pick<TickTickApi, "listProjects" | "getProjectData" | "createProject">;
	sync: Pick<SyncService, "planFirstSync" | "applyFirstSync" | "unlinkList">;
	index: Pick<TaskIndex, "tasksOf" | "openCount">;
	/**
	 * Projects this flow created in TickTick whose first sync did not link the list, per list. A retry reuses the
	 * project instead of creating a second one. Held by the session; cleared once the list is linked.
	 */
	created: Map<ID, { projectId: string; name: string }>;
	pick: (deps: Omit<LinkFormDeps, "onContinue" | "onCancel">) => Promise<LinkOption | null>;
	preview: (deps: Omit<PreviewFormDeps, "onSync" | "onBack">) => Promise<"sync" | "back" | null>;
	notify: (message: string) => void;
	error: (err: unknown) => void;
	/** The schedule follows the new link or unlink. `result` is the first sync, which counts as this device's latest sync. */
	linked: (result: SyncResult | null) => void;
}

/**
 * What can refuse a link, checked before anything is created in TickTick: the list is gone, is already linked, or has
 * more than 999 open tasks. The engine checks again when it links; this keeps an empty project from being
 * left behind by a first sync that was always going to be refused.
 */
function assertLinkable(deps: Pick<LinkFlowDeps, "state" | "index">, listId: ID): void {
	const state = deps.state();
	const list = state.categories.get(listId);
	if (list === undefined) throw new DomainError("NotFound", "The list no longer exists.");
	if (isListSynced(state.syncLinks, listId)) throw new DomainError("InvalidValue", "This list is already linked to TickTick.");
	if (deps.index.openCount(listId) > SYNCED_LIST_OPEN_MAX) {
		throw new DomainError(
			"SyncedListFull",
			`Can't link the list: ${list.name} has more than ${SYNCED_LIST_OPEN_MAX} open tasks, the most a list synced with TickTick can hold.`,
		);
	}
}

/** Pick a TickTick list, preview, and run the first sync. Dismissing either dialog changes nothing. */
export async function linkListFlow(deps: LinkFlowDeps, listId: ID): Promise<void> {
	if (!deps.ready()) return deps.notify(NOT_READY_TEXT);
	const list = deps.state().categories.get(listId);
	if (list === undefined) return;
	let chosen: LinkOption | null = null;
	try {
		assertLinkable(deps, listId);
		for (;;) {
			const previous: LinkOption | null = chosen;
			chosen = await deps.pick({
				listName: list.name,
				load: () => loadLinkOptions(deps.api, deps.state(), listId),
				initial: (options) => options.find((o) => o.key === previous?.key && !o.disabled) ?? defaultOption(options, list.name),
			});
			if (chosen === null) return;
			const plan = await planOf(deps, listId, chosen.target);
			const answer = await deps.preview({ listName: list.name, projectName: chosen.target.name, plan });
			if (answer === "back") continue;
			if (answer === null) return;
			// The state may have changed while the dialogs were open: check again before creating anything.
			assertLinkable(deps, listId);
			const projectId = chosen.target.kind === "existing" ? chosen.target.projectId : await createProject(deps, listId, chosen.target.name);
			const result = await deps.sync.applyFirstSync(listId, projectId);
			if (isListSynced(deps.state().syncLinks, listId)) deps.created.delete(listId);
			deps.linked(result);
			if (result.failures.length > 0) for (const f of result.failures) deps.notify(failureText(f));
			else deps.notify(`Synced “${list.name}”: ${result.pulled} in, ${result.pushed} out.`);
			return;
		}
	} catch (err) {
		deps.error(err);
	}
}

/**
 * A list with sections gets a project that can hold them (TickTick calls a project with sections kanban). A project
 * this flow already created for the list, whose first sync failed before it linked the list, is reused, so a retry
 * does not leave a second empty project in TickTick.
 */
async function createProject(deps: LinkFlowDeps, listId: ID, name: string): Promise<string> {
	const earlier = deps.created.get(listId);
	if (earlier !== undefined && earlier.name === name) return earlier.projectId;
	const sections = [...deps.state().sections.values()].some((s) => s.categoryId === listId);
	const made = await deps.api.createProject(sections ? { name, viewMode: "kanban" } : { name });
	deps.created.set(listId, { projectId: made.id, name });
	return made.id;
}

/** A new project has nothing to bring; an existing one is read (and a note list or a full list is refused there). */
async function planOf(deps: LinkFlowDeps, listId: ID, target: LinkTarget): Promise<Pick<FirstSyncPlan, "toLogwell" | "toTickTick">> {
	if (target.kind === "create") return { toLogwell: 0, toTickTick: countPushable(deps.state(), deps.index, listId) };
	return deps.sync.planFirstSync(listId, target.projectId);
}

/** Unlinking keeps every task on both sides. Not undoable (links only). */
export async function unlinkListFlow(deps: Pick<LinkFlowDeps, "state" | "sync" | "notify" | "error" | "linked">, listId: ID): Promise<void> {
	const name = deps.state().categories.get(listId)?.name ?? "The list";
	try {
		const r = await deps.sync.unlinkList(listId);
		deps.linked(null);
		if (r.wrote) deps.notify(`${name} is no longer synced with TickTick. Its tasks stay on both sides.`);
	} catch (err) {
		deps.error(err);
	}
}

// -- tasks missing from TickTick -------------------------------------------------------------------------

export interface PrompterDeps {
	state: () => DbData;
	sync: Pick<SyncService, "trashMissing" | "keepMissing">;
	/** `store.undoMark()`, taken right before Move to Trash writes. */
	undoMark: () => number;
	ask: (pending: PendingTrash, listName: string) => Promise<"trash" | "keep" | null>;
	/** A notice with an Undo button for the write that ran under the store label `label` after `mark`. */
	notifyUndo: (message: string, label: string, mark: number) => void;
	notify: (message: string) => void;
	error: (err: unknown) => void;
}

const keyOf = (p: PendingTrash): string => `${p.listId}|${p.reason}|${p.tasks.map((t) => t.id).sort().join(",")}`;

/**
 * Asks about each pending confirmation of the latest sync, one dialog at a time. A set that was asked is not asked
 * again while it stays the same (every pull reports it again): closing the dialog means "decide later", and the
 * question returns when the set changes or the next session starts. Move to Trash is one undo step; Keep writes only
 * links and so offers no Undo.
 */
export class ConfirmationPrompter {
	private readonly asked = new Set<string>();
	private current = new Set<string>();
	/** The pending confirmations of the latest sync. */
	private latest: readonly PendingTrash[] = [];
	private queue: PendingTrash[] = [];
	private running = false;

	constructor(private readonly deps: PrompterDeps) {}

	handle(pending: readonly PendingTrash[]): void {
		this.latest = pending;
		this.current = new Set(pending.map(keyOf));
		for (const k of this.asked) if (!this.current.has(k)) this.asked.delete(k);
		for (const p of pending) {
			const key = keyOf(p);
			if (this.asked.has(key)) continue;
			this.asked.add(key);
			this.queue.push(p);
		}
		void this.drain();
	}

	private async drain(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			for (let p = this.queue.shift(); p !== undefined; p = this.queue.shift()) {
				// A later sync may have settled it meanwhile (the tasks were deleted, or came back).
				if (!this.current.has(keyOf(p))) continue;
				const name = this.deps.state().categories.get(p.listId)?.name;
				if (name === undefined) continue;
				// Tasks already moved or deleted by an earlier answer are not asked about again.
				const state = this.deps.state();
				const still = { ...p, tasks: p.tasks.filter((t) => state.tasks.get(t.id)?.categoryId === p.listId) };
				if (still.tasks.length === 0) continue;
				try {
					await this.answer(still, name, await this.deps.ask(still, name));
				} catch (err) {
					this.deps.error(err);
				}
			}
		} finally {
			this.running = false;
		}
	}

	private async answer(p: PendingTrash, listName: string, choice: "trash" | "keep" | null): Promise<void> {
		if (choice === null) return;
		// The dialog may have been open while a sync ran: act only on the tasks the latest sync still reports missing
		// (one that came back is neither trashed nor deleted in TickTick).
		const missing = new Set(this.latest.filter((l) => l.listId === p.listId && l.reason === p.reason).flatMap((l) => l.tasks.map((t) => t.id)));
		const ids = p.tasks.map((t) => t.id).filter((id) => missing.has(id));
		if (ids.length === 0) return;
		const n = ids.length;
		const tasks = `${n} task${n === 1 ? "" : "s"}`;
		if (choice === "trash") {
			const mark = this.deps.undoMark();
			const r = await this.deps.sync.trashMissing(p.listId, ids);
			if (r.wrote) this.deps.notifyUndo(`Moved ${tasks} to Trash.`, TICKTICK_TRASH_LABEL, mark);
			return;
		}
		await this.deps.sync.keepMissing(p.listId, ids, p.reason);
		this.deps.notify(p.reason === "emptied" ? `Kept ${tasks}. ${listName} is no longer synced with TickTick.` : `Kept ${tasks} in Logwell only. They are not synced.`);
	}
}
