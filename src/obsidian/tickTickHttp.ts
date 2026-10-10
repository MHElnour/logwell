import { requestUrl, type RequestUrlParam } from "obsidian";
import { TickTickError, type TickTickApi, type TickTickErrorKind, type TickTickSecretPort } from "../app/ports";
import type {
	TtBatch,
	TtBatchResult,
	TtColumn,
	TtCompletedQuery,
	TtMove,
	TtMoveResult,
	TtProject,
	TtProjectCreate,
	TtProjectData,
	TtTag,
	TtTagCreate,
	TtTask,
	TtTaskCreate,
	TtTaskFilter,
	TtTaskUpdate,
} from "../domain/ticktick/types";
import { isRecord } from "../domain/types";

// The TickTick Open API on Obsidian's `requestUrl`, used by the session's sync. It never retries and
// never puts the token, a header or a response body in an error.

export const TICKTICK_API_BASE = "https://api.ticktick.com/open/v1";
/**
 * A request with no answer after this long fails as a network error. `requestUrl` cannot be aborted: its
 * late answer is ignored. A write that timed out may have been applied (`maybePartial`), so the usual recovery applies.
 */
export const TICKTICK_TIMEOUT_MS = 15_000;

/** Marks the timeout inside `call`; never leaves this module. */
class RequestTimeout extends Error {}

/** The part of `requestUrl` this client uses; tests pass a fake. */
export type TickTickRequest = (param: RequestUrlParam) => Promise<{ status: number; headers: Record<string, string>; text: string }>;

type Json = Record<string, unknown>;

const TASK_STRING_FIELDS = ["content", "desc", "startDate", "dueDate", "timeZone", "parentId", "columnId", "columnName", "repeatFlag", "kind", "etag"];
const TASK_NUMBER_FIELDS = ["priority", "status", "sortOrder"];

/** A task as typed, or null when it is not one. A `null` optional field reads as absent and is dropped. */
function readTask(value: unknown): TtTask | null {
	if (!isRecord(value)) return null;
	const out: Json = {};
	for (const [key, v] of Object.entries(value)) if (v !== null) out[key] = v;
	if (typeof out.id !== "string" || typeof out.projectId !== "string" || typeof out.title !== "string") return null;
	for (const key of TASK_STRING_FIELDS) if (out[key] !== undefined && typeof out[key] !== "string") return null;
	for (const key of TASK_NUMBER_FIELDS) if (out[key] !== undefined && typeof out[key] !== "number") return null;
	if (out.isAllDay !== undefined && typeof out.isAllDay !== "boolean") return null;
	if (out.tags !== undefined && !(Array.isArray(out.tags) && out.tags.every((t) => typeof t === "string"))) return null;
	return out as unknown as TtTask;
}

function isProject(value: unknown): value is TtProject {
	return isRecord(value) && typeof value.id === "string" && typeof value.name === "string";
}

function bad(message: string, write: boolean, status: number | null = null): TickTickError {
	// A write that answered with something unreadable may have been applied.
	return new TickTickError("bad-response", message, { status, maybePartial: write });
}

function array(value: unknown, write: boolean): unknown[] {
	if (!Array.isArray(value)) throw bad("TickTick: unexpected answer (a list was expected).", write);
	return value;
}

function tasks(value: unknown, write: boolean): TtTask[] {
	return array(value, write).map((v) => task(v, write));
}

function task(value: unknown, write: boolean): TtTask {
	const t = readTask(value);
	if (t === null) throw bad("TickTick: unexpected answer (a task was not readable).", write);
	return t;
}

function project(value: unknown, write: boolean): TtProject {
	if (!isProject(value)) throw bad("TickTick: unexpected answer (a project was not readable).", write);
	return value;
}

function column(value: unknown, projectId: string, write: boolean): TtColumn {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
		throw bad("TickTick: unexpected answer (a section was not readable).", write);
	}
	const sortOrder = typeof value.sortOrder === "number" ? { sortOrder: value.sortOrder } : {};
	return { id: value.id, projectId: typeof value.projectId === "string" ? value.projectId : projectId, name: value.name, ...sortOrder };
}

