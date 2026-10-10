import { isInboxProjectId } from "../domain/ticktick/inbox";
import { TickTickError, type TickTickApi, type TickTickErrorKind } from "./ports";
import type { TtBatch, TtColumn, TtMove, TtProject, TtProjectData, TtTask, TtTaskCreate, TtTaskUpdate } from "../domain/ticktick/types";

// TickTick's Inbox has two spellings. It is read and moved under the alias `inbox`, while every
// task, column and answer carries its real id, `inbox<digits>`. The engine compares and keys by project id in many
// places, so it must see one spelling. This wrapper gives it that: every id that comes back is `inbox`, and each call
// goes out in the spelling the real API accepts for it (probed 2026-10-08):
//
//   alias `inbox` works      project data, completed tasks, moves, GET /project/inbox/task/{id}, a single
//                            POST /task/{id} with projectId `inbox`, DELETE /project/inbox/task/{id}
//   alias `inbox` fails      POST /task/batch with an update that carries it (404)
//   alias not relied on      completing a task, creating a column (untested), creating a task: these use the real id
//   create with no project   files the task in the Inbox (the answer carries the real id)

/** The one id the engine uses for the Inbox: what a list link holds and what every pulled task carries. */
export const INBOX_ALIAS = "inbox";

/** `inbox<digits>` and `inbox` are the same project. */
export function canonicalProjectId(id: string): string {
	return isInboxProjectId(id) ? INBOX_ALIAS : id;
}

const unknownId = (): TickTickError => new TickTickError("not-found", "TickTick: the id of the Inbox is not known yet.");

/** Errors that end the sync: `learnId` passes them on instead of trying the next task. */
const STOPS_LEARNING: ReadonlySet<TickTickErrorKind> = new Set(["unauthorized", "rate-limited", "network"]);

export class InboxAliasApi implements TickTickApi {
	/** The real Inbox id, once an answer has shown it. */
	private real: string | null = null;

	constructor(private readonly api: TickTickApi) {}

	/** Whether the real id has been seen. Until it has, no call that needs it is sent. */
	get knowsId(): boolean {
		return this.real !== null;
	}

	/** Whether `id` is the real Inbox id (which is then known); an answer that carries it gets the alias instead. */
	private seen(id: string): boolean {
		if (id === INBOX_ALIAS || !isInboxProjectId(id)) return false;
		this.real = id;
		return true;
	}

	private task(t: TtTask): TtTask {
		return this.seen(t.projectId) ? { ...t, projectId: INBOX_ALIAS } : t;
	}

	private column(c: TtColumn): TtColumn {
		return this.seen(c.projectId) ? { ...c, projectId: INBOX_ALIAS } : c;
	}

	private project<P extends TtProject>(p: P): P {
		return this.seen(p.id) ? { ...p, id: INBOX_ALIAS } : p;
	}

	/**
	 * Learns the real id before a call that cannot use the alias: from a known task of the Inbox (one GET by the alias,
	 * the answer carries the real id), else from the Inbox's open tasks. Leaves it unknown for an Inbox with neither.
	 */
	async learnId(taskIds: readonly string[] = []): Promise<void> {
		if (this.real !== null) return;
		for (const id of taskIds.slice(0, 3)) {
			try {
				await this.getTask(INBOX_ALIAS, id);
			} catch (err) {
				// A token, rate-limit or network error ends the sync; trying more tasks would only cost requests.
				if (!(err instanceof TickTickError) || STOPS_LEARNING.has(err.kind)) throw err;
				continue;
			}
			if (this.real !== null) return;
		}
		await this.getProjectData(INBOX_ALIAS);
	}

	/** The real id for a call that needs it. */
	private async need(taskIds: readonly string[]): Promise<string> {
		await this.learnId(taskIds);
		if (this.real === null) throw unknownId();
		return this.real;
	}

	async listProjects(): Promise<TtProject[]> {
		return (await this.api.listProjects()).map((p) => this.project(p));
	}

	async getProjectData(projectId: string): Promise<TtProjectData> {
		const data = await this.api.getProjectData(canonicalProjectId(projectId));
		return { project: this.project(data.project), tasks: data.tasks.map((t) => this.task(t)), columns: data.columns.map((c) => this.column(c)) };
	}

