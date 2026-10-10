// @vitest-environment happy-dom
import type { RequestUrlParam } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryTickTickSecret, TickTickError, type TickTickErrorKind } from "../../src/app/ports";
import type { TtTask } from "../../src/domain/ticktick/types";
import { TICKTICK_API_BASE, TICKTICK_TIMEOUT_MS, TickTickHttp, type TickTickRequest } from "../../src/obsidian/tickTickHttp";
import recorded from "../fixtures/ticktick/recorded.json";

// The TickTick client on a fake `requestUrl`, answering with recorded responses.

type Recorded = { status: number; body?: unknown; results?: unknown[] };
const responses = recorded.responses as unknown as Record<string, Recorded>;
const body = (key: string): unknown => responses[key]?.body;

const TOKEN = "tt-secret-token-123";

interface Reply {
	status?: number;
	json?: unknown;
	text?: string;
	headers?: Record<string, string>;
}

function setup(token: string | null = TOKEN) {
	const secret = new MemoryTickTickSecret();
	if (token !== null) secret.set(token);
	const calls: RequestUrlParam[] = [];
	const queue: (Reply | Error)[] = [];
	const request: TickTickRequest = (param) => {
		calls.push(param);
		const next = queue.shift();
		if (next === undefined) return Promise.reject(new Error("no reply queued"));
		if (next instanceof Error) return Promise.reject(next);
		return Promise.resolve({
			status: next.status ?? 200,
			headers: next.headers ?? {},
			text: next.text ?? (next.json === undefined ? "" : JSON.stringify(next.json)),
		});
	};
	return { api: new TickTickHttp(secret, request), secret, calls, queue };
}

function first(calls: RequestUrlParam[]): RequestUrlParam {
	const c = calls[0];
	if (c === undefined) throw new Error("no request was made");
	return c;
}

async function failure(promise: Promise<unknown>): Promise<TickTickError> {
	try {
		await promise;
	} catch (e) {
		if (e instanceof TickTickError) return e;
		throw e;
	}
	throw new Error("expected a TickTickError");
}

