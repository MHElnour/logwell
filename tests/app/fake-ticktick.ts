import { DateTime } from "luxon";
import { type TickTickApi, TickTickError } from "../../src/app/ports";
import type {
	TtBatch,
	TtBatchResult,
	TtChecklistItem,
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
} from "../../src/domain/ticktick/types";
import { TICKTICK_COMPLETED_MAX } from "../../src/domain/ticktick/types";
import type { Clock } from "../../src/domain/ports";

// An in-memory TickTick Open API for the sync tests. Behaves like the recordings in
// tests/fixtures/ticktick/recorded.json: the etag changes on every write, a deleted task still reads (status 0) under
// its project, a task under the wrong project is not found, "won't do" (-1) is in neither the project data nor the
// completed list, ids are TickTick's own. Errors are injected per call.

export type FakeMethod = keyof TickTickApi;

interface Injected {
	method: FakeMethod;
	error: TickTickError;
	/** Apply the write first, then throw (a partly or fully applied write, `maybePartial`). */
	applyFirst: boolean;
	/** For a batch: how many of its updates are applied before the throw. */
	partialCount?: number;
}

interface Stored extends TtTask {
	deleted?: boolean;
}

const TT_FORMAT = "yyyy-MM-dd'T'HH:mm:ss.SSSZZZ";

export class FakeTickTick implements TickTickApi {
	readonly projects = new Map<string, TtProject>();
	readonly tasks = new Map<string, Stored>();
	readonly columns = new Map<string, TtColumn>();
	/** The account's tag records by name (lowercase; unique across the account). */
	readonly tags = new Map<string, TtTag>();
	/**
	 * Open tasks a project may hold (TickTick's free plan: 99). A write past it fails like the real API: HTTP 500,
	 * possibly applied in part.
	 */
	openLimit = Number.POSITIVE_INFINITY;
	/** The most tasks one `listCompleted` returns, like the real API; past it the answer is cut. */
	completedCap = TICKTICK_COMPLETED_MAX;
	/** Which completions a cut `listCompleted` keeps, the newest or the oldest: the real order is not known. */
	completedOrder: "newest" | "oldest" = "newest";
	/** Whether `listCompleted` includes a completion exactly at its start or end time: the real bounds are not known. */
	completedBounds: { start: "inclusive" | "exclusive"; end: "inclusive" | "exclusive" } = { start: "inclusive", end: "inclusive" };
	/** Tasks the project data leaves out although they are open there (a delay or a limit of TickTick's). */
	readonly omitted = new Set<string>();
	/** Completion times parsed once: `listCompleted` reads thousands per call in the window tests. */
	private readonly completedMs = new Map<string, number>();
	/** Every call, in order: "method" or "method:arg". */
	readonly calls: string[] = [];
	private readonly injected: Injected[] = [];
	private seq = 0;
	/** Resolves before each call when set: lets a test hold a sync in flight. */
	gate: Promise<void> | null = null;
	/**
	 * Called at the start of every call, before any injected failure. May throw (the call then rejects with it) or
	 * return a promise the call waits for (holds that one call in flight).
	 */
	onCall: ((method: FakeMethod) => void | Promise<void>) | null = null;

	constructor(private readonly clock: Clock) {}

	// -- test helpers --------------------------------------------------------------------------------------------

	private nextId(): string {
		this.seq++;
		return `tt${this.seq.toString(16).padStart(22, "0")}`;
	}

	private nextEtag(): string {
		this.seq++;
		return `e${this.seq.toString(36).padStart(7, "0")}`;
	}

	private now(): string {
		return DateTime.fromJSDate(this.clock.now(), { zone: "utc" }).toFormat(TT_FORMAT);
	}

	/** The real id of TickTick's Inbox when `addInbox` was called. */
	inboxId: string | null = null;

	/**
	 * Where a create with no project goes: the Inbox (the default, as probed), or another project, for an account whose
	 * default list is not the Inbox.
	 */
	noProjectGoesTo: string | null = null;