	async listCompleted(query: Parameters<TickTickApi["listCompleted"]>[0]): Promise<TtTask[]> {
		return (await this.api.listCompleted({ ...query, projectIds: query.projectIds.map(canonicalProjectId) })).map((t) => this.task(t));
	}

	async filterTasks(filter: Parameters<TickTickApi["filterTasks"]>[0]): Promise<TtTask[]> {
		const sent = filter.projectIds === undefined ? filter : { ...filter, projectIds: filter.projectIds.map(canonicalProjectId) };
		return (await this.api.filterTasks(sent)).map((t) => this.task(t));
	}

	async getTask(projectId: string, taskId: string): Promise<TtTask> {
		return this.task(await this.api.getTask(canonicalProjectId(projectId), taskId));
	}

	/** A create for the Inbox: with the real id once it is known, else with no project, which TickTick files there. */
	private created(task: TtTaskCreate): TtTaskCreate {
		if (task.projectId !== INBOX_ALIAS) return task;
		if (this.real !== null) return { ...task, projectId: this.real };
		const noProject: Partial<TtTaskCreate> = { ...task };
		delete noProject.projectId;
		return noProject as TtTaskCreate;
	}

	async createTask(task: TtTaskCreate): Promise<TtTask> {
		const toInbox = task.projectId === INBOX_ALIAS && this.real === null;
		const made = await this.api.createTask(this.created(task));
		if (!toInbox || isInboxProjectId(made.projectId)) return this.task(made);
		// An account whose default list is not the Inbox: move the task there now, and use the moved copy.
		try {
			await this.api.moveTasks([{ fromProjectId: made.projectId, toProjectId: INBOX_ALIAS, taskId: made.id }]);
			return await this.getTask(INBOX_ALIAS, made.id);
		} catch (err) {
			// Do not leave a stray copy behind; the write counts as failed for the list.
			await this.api.deleteTask(made.projectId, made.id).catch(() => undefined);
			if (err instanceof TickTickError) throw new TickTickError(err.kind, err.message, { status: err.status, retryAfterSec: err.retryAfterSec, maybePartial: true });
			throw err;
		}
	}

	async updateTask(task: TtTaskUpdate): Promise<TtTask> {
		return this.task(await this.api.updateTask({ ...task, projectId: canonicalProjectId(task.projectId) }));
	}

	deleteTask(projectId: string, taskId: string): Promise<void> {
		return this.api.deleteTask(canonicalProjectId(projectId), taskId);
	}

	moveTasks(moves: TtMove[]): ReturnType<TickTickApi["moveTasks"]> {
		return this.api.moveTasks(moves.map((m) => ({ ...m, fromProjectId: canonicalProjectId(m.fromProjectId), toProjectId: canonicalProjectId(m.toProjectId) })));
	}

	async batchTasks(batch: TtBatch): ReturnType<TickTickApi["batchTasks"]> {
		const inbox = (batch.update ?? []).filter((u) => u.projectId === INBOX_ALIAS);
		// A batch update cannot carry the alias: the real id is learned first.
		const real = inbox.length === 0 ? null : await this.need(inbox.map((u) => u.id));
		return this.api.batchTasks({
			...(batch.add === undefined ? {} : { add: batch.add.map((t) => this.created(t)) }),
			...(batch.update === undefined ? {} : { update: batch.update.map((t) => (t.projectId === INBOX_ALIAS ? { ...t, projectId: real! } : t)) }),
		});
	}

	createProject(project: Parameters<TickTickApi["createProject"]>[0]): Promise<TtProject> {
		return this.api.createProject(project);
	}

	async createColumn(projectId: string, name: string): Promise<TtColumn> {
		return this.column(await this.api.createColumn(projectId === INBOX_ALIAS ? await this.need([]) : projectId, name));
	}

	listTags(): ReturnType<TickTickApi["listTags"]> {
		return this.api.listTags();
	}

	createTag(tag: Parameters<TickTickApi["createTag"]>[0]): Promise<void> {
		return this.api.createTag(tag);
	}
}