/**
 * A tag of `GET /tag`: name, label (the name when missing) and parent; the rest is dropped. An unreadable one is null
 * and skipped: the endpoint is undocumented, and one odd record must not stop the sync.
 */
function tag(value: unknown): TtTag | null {
	if (!isRecord(value) || typeof value.name !== "string" || value.name === "") return null;
	const label = typeof value.label === "string" ? value.label : value.name;
	return typeof value.parent === "string" && value.parent !== "" ? { name: value.name, label, parent: value.parent } : { name: value.name, label };
}

function projectData(value: unknown, projectId: string): TtProjectData {
	if (!isRecord(value)) throw bad("TickTick: unexpected answer (project data was expected).", false);
	// An empty project may leave the lists out.
	const taskList = value.tasks === undefined || value.tasks === null ? [] : tasks(value.tasks, false);
	const columnList = value.columns === undefined || value.columns === null ? [] : array(value.columns, false).map((c) => column(c, projectId, false));
	// The Inbox's answer has no `project` (only tasks and columns): the requested id stands in for it. Tasks and columns
	// stay strictly checked.
	const proj = value.project === undefined || value.project === null ? { id: projectId, name: "" } : project(value.project, false);
	return { project: proj, tasks: taskList, columns: columnList };
}

function moveResults(value: unknown): TtMoveResult[] {
	return array(value, true).map((entry) => {
		if (!isRecord(entry) || typeof entry.id !== "string") throw bad("TickTick: unexpected answer (a moved task was not readable).", true);
		return typeof entry.etag === "string" ? { id: entry.id, etag: entry.etag } : { id: entry.id };
	});
}

function batchResult(value: unknown): TtBatchResult {
	if (!isRecord(value)) throw bad("TickTick: unexpected answer (a batch result was expected).", true);
	const id2etag = value.id2etag ?? {};
	const id2error = value.id2error ?? {};
	if (!isRecord(id2etag) || !isRecord(id2error)) throw bad("TickTick: unexpected answer (a batch result was not readable).", true);
	const etags: Record<string, string> = {};
	for (const [id, etag] of Object.entries(id2etag)) {
		if (typeof etag !== "string") throw bad("TickTick: unexpected answer (a batch etag was not readable).", true);
		etags[id] = etag;
	}
	return { id2etag: etags, id2error };
}

function retryAfterSeconds(headers: Record<string, string>): number | null {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() !== "retry-after") continue;
		const text = value.trim();
		return /^\d+$/u.test(text) ? Number(text) : null;
	}
	return null;
}

const seg = encodeURIComponent;

export class TickTickHttp implements TickTickApi {
	private readonly timeoutMs: number;

	constructor(
		/** The token is read from `secret` on every request, so a changed or cleared token takes effect at once. */
		private readonly secret: Pick<TickTickSecretPort, "get">,
		private readonly request: TickTickRequest = requestUrl,
		options: { timeoutMs?: number } = {},
	) {
		this.timeoutMs = options.timeoutMs ?? TICKTICK_TIMEOUT_MS;
	}