	/**
	 * TickTick's Inbox: a project `inbox<digits>` that is not in the project list. As probed against the real API on
	 * 2026-10-08, the alias `inbox` works for project data, completed tasks, moves, getting a task, a single task update
	 * and deleting a task; it fails (404) for a batch update, and completing a task or creating a column or a task with
	 * it is not supported here. Every task carries the real id, and the data of the alias has no project of its own (the
	 * id asked for stands in).
	 */
	addInbox(): TtProject {
		const project: TtProject = { id: `inbox${100000 + ++this.seq}`, name: "Inbox", kind: "TASK", viewMode: "list" };
		this.projects.set(project.id, project);
		this.inboxId = project.id;
		return project;
	}

	/** `inbox` read as the real Inbox id, for the calls that accept the alias. */
	private alias(id: string): string {
		return id === "inbox" && this.inboxId !== null ? this.inboxId : id;
	}

	addProject(name: string, kind = "TASK"): TtProject {
		const project: TtProject = { id: this.nextId(), name, kind, viewMode: "list" };
		this.projects.set(project.id, project);
		return project;
	}

	addColumn(projectId: string, name: string): TtColumn {
		const column: TtColumn = { id: this.nextId(), projectId, name };
		this.columns.set(column.id, column);
		return column;
	}

	/** A tag made in the TickTick app. */
	addTag(name: string, label = name, parent?: string): TtTag {
		const tag: TtTag = { name: name.toLowerCase(), label, ...(parent === undefined ? {} : { parent }) };
		this.tags.set(tag.name, tag);
		return { ...tag };
	}

	/** Items with ids: new ones for those without (all of them with `renew`, as on every update). */
	private withItemIds(items: readonly Partial<TtChecklistItem>[], renew = false): TtChecklistItem[] {
		return items.map((i) => ({ title: "", status: 0, ...i, id: renew || i.id === undefined ? this.nextId() : i.id }));
	}

	/** Every write of the fake, in order: the items sent with each update, as sent (for checks of what was sent). */
	readonly sentItems: unknown[][] = [];

	/** A task made in the TickTick app. Checklist items without an id get one. */
	add(projectId: string, fields: Partial<TtTask> & { title: string }): TtTask {
		const items = fields.items === undefined ? {} : { items: this.withItemIds(fields.items) };
		const task: Stored = { status: 0, priority: 0, kind: "TEXT", timeZone: "Europe/Berlin", isAllDay: false, ...fields, ...items, id: this.nextId(), projectId, etag: this.nextEtag() };
		this.tasks.set(task.id, task);
		return { ...task };
	}

	/** An edit in the TickTick app: changes the fields and the etag. Checklist items without an id get one. */
	edit(id: string, patch: Partial<TtTask>): void {
		const t = this.must(id);
		// An edit there gives every item a new id too.
		const all = patch.items ?? t.items;
		const items = all === undefined ? {} : { items: this.withItemIds(all, true) };
		this.tasks.set(id, { ...t, ...patch, ...items, etag: this.nextEtag(), ...(patch.status === 2 || patch.status === -1 ? { completedTime: this.now() } : {}) });
	}

	/** A deletion in the TickTick app. */
	remove(id: string): void {
		const t = this.must(id);
		this.tasks.set(id, { ...t, deleted: true, status: 0, etag: this.nextEtag() });
	}

	/** A move in the TickTick app. */
	moveTo(id: string, projectId: string): void {
		const t = this.must(id);
		this.tasks.set(id, { ...t, projectId, columnId: undefined, etag: this.nextEtag() });
	}

	get(id: string): TtTask | undefined {
		const t = this.tasks.get(id);
		return t === undefined ? undefined : { ...t };
	}

	/** The live (not deleted) tasks of a project, any status. */
	live(projectId: string): TtTask[] {
		return [...this.tasks.values()].filter((t) => t.projectId === projectId && t.deleted !== true).map((t) => ({ ...t }));
	}