describe("requests", () => {
	it("listProjects: GET /project with the Bearer token and JSON", async () => {
		const { api, calls, queue } = setup();
		queue.push({ json: [{ id: "p1", name: "Home", kind: "TASK" }] });
		expect(await api.listProjects()).toEqual([{ id: "p1", name: "Home", kind: "TASK" }]);
		const c = first(calls);
		expect(c.method).toBe("GET");
		expect(c.url).toBe(`${TICKTICK_API_BASE}/project`);
		expect(c.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
		expect(c.contentType).toBe("application/json");
		expect(c.body).toBeUndefined();
		expect(c.throw).toBe(false);
	});

	it("getProjectData: GET /project/{id}/data returns the tasks and columns of the recorded project", async () => {
		const { api, calls, queue } = setup();
		queue.push({ json: body("10-tasks/05-get-sandbox-project-data") });
		const data = await api.getProjectData("6ac694f38f084dbfa9c80388");
		expect(first(calls).method).toBe("GET");
		expect(first(calls).url).toBe(`${TICKTICK_API_BASE}/project/6ac694f38f084dbfa9c80388/data`);
		expect(data.project.name).toBe("Logwell API sandbox");
		expect(data.tasks.map((t) => t.title)).toEqual(["Dentist", "Call the bank", "Find the account number"]);
		expect(data.columns).toEqual([]);
	});

	it("getProjectData accepts the inbox alias and a project without the lists", async () => {
		const { api, calls, queue } = setup();
		queue.push({ json: { project: { id: "inbox123", name: "Inbox" } } });
		const data = await api.getProjectData("inbox");
		expect(first(calls).url).toBe(`${TICKTICK_API_BASE}/project/inbox/data`);
		expect(data).toEqual({ project: { id: "inbox123", name: "Inbox" }, tasks: [], columns: [] });
	});

	it("getProjectData reads the Inbox's answer, which has no project key, with the requested id standing in", async () => {
		const { api, queue } = setup();
		queue.push({ json: { tasks: [{ id: "t1", projectId: "inbox123", title: "Call the bank" }], columns: [] } });
		const data = await api.getProjectData("inbox");
		expect(data.project).toEqual({ id: "inbox", name: "" });
		expect(data.tasks.map((t) => t.projectId)).toEqual(["inbox123"]);
		queue.push({ json: {} });
		expect(await api.getProjectData("inbox")).toEqual({ project: { id: "inbox", name: "" }, tasks: [], columns: [] });
	});

	it("getProjectData still checks the tasks and columns, and a project that is present", async () => {
		const { api, queue } = setup();
		queue.push({ json: { tasks: [{ id: "t1" }] } });
		await expect(api.getProjectData("inbox")).rejects.toMatchObject({ kind: "bad-response" });
		queue.push({ json: { project: { id: 5 }, tasks: [] } });
		await expect(api.getProjectData("p")).rejects.toMatchObject({ kind: "bad-response" });
	});

	it("getProjectData reads the sections of a sectioned project", async () => {
		const { api, queue } = setup();
		queue.push({
			json: {
				project: { id: "p1", name: "Work", viewMode: "kanban" },
				tasks: [{ id: "t1", projectId: "p1", title: "Plan", columnId: "c1", columnName: "Doing" }],
				columns: [{ id: "c1", projectId: "p1", name: "Doing", sortOrder: 0 }],
			},
		});
		const data = await api.getProjectData("p1");
		expect(data.columns).toEqual([{ id: "c1", projectId: "p1", name: "Doing", sortOrder: 0 }]);
		expect(data.tasks[0]?.columnId).toBe("c1");
	});

	it("listCompleted: POST /task/completed with the window", async () => {
		const { api, calls, queue } = setup();
		queue.push({ json: body("10-tasks/09-list-completed-in-window") });
		const query = { projectIds: ["p1"], startDate: "2026-10-06T00:00:00+0300", endDate: "2026-10-14T23:59:00+0300" };
		const list = await api.listCompleted(query);
		expect(first(calls).method).toBe("POST");
		expect(first(calls).url).toBe(`${TICKTICK_API_BASE}/task/completed`);
		expect(JSON.parse(first(calls).body as string)).toEqual(query);
		expect(list.map((t) => [t.title, t.status])).toEqual([["Dentist", 2]]);
	});

	it("filterTasks: POST /task/filter with the filter", async () => {
		const { api, calls, queue } = setup();
		queue.push({ json: body("20-change-detection/05-filter-tasks-in-sandbox") });
		const list = await api.filterTasks({ projectIds: ["p1"], status: [0] });
		expect(first(calls).url).toBe(`${TICKTICK_API_BASE}/task/filter`);
		expect(JSON.parse(first(calls).body as string)).toEqual({ projectIds: ["p1"], status: [0] });
		expect(list).toHaveLength(4);
	});

	it("getTask: GET /project/{p}/task/{t}", async () => {
		const { api, calls, queue } = setup();
		queue.push({ json: body("10-tasks/02-get-task") });
		const t = await api.getTask("6ac694f38f084dbfa9c80388", "6ac694f78f08797283361f3b");
		expect(first(calls).method).toBe("GET");
		expect(first(calls).url).toBe(`${TICKTICK_API_BASE}/project/6ac694f38f084dbfa9c80388/task/6ac694f78f08797283361f3b`);
		expect(t.title).toBe("Call the bank");
		expect(t.etag).toBe("fvfm0dle");
	});

	it("encodes ids that are not url safe", async () => {
		const { api, calls, queue } = setup();
		queue.push({ json: body("10-tasks/02-get-task") });
		await api.getTask("a/b", "c d?");
		expect(first(calls).url).toBe(`${TICKTICK_API_BASE}/project/a%2Fb/task/c%20d%3F`);
	});

	it("createTask: POST /task with the task", async () => {
		const { api, calls, queue } = setup();
		queue.push({ json: body("10-tasks/01-create-all-day-task") });
		const input = { projectId: "p1", title: "Call the bank", priority: 5, isAllDay: true, startDate: "2026-10-08T00:00:00+0300", dueDate: "2026-10-08T00:00:00+0300", timeZone: "Europe/Moscow" };
		const t = await api.createTask(input);
		expect(first(calls).method).toBe("POST");
		expect(first(calls).url).toBe(`${TICKTICK_API_BASE}/task`);
		expect(JSON.parse(first(calls).body as string)).toEqual(input);
		expect(t.id).toBe("6ac694f78f08797283361f3b");
	});

	it("updateTask: POST /task/{id} with id and project in the body", async () => {
		const { api, calls, queue } = setup();
		queue.push({ json: body("10-tasks/06-partial-update-title-only") });
		const t = await api.updateTask({ id: "t1", projectId: "p1", title: "Call the bank (renamed)" });
		expect(first(calls).method).toBe("POST");
		expect(first(calls).url).toBe(`${TICKTICK_API_BASE}/task/t1`);
		expect(JSON.parse(first(calls).body as string)).toEqual({ id: "t1", projectId: "p1", title: "Call the bank (renamed)" });
		expect(t.title).toBe("Call the bank (renamed)");
	});

	it("deleteTask: DELETE /project/{p}/task/{t}", async () => {
		const { api, calls, queue } = setup();
		queue.push({ text: "" });
		await api.deleteTask("p1", "t1");
		expect(first(calls).method).toBe("DELETE");
		expect(first(calls).url).toBe(`${TICKTICK_API_BASE}/project/p1/task/t1`);
	});

	it("moveTasks: POST /task/move with the list, accepting the inbox alias", async () => {
		const { api, calls, queue } = setup();
		queue.push({ json: body("20-change-detection/07-move-task-to-inbox") });
		const moves = [{ fromProjectId: "p1", toProjectId: "inbox", taskId: "t1" }];
		const out = await api.moveTasks(moves);
		expect(first(calls).url).toBe(`${TICKTICK_API_BASE}/task/move`);
		expect(JSON.parse(first(calls).body as string)).toEqual(moves);
		expect(out).toEqual([{ id: "6ac694f78f08797283361f3b", etag: "p59fc3ha" }]);
	});

	it("batchTasks: POST /task/batch returns the etags and the errors", async () => {
		const { api, calls, queue } = setup();
		queue.push({ json: body("20-change-detection/04-batch-add-and-update") });
		const batch = { add: [{ projectId: "p1", title: "Buy milk" }], update: [{ id: "t1", projectId: "p1", title: "x" }] };
		const out = await api.batchTasks(batch);
		expect(first(calls).url).toBe(`${TICKTICK_API_BASE}/task/batch`);
		expect(JSON.parse(first(calls).body as string)).toEqual(batch);
		expect(Object.keys(out.id2etag)).toHaveLength(3);
		expect(out.id2error).toEqual({});
	});

	it("createProject: POST /project", async () => {
		const { api, calls, queue } = setup();
		queue.push({ json: responses["probe/01-create-probe-project"]?.results?.[0] });
		const p = await api.createProject({ name: "Logwell probe", viewMode: "kanban" });
		expect(first(calls).method).toBe("POST");
		expect(first(calls).url).toBe(`${TICKTICK_API_BASE}/project`);
		expect(JSON.parse(first(calls).body as string)).toEqual({ name: "Logwell probe", viewMode: "kanban" });
		expect(p.id).toBe("6ac748da8f089f3769e4fd94");
	});

	it("createColumn: POST /project/{p}/column with the name", async () => {
		const { api, calls, queue } = setup();
		queue.push({ json: responses["probe/09-col-create"]?.results?.[0] });
		const c = await api.createColumn("6ac748da8f089f3769e4fd94", "Probe section");
		expect(first(calls).url).toBe(`${TICKTICK_API_BASE}/project/6ac748da8f089f3769e4fd94/column`);
		expect(JSON.parse(first(calls).body as string)).toEqual({ name: "Probe section" });
		expect(c).toEqual({ id: "6ac748e58f088b3af84c1412", projectId: "6ac748da8f089f3769e4fd94", name: "Probe section", sortOrder: 0 });
	});

	it("reads a checklist and a repeating task as returned", async () => {
		const { api, queue } = setup();
		queue.push({ json: [responses["probe/12-checklist-create"]?.results?.[0], body("30-recurrence/01-create-weekly-repeating-task")] });
		const list: TtTask[] = await api.filterTasks({});
		expect(list[0]?.kind).toBe("CHECKLIST");
		expect(list[0]?.items).toHaveLength(2);
		expect(list[1]?.repeatFlag).toBe("RRULE:FREQ=WEEKLY;INTERVAL=1");
	});

	it("reads a null optional field as absent instead of rejecting the list", async () => {
		const { api, queue } = setup();
		const base = body("10-tasks/02-get-task") as Record<string, unknown>;
		queue.push({
			json: [
				{ ...base, content: null, repeatFlag: null, parentId: null, tags: null, isAllDay: null, priority: null, items: null },
				{ ...base, id: "t2" },
			],
		});
		const list = await api.filterTasks({});
		expect(list).toHaveLength(2);
		const t = list[0] as unknown as Record<string, unknown>;
		for (const key of ["content", "repeatFlag", "parentId", "tags", "isAllDay", "priority", "items"]) expect(key in t).toBe(false);
		expect(t.title).toBe("Call the bank");
	});

	it("still rejects a task whose id, project or title is null", async () => {
		const { api, queue } = setup();
		queue.push({ json: [{ id: "t", projectId: "p", title: null }] });
		expect((await failure(api.filterTasks({}))).kind).toBe("bad-response");
	});

	it("makes exactly one request per call (no retries)", async () => {
		const { api, calls, queue } = setup();
		queue.push({ status: 500, text: "boom" }, { json: [] });
		await failure(api.listProjects());
		expect(calls).toHaveLength(1);
	});
});

describe("the token", () => {
	it("makes no request without a token", async () => {
		const { api, calls } = setup(null);
		const e = await failure(api.listProjects());
		expect(e.kind).toBe("unauthorized");
		expect(e.maybePartial).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("treats an empty token as none", async () => {
		const { api, secret, calls } = setup();
		secret.set("");
		expect((await failure(api.createTask({ projectId: "p", title: "x" }))).kind).toBe("unauthorized");
		expect(calls).toHaveLength(0);
	});

	it("reads the token on every request", async () => {
		const { api, secret, calls, queue } = setup("first");
		queue.push({ json: [] }, { json: [] });
		await api.listProjects();
		secret.set("second");
		await api.listProjects();
		expect(calls.map((c) => c.headers?.Authorization)).toEqual(["Bearer first", "Bearer second"]);
		secret.clear();
		expect((await failure(api.listProjects())).kind).toBe("unauthorized");
		expect(calls).toHaveLength(2);
	});

	it("never appears in an error", async () => {
		const outcomes: (Reply | Error)[] = [
			{ status: 401, text: `{"error":"bad ${TOKEN}"}` },
			{ status: 404, text: TOKEN },
			{ status: 429, headers: { "Retry-After": "5" }, text: TOKEN },
			{ status: 500, text: TOKEN },
			{ status: 418, text: TOKEN },
			{ status: 200, text: `not json ${TOKEN}` },
			{ status: 200, json: { not: "a list" } },
			new Error(`connect failed for Authorization: Bearer ${TOKEN}`),
		];
		for (const outcome of outcomes) {
			const { api, queue } = setup();
			queue.push(outcome);
			const e = await failure(api.listProjects());
			const dump = [e.message, e.stack ?? "", e.name, JSON.stringify(e), JSON.stringify(Object.getOwnPropertyNames(e).map((k) => (e as unknown as Record<string, unknown>)[k]))].join("\n");
			expect(dump).not.toContain(TOKEN);
			expect(e.cause).toBeUndefined();
		}
	});
});

describe("errors", () => {
	async function kindOf(reply: Reply | Error, call: (api: TickTickHttp) => Promise<unknown> = (api) => api.listProjects()) {
		const { api, queue } = setup();
		queue.push(reply);
		return failure(call(api));
	}

	it("401 and 403 are unauthorized", async () => {
		expect((await kindOf({ status: 401 })).kind).toBe("unauthorized");
		expect((await kindOf({ status: 403 })).kind).toBe("unauthorized");
		expect((await kindOf({ status: 401 })).status).toBe(401);
	});

	it("404 is not-found (the recorded wrong-project answer)", async () => {
		const e = await kindOf({ status: 404, json: body("20-change-detection/09-get-task-with-wrong-project") }, (api) => api.getTask("p", "t"));
		expect(e.kind).toBe("not-found");
		expect(e.status).toBe(404);
		expect(e.maybePartial).toBe(false);
	});

	it("429 is rate-limited with Retry-After seconds, whatever the header case", async () => {
		const a = await kindOf({ status: 429, headers: { "Retry-After": "30" } });
		expect(a.kind).toBe("rate-limited");
		expect(a.retryAfterSec).toBe(30);
		expect((await kindOf({ status: 429, headers: { "retry-after": " 7 " } })).retryAfterSec).toBe(7);
	});

	it("429 without a usable Retry-After has none", async () => {
		expect((await kindOf({ status: 429 })).retryAfterSec).toBeNull();
		expect((await kindOf({ status: 429, headers: { "Retry-After": "soon" } })).retryAfterSec).toBeNull();
		expect((await kindOf({ status: 429, headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" } })).retryAfterSec).toBeNull();
	});

	it("429 on a write is not partial", async () => {
		const e = await kindOf({ status: 429 }, (api) => api.batchTasks({ add: [] }));
		expect(e.kind).toBe("rate-limited");
		expect(e.maybePartial).toBe(false);
	});

	it("5xx is server; on a write it may be partial (the recorded 500 on a batch)", async () => {
		const read = await kindOf({ status: 500 }, (api) => api.getProjectData("p"));
		expect(read.kind).toBe("server");
		expect(read.maybePartial).toBe(false);
		const batch = await kindOf({ status: 500, json: { ok: 0 } }, (api) => api.batchTasks({ add: [{ projectId: "p", title: "x" }] }));
		expect(batch.kind).toBe("server");
		expect(batch.maybePartial).toBe(true);
		expect((await kindOf({ status: 503 }, (api) => api.createTask({ projectId: "p", title: "x" }))).maybePartial).toBe(true);
		expect((await kindOf({ status: 502 }, (api) => api.deleteTask("p", "t"))).maybePartial).toBe(true);
	});

	it("a request that fails is a network error; on a write it may be partial", async () => {
		const read = await kindOf(new Error("net::ERR_INTERNET_DISCONNECTED"));
		expect(read.kind).toBe("network");
		expect(read.maybePartial).toBe(false);
		const write = await kindOf(new Error("timeout"), (api) => api.updateTask({ id: "t", projectId: "p", title: "x" }));
		expect(write.kind).toBe("network");
		expect(write.maybePartial).toBe(true);
	});

	it("an unparseable body is bad-response", async () => {
		expect((await kindOf({ text: "<html>gateway</html>" })).kind).toBe("bad-response");
		expect((await kindOf({ text: "{" })).kind).toBe("bad-response");
	});

	it("a body of the wrong shape is bad-response", async () => {
		expect((await kindOf({ json: { projects: [] } })).kind).toBe("bad-response");
		expect((await kindOf({ json: [{ id: 1, name: "x" }] })).kind).toBe("bad-response");
		expect((await kindOf({ json: { tasks: "none" } }, (api) => api.getProjectData("p"))).kind).toBe("bad-response");
		expect((await kindOf({ json: { project: { id: "p", name: "x" }, tasks: [{ id: "t" }] } }, (api) => api.getProjectData("p"))).kind).toBe("bad-response");
		expect((await kindOf({ json: { id: "t", projectId: "p", title: "x", priority: "high" } }, (api) => api.getTask("p", "t"))).kind).toBe("bad-response");
		expect((await kindOf({ json: { id: "t", projectId: "p", title: "x", dueDate: 5 } }, (api) => api.getTask("p", "t"))).kind).toBe("bad-response");
		expect((await kindOf({ json: [{ nope: true }] }, (api) => api.moveTasks([]))).kind).toBe("bad-response");
		expect((await kindOf({ json: { id2etag: [] } }, (api) => api.batchTasks({}))).kind).toBe("bad-response");
		expect((await kindOf({ json: {} }, (api) => api.createColumn("p", "x"))).kind).toBe("bad-response");
	});

	it("an unreadable answer to a write may be partial; to a read it is not", async () => {
		expect((await kindOf({ text: "oops" }, (api) => api.createTask({ projectId: "p", title: "x" }))).maybePartial).toBe(true);
		expect((await kindOf({ text: "oops" })).maybePartial).toBe(false);
	});

	it("any other status is bad-response", async () => {
		for (const status of [301, 400, 405, 418]) {
			const e = await kindOf({ status });
			expect(e.kind satisfies TickTickErrorKind).toBe("bad-response");
			expect(e.status).toBe(status);
		}
	});

	it("a 4xx on a write is a definite rejection, not partial; a 3xx or 5xx is not known to be", async () => {
		const create = (api: TickTickHttp) => api.createTask({ projectId: "p", title: "x" });
		for (const status of [400, 404, 409, 422, 429, 401, 403]) expect((await kindOf({ status }, create)).maybePartial).toBe(false);
		expect((await kindOf({ status: 301 }, create)).maybePartial).toBe(true);
		expect((await kindOf({ status: 500 }, create)).maybePartial).toBe(true);
		expect((await kindOf(new Error("reset"), create)).maybePartial).toBe(true);
		expect((await kindOf({ text: "oops" }, create)).maybePartial).toBe(true);
	});
});

describe("request timeout (issue #6)", () => {
	afterEach(() => vi.useRealTimers());

	function stalled(timeoutMs?: number) {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const secret = new MemoryTickTickSecret();
		secret.set(TOKEN);
		let answer!: (v: { status: number; headers: Record<string, string>; text: string }) => void;
		const request: TickTickRequest = () => new Promise((r) => (answer = r));
		const api = timeoutMs === undefined ? new TickTickHttp(secret, request) : new TickTickHttp(secret, request, { timeoutMs });
		return { api, answer: () => answer({ status: 200, headers: {}, text: "{}" }) };
	}

	it("a read that never answers fails after 30 s as a network error, nothing applied", async () => {
		expect(TICKTICK_TIMEOUT_MS).toBe(15_000);
		const { api } = stalled();
		const got = api.getProjectData("p1").then(
			() => null,
			(e: unknown) => e,
		);
		await vi.advanceTimersByTimeAsync(TICKTICK_TIMEOUT_MS - 1);
		let settled = false;
		void got.then(() => (settled = true));
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		const err = await got;
		expect(err).toBeInstanceOf(TickTickError);
		expect(err).toMatchObject({ kind: "network", maybePartial: false });
	});

	it("a write that never answers may have been applied, and a late answer is ignored", async () => {
		const { api, answer } = stalled(1000);
		const got = api.createTask({ projectId: "p1", title: "Call the bank" }).then(
			() => null,
			(e: unknown) => e,
		);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await got).toMatchObject({ kind: "network", maybePartial: true });
		answer();
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("an answer in time clears the timer", async () => {
		const { api, answer } = stalled(1000);
		const got = api.getProjectData("p1").catch((e: unknown) => e);
		answer();
		await got;
		expect(vi.getTimerCount()).toBe(0);
	});
});