	/** The request, or a `RequestTimeout` after `timeoutMs`; the timer is cleared either way. */
	private async timed<T>(request: Promise<T>): Promise<T> {
		let timer: number | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = window.setTimeout(() => reject(new RequestTimeout()), this.timeoutMs);
		});
		try {
			return await Promise.race([request, timeout]);
		} finally {
			window.clearTimeout(timer);
		}
	}

	listProjects(): Promise<TtProject[]> {
		return this.call("GET", "/project", undefined, false).then((v) => array(v, false).map((p) => project(p, false)));
	}

	getProjectData(projectId: string): Promise<TtProjectData> {
		return this.call("GET", `/project/${seg(projectId)}/data`, undefined, false).then((v) => projectData(v, projectId));
	}

	listCompleted(query: TtCompletedQuery): Promise<TtTask[]> {
		return this.call("POST", "/task/completed", query, false).then((v) => tasks(v, false));
	}

	filterTasks(filter: TtTaskFilter): Promise<TtTask[]> {
		return this.call("POST", "/task/filter", filter, false).then((v) => tasks(v, false));
	}

	getTask(projectId: string, taskId: string): Promise<TtTask> {
		return this.call("GET", `/project/${seg(projectId)}/task/${seg(taskId)}`, undefined, false).then((v) => task(v, false));
	}

	createTask(input: TtTaskCreate): Promise<TtTask> {
		return this.call("POST", "/task", input, true).then((v) => task(v, true));
	}

	updateTask(input: TtTaskUpdate): Promise<TtTask> {
		return this.call("POST", `/task/${seg(input.id)}`, input, true).then((v) => task(v, true));
	}

	async completeTask(projectId: string, taskId: string): Promise<void> {
		await this.call("POST", `/project/${seg(projectId)}/task/${seg(taskId)}/complete`, undefined, true);
	}

	async deleteTask(projectId: string, taskId: string): Promise<void> {
		await this.call("DELETE", `/project/${seg(projectId)}/task/${seg(taskId)}`, undefined, true);
	}

	moveTasks(moves: TtMove[]): Promise<TtMoveResult[]> {
		return this.call("POST", "/task/move", moves, true).then(moveResults);
	}

	batchTasks(batch: TtBatch): Promise<TtBatchResult> {
		return this.call("POST", "/task/batch", batch, true).then(batchResult);
	}

	createProject(input: TtProjectCreate): Promise<TtProject> {
		return this.call("POST", "/project", input, true).then((v) => project(v, true));
	}

	createColumn(projectId: string, name: string): Promise<TtColumn> {
		return this.call("POST", `/project/${seg(projectId)}/column`, { name }, true).then((v) => column(v, projectId, true));
	}

	listTags(): Promise<TtTag[]> {
		return this.call("GET", "/tag", undefined, false).then((v) => array(v, false).flatMap((t) => tag(t) ?? []));
	}

	/** The answer is not read: an existing name is a silent no-op that may answer with the other tag, or nothing. */
	async createTag(input: TtTagCreate): Promise<void> {
		await this.call("POST", "/tag", input, true);
	}

	/** One request. Resolves with the parsed JSON body (undefined for an empty one) or throws a `TickTickError`. */
	private async call(method: "GET" | "POST" | "DELETE", path: string, body: unknown, write: boolean): Promise<unknown> {
		const token = this.secret.get();
		if (token === null || token === "") throw new TickTickError("unauthorized", "TickTick: no API token is set.");

		let res: { status: number; headers: Record<string, string>; text: string };
		try {
			res = await this.timed(
				this.request({
					url: `${TICKTICK_API_BASE}${path}`,
					method,
					headers: { Authorization: `Bearer ${token}` },
					contentType: "application/json",
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
					throw: false,
				}),
			);
		} catch (err) {
			if (err instanceof RequestTimeout) {
				throw new TickTickError("network", `TickTick: no answer within ${Math.round(this.timeoutMs / 1000)} s (network error).`, { maybePartial: write });
			}
			// The cause is dropped on purpose: it can carry the request, which holds the token.
			throw new TickTickError("network", "TickTick: no answer (network error).", { maybePartial: write });
		}

		const { status } = res;
		if (status >= 200 && status < 300) return this.parse(res, write);
		const fail = (kind: TickTickErrorKind, message: string, maybePartial = false, retryAfterSec: number | null = null) =>
			new TickTickError(kind, `${message} (HTTP ${status})`, { status, maybePartial, retryAfterSec });
		if (status === 401 || status === 403) throw fail("unauthorized", "TickTick: the API token was refused");
		if (status === 404) throw fail("not-found", "TickTick: not found");
		if (status === 429) throw fail("rate-limited", "TickTick: too many requests", false, retryAfterSeconds(res.headers));
		if (status >= 500) throw fail("server", "TickTick: server error", write);
		// A 4xx is a definite rejection: nothing was applied. Anything else unexpected (3xx) is not known to be.
		throw fail("bad-response", "TickTick: unexpected answer", write && !(status >= 400 && status < 500));
	}

	private parse(res: { status: number; text: string }, write: boolean): unknown {
		let text: string;
		try {
			text = res.text;
		} catch {
			throw bad("TickTick: unreadable answer.", write, res.status);
		}
		if (text.trim() === "") return undefined;
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw bad("TickTick: unreadable answer.", write, res.status);
		}
	}
}