	findByTitle(title: string): TtTask | undefined {
		return [...this.tasks.values()].find((t) => t.title === title && t.deleted !== true);
	}

	/** The next call of `method` fails with `error`. */
	fail(method: FakeMethod, error: TickTickError, options: { applyFirst?: boolean; partialCount?: number } = {}): void {
		this.injected.push({ method, error, applyFirst: options.applyFirst ?? false, ...(options.partialCount === undefined ? {} : { partialCount: options.partialCount }) });
	}

	count(method: FakeMethod): number {
		return this.calls.filter((c) => c === method || c.startsWith(`${method}:`)).length;
	}

	private must(id: string): Stored {
		const t = this.tasks.get(id);
		if (t === undefined) throw new Error(`fake: no task ${id}`);
		return t;
	}

	private async enter(method: FakeMethod, arg?: string): Promise<Injected | null> {
		if (this.gate !== null) await this.gate;
		this.calls.push(arg === undefined ? method : `${method}:${arg}`);
		const hold = this.onCall?.(method);
		if (hold !== undefined) await hold;
		const i = this.injected.findIndex((x) => x.method === method);
		if (i < 0) return null;
		const [inj] = this.injected.splice(i, 1);
		if (inj !== undefined && !inj.applyFirst) throw inj.error;
		return inj ?? null;
	}

	private openCount(projectId: string): number {
		let n = 0;
		for (const t of this.tasks.values()) if (t.projectId === projectId && t.deleted !== true && (t.status ?? 0) === 0) n++;
		return n;
	}

	/** Throws when one more open task in the project would pass `openLimit`. */
	private room(projectId: string): void {
		if (this.openCount(projectId) >= this.openLimit) {
			throw new TickTickError("server", "TickTick: server error (HTTP 500)", { status: 500, maybePartial: true });
		}
	}

	private notFound(): TickTickError {
		return new TickTickError("not-found", "TickTick: not found (HTTP 404)", { status: 404 });
	}

	private copy(t: Stored): TtTask {
		const { deleted: _deleted, ...rest } = t;
		return { ...rest };
	}

	/**
	 * A partial write as TickTick applies it (probed 2026-10-08): null clears a date, an empty date string is
	 * ignored, an empty `parentId` or `columnId` clears it.
	 */
	private write(t: Stored, patch: Partial<Record<keyof TtTask, unknown>>): Stored {
		const next = { ...t } as unknown as Record<string, unknown>;
		for (const [k, v] of Object.entries(patch)) {
			if (k === "id" || v === undefined) continue;
			if ((k === "startDate" || k === "dueDate") && v === "") continue;
			if (v === null || ((k === "parentId" || k === "columnId") && v === "")) delete next[k];
			// Task tags come back lowercase; a name with no tag record creates none (probed 2026-10-08).
			else if (k === "tags" && Array.isArray(v)) next[k] = v.map((x) => String(x).toLowerCase());
			// The whole checklist, as sent: an item left out is removed, a field left out of an item is erased (probed
			// 2026-10-08). Ids are given below.
			else if (k === "items" && Array.isArray(v)) next[k] = (v as Partial<TtChecklistItem>[]).map((i) => ({ ...i }));
			else next[k] = v;
		}
		const out = next as unknown as Stored;
		// Every update gives every checklist item a new id, even when the old ids were sent (probed 2026-10-08).
		if (out.items !== undefined) out.items = this.withItemIds(out.items, true);
		if (patch.status === 2 || patch.status === -1) out.completedTime = this.now();
		out.etag = this.nextEtag();
		this.tasks.set(out.id, out);
		return out;
	}

	// -- the API ---------------------------------------------------------------------------------------------------

	async listProjects(): Promise<TtProject[]> {
		await this.enter("listProjects");
		return [...this.projects.values()].filter((p) => p.id !== this.inboxId).map((p) => ({ ...p }));
	}

	async getProjectData(asked: string): Promise<TtProjectData> {
		await this.enter("getProjectData", asked);
		const projectId = this.alias(asked);
		const project = this.projects.get(projectId);
		if (project === undefined) throw this.notFound();
		return {
			project: projectId === this.inboxId ? { id: asked, name: "" } : { ...project },
			tasks: [...this.tasks.values()].filter((t) => t.projectId === projectId && t.deleted !== true && t.status === 0 && !this.omitted.has(t.id)).map((t) => this.copy(t)),
			columns: [...this.columns.values()].filter((c) => c.projectId === projectId).map((c) => ({ ...c })),
		};
	}

	async listCompleted(query: TtCompletedQuery): Promise<TtTask[]> {
		await this.enter("listCompleted", query.projectIds.join(","));
		const projectIds = query.projectIds.map((id) => this.alias(id));
		const from = DateTime.fromISO(query.startDate).toMillis();
		const to = DateTime.fromISO(query.endDate).toMillis();
		const { start, end } = this.completedBounds;
		const sign = this.completedOrder === "newest" ? -1 : 1;
		return [...this.tasks.values()]
			.filter((t) => projectIds.includes(t.projectId) && t.deleted !== true && t.status === 2 && t.completedTime !== undefined)
			.map((t) => ({ t, at: this.completedAt(t.completedTime ?? "") }))
			.filter(({ at }) => (start === "inclusive" ? at >= from : at > from) && (end === "inclusive" ? at <= to : at < to))
			.sort((a, b) => sign * (a.at - b.at))
			.slice(0, this.completedCap)
			.map(({ t }) => this.copy(t));
	}

	private completedAt(time: string): number {
		let ms = this.completedMs.get(time);
		if (ms === undefined) {
			ms = DateTime.fromISO(time).toMillis();
			this.completedMs.set(time, ms);
		}
		return ms;
	}

	async filterTasks(filter: TtTaskFilter): Promise<TtTask[]> {
		await this.enter("filterTasks");
		return [...this.tasks.values()]
			.filter((t) => t.deleted !== true)
			.filter((t) => filter.projectIds === undefined || filter.projectIds.includes(t.projectId))
			.filter((t) => filter.status === undefined || filter.status.includes(t.status ?? 0))
			.map((t) => this.copy(t));
	}

	async getTask(projectId: string, taskId: string): Promise<TtTask> {
		await this.enter("getTask", taskId);
		const t = this.tasks.get(taskId);
		if (t === undefined || t.projectId !== this.alias(projectId)) throw this.notFound();
		return this.copy(t);
	}

	private created(input: TtTaskCreate): Stored {
		// A create with no project goes to the Inbox (documented).
		const projectId = (input.projectId as string | undefined) ?? this.noProjectGoesTo ?? this.inboxId ?? "";
		const base: Stored = { status: 0, priority: 0, kind: "TEXT", id: this.nextId(), projectId, title: input.title };
		this.tasks.set(base.id, base);
		return this.write(base, input);
	}

	async createTask(input: TtTaskCreate): Promise<TtTask> {
		const inj = await this.enter("createTask", input.title);
		const target = (input.projectId as string | undefined) ?? this.noProjectGoesTo ?? this.inboxId ?? "";
		if (!this.projects.has(target)) throw this.notFound();
		if ((input.status ?? 0) === 0) this.room(target);
		const task = this.created(input);
		if (inj !== null) throw inj.error;
		return this.copy(task);
	}

	async updateTask(input: TtTaskUpdate): Promise<TtTask> {
		const inj = await this.enter("updateTask", input.id);
		if (input.items !== undefined) this.sentItems.push(input.items.map((i) => ({ ...i })));
		const t = this.tasks.get(input.id);
		if (t === undefined || t.projectId !== this.alias(input.projectId)) throw this.notFound();
		const next = this.write(t, { ...input, projectId: t.projectId });
		if (inj !== null) throw inj.error;
		return this.copy(next);
	}

	async deleteTask(projectId: string, taskId: string): Promise<void> {
		const inj = await this.enter("deleteTask", taskId);
		const t = this.tasks.get(taskId);
		if (t === undefined || t.projectId !== this.alias(projectId) || t.deleted === true) throw this.notFound();
		this.tasks.set(taskId, { ...t, deleted: true, etag: this.nextEtag() });
		// TickTick deletes the subtasks with their parent.
		for (const sub of this.tasks.values()) {
			if (sub.parentId === taskId && sub.deleted !== true) this.tasks.set(sub.id, { ...sub, deleted: true, etag: this.nextEtag() });
		}
		if (inj !== null) throw inj.error;
	}

	async moveTasks(moves: TtMove[]): Promise<TtMoveResult[]> {
		const inj = await this.enter("moveTasks", moves.map((m) => m.taskId).join(","));
		const out: TtMoveResult[] = [];
		for (const raw of moves) {
			const m = { ...raw, fromProjectId: this.alias(raw.fromProjectId), toProjectId: this.alias(raw.toProjectId) };
			const t = this.tasks.get(m.taskId);
			if (t === undefined || t.projectId !== m.fromProjectId) throw this.notFound();
			if ((t.status ?? 0) === 0) this.room(m.toProjectId);
			const next = this.write(t, { projectId: m.toProjectId });
			delete next.columnId;
			out.push({ id: next.id, etag: next.etag ?? "" });
		}
		if (inj !== null) throw inj.error;
		return out;
	}

	async batchTasks(batch: TtBatch): Promise<TtBatchResult> {
		const inj = await this.enter("batchTasks", String((batch.add?.length ?? 0) + (batch.update?.length ?? 0)));
		const result: TtBatchResult = { id2etag: {}, id2error: {} };
		// The alias fails for a batch update: the whole call is a 404.
		if ((batch.update ?? []).some((u) => u.projectId === "inbox" && this.inboxId !== null)) throw this.notFound();
		let applied = 0;
		for (const add of batch.add ?? []) {
			const t = this.created(add);
			result.id2etag[t.id] = t.etag ?? "";
		}
		for (const up of batch.update ?? []) {
			if (inj?.partialCount !== undefined && applied >= inj.partialCount) break;
			const t = this.tasks.get(up.id);
			if (t === undefined || t.projectId !== up.projectId || t.deleted === true) {
				result.id2error[up.id] = "not found";
				continue;
			}
			if (up.status === 0 && (t.status ?? 0) !== 0) this.room(t.projectId);
			const next = this.write(t, up);
			result.id2etag[next.id] = next.etag ?? "";
			applied++;
		}
		if (inj !== null) throw inj.error;
		return result;
	}

	async createProject(project: TtProjectCreate): Promise<TtProject> {
		await this.enter("createProject", project.name);
		const p: TtProject = { id: this.nextId(), name: project.name, kind: project.kind ?? "TASK", viewMode: project.viewMode ?? "list" };
		this.projects.set(p.id, p);
		return { ...p };
	}

	async listTags(): Promise<TtTag[]> {
		await this.enter("listTags");
		return [...this.tags.values()].map((t) => ({ ...t }));
	}

	/** An existing name, under any parent, is a silent no-op (probed 2026-10-08). */
	async createTag(tag: TtTagCreate): Promise<void> {
		const inj = await this.enter("createTag", tag.name);
		const name = tag.name.toLowerCase();
		const existing = this.tags.get(name);
		const out = existing ?? { name, label: tag.label, ...(tag.parent === undefined ? {} : { parent: tag.parent.toLowerCase() }) };
		this.tags.set(name, out);
		if (inj !== null) throw inj.error;
	}

	async createColumn(projectId: string, name: string): Promise<TtColumn> {
		await this.enter("createColumn", name);
		if (!this.projects.has(projectId)) throw this.notFound();
		return { ...this.addColumn(projectId, name) };
	}
}
