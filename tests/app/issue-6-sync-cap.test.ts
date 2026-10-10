import { describe, expect, it } from "vitest";
import { isDomainError } from "../../src/domain/errors";
import { fieldHashes } from "../../src/domain/ticktick/mapping";
import type { Category, SyncLink, Task } from "../../src/domain/types";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { FakeTickTick } from "./fake-ticktick";
import { appHarness } from "./harness";
import { syncHarness } from "./sync-harness";
import { makeTask } from "../persistence/fixtures";
import { FakeClock } from "../helpers";

// A synced list holds at most 999 open tasks. Adding, moving in or reopening a task that would be
// the 1000th open task is refused; completed tasks do not count; a list with more than 999 open tasks cannot be
// linked. Pulls are never refused: TickTick enforces its own limit.

const NOW = "2026-10-01T09:59:00.000Z";
const WORK = "00000000-0000-4000-8000-00000000000a";
const HOME = "00000000-0000-4000-8000-00000000000b";
const FULL = "Can't add the task: Work is synced with TickTick and already has 999 open tasks.";

const uuid = (n: number) => `00000001-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const list = (id: string, name: string, sortKey: string): Category => ({
	id,
	name,
	icon: null,
	color: null,
	nameKey: name.toLowerCase(),
	isInbox: false,
	sortKey,
	createdAt: NOW,
	modifiedAt: NOW,
});
const listLink = (listId: string, projectId: string): SyncLink => ({
	kind: "list",
	logwellId: listId,
	ttId: projectId,
	ttProjectId: null,
	etag: null,
	base: {},
	noteBySync: false,
	lastPulledAt: NOW,
	modifiedAt: NOW,
});

interface Spec {
	/** Open tasks in Work. */
	open: number;
	/** Completed tasks in Work. */
	completed?: number;
	/** Open tasks in Home (not linked). */
	home?: number;
	/** Whether Work is linked (default true). */
	linked?: boolean;
}

/** A database with Work (linked unless told otherwise) and Home. */
function capDb(spec: Spec): string {
	const db = createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-other", now: NOW });
	const categories = new Map(db.categories);
	categories.set(WORK, list(WORK, "Work", "V1"));
	categories.set(HOME, list(HOME, "Home", "V2"));
	const tasks = new Map<string, Task>();
	let n = 0;
	const add = (categoryId: string, title: string, patch: Partial<Task> = {}) => {
		const t = makeTask(uuid(n), { title, categoryId, sortKey: `V${n.toString(36).padStart(4, "0")}`, ...patch });
		tasks.set(t.id, t);
		n++;
	};
	for (let i = 0; i < spec.open; i++) add(WORK, `Open ${i}`);
	for (let i = 0; i < (spec.completed ?? 0); i++) add(WORK, `Done ${i}`, { status: "completed", completedAt: NOW });
	for (let i = 0; i < (spec.home ?? 0); i++) add(HOME, `Home ${i}`);
	const syncLinks = new Map<string, SyncLink>();
	if (spec.linked !== false) syncLinks.set(`list:${WORK}`, listLink(WORK, "p-work"));
	return serializeDb({ ...db, categories, tasks, syncLinks });
}

async function refused(p: Promise<unknown>): Promise<void> {
	const err = await p.then(
		() => null,
		(e: unknown) => e,
	);
	expect(isDomainError(err, "SyncedListFull")).toBe(true);
	expect((err as Error).message).toBe(FULL);
}

const openIn = (h: { app: { store: { state: { tasks: ReadonlyMap<string, Task> } } } }, listId: string) =>
	[...h.app.store.state.tasks.values()].filter((t) => t.categoryId === listId && t.status === "open").length;

describe("SYNC-13: the 999 open-task cap of a synced list", () => {
	it("refuses a new task in a synced list that has 999 open tasks, and writes nothing", async () => {
		const h = await appHarness({ initial: capDb({ open: 999 }) });
		const before = h.app.store.state;
		await refused(h.app.tasks.create({ title: "One more", categoryId: WORK }));
		expect(h.app.store.state).toBe(before);
		expect(h.app.store.canUndo).toBe(false);
	});

	it("completed tasks do not count: the 999th open task is added, the 1000th is not", async () => {
		const h = await appHarness({ initial: capDb({ open: 998, completed: 40 }) });
		await h.app.tasks.create({ title: "The 999th", categoryId: WORK });
		expect(openIn(h, WORK)).toBe(999);
		await refused(h.app.tasks.create({ title: "The 1000th", categoryId: WORK }));
	});

	it("a list that is not synced has no cap", async () => {
		const h = await appHarness({ initial: capDb({ open: 999, linked: false }) });
		await h.app.tasks.create({ title: "One more", categoryId: WORK });
		expect(openIn(h, WORK)).toBe(1000);
	});

	it("refuses a subtask of a task in the full list", async () => {
		const h = await appHarness({ initial: capDb({ open: 999 }) });
		await refused(h.app.tasks.create({ title: "Sub", parentId: uuid(0) }));
	});

	it("refuses a move into the full list (category change), the subtasks counted with their parent", async () => {
		const h = await appHarness({ initial: capDb({ open: 999, home: 1 }) });
		const homeTask = uuid(999);
		await refused(h.app.tasks.update(homeTask, { categoryId: WORK }));
		expect(h.app.store.state.tasks.get(homeTask)?.categoryId).toBe(HOME);

		const h2 = await appHarness({ initial: capDb({ open: 997, home: 1 }) });
		const parent = uuid(997);
		await h2.app.tasks.create({ title: "Sub 1", parentId: parent });
		await h2.app.tasks.create({ title: "Sub 2", parentId: parent });
		// 997 + the parent + 2 subtasks = 1000.
		await refused(h2.app.tasks.update(parent, { categoryId: WORK }));
		expect(openIn(h2, WORK)).toBe(997);
	});

	it("refuses a drop into the full list (place with a list change)", async () => {
		const h = await appHarness({ initial: capDb({ open: 999, home: 1 }) });
		const homeTask = uuid(999);
		await refused(h.app.tasks.place(homeTask, [homeTask], { categoryId: WORK }));
		expect(h.app.store.state.tasks.get(homeTask)?.categoryId).toBe(HOME);
	});

	it("refuses making a task of another list a subtask of a task in the full list", async () => {
		const h = await appHarness({ initial: capDb({ open: 999, home: 1 }) });
		await refused(h.app.tasks.setParent(uuid(999), uuid(0)));
	});

	it("refuses reopening a task in the full list; one below the cap reopens", async () => {
		const h = await appHarness({ initial: capDb({ open: 999, completed: 1 }) });
		const done = uuid(999);
		await refused(h.app.tasks.reopen(done));
		expect(h.app.store.state.tasks.get(done)?.status).toBe("completed");
		await h.app.tasks.complete(uuid(0));
		await h.app.tasks.reopen(done);
		expect(openIn(h, WORK)).toBe(999);
	});

	it("refuses a duplicate and a restore from Trash into the full list", async () => {
		const h = await appHarness({ initial: capDb({ open: 999 }) });
		await refused(h.app.tasks.duplicate(uuid(0)));
		const trashed = await h.app.tasks.delete(uuid(1));
		await h.app.tasks.create({ title: "Takes its place", categoryId: WORK });
		await refused(h.app.tasks.restore(trashed.batchId));
	});

	it("edits that add no open task still work in a full list, and in a list over the cap", async () => {
		const h = await appHarness({ initial: capDb({ open: 1005 }) });
		await h.app.tasks.update(uuid(0), { title: "Renamed" });
		await h.app.tasks.complete(uuid(1));
		await h.app.tasks.place(uuid(2), [uuid(3), uuid(2)]);
		expect(h.app.store.state.tasks.get(uuid(0))?.title).toBe("Renamed");
		await refused(h.app.tasks.reopen(uuid(1)));
	});

	it("follows undo and a reload: the count is never stale", async () => {
		const h = await appHarness({ initial: capDb({ open: 998 }) });
		await h.app.tasks.create({ title: "The 999th", categoryId: WORK });
		await h.app.store.undo();
		await h.app.tasks.create({ title: "Again the 999th", categoryId: WORK });
		await refused(h.app.tasks.create({ title: "The 1000th", categoryId: WORK }));
		// A reload from outside with one open task fewer.
		h.app.store.notifyReloaded();
		await h.app.tasks.complete(uuid(0));
		await h.app.tasks.create({ title: "Fits after the completion", categoryId: WORK });
	});
});

describe("SYNC-13: linking and pulling", () => {
	it("a list with more than 999 open tasks cannot be linked; 999 can", async () => {
		const s = await syncHarness(capDb({ open: 1000, linked: false }));
		const project = s.tt.addProject("Work");
		const msg = "Can't link the list: Work has more than 999 open tasks, the most a list synced with TickTick can hold.";
		await expect(s.sync.planFirstSync(WORK, project.id)).rejects.toThrow(msg);
		await expect(s.sync.applyFirstSync(WORK, project.id)).rejects.toThrow(msg);
		expect(s.link("list", WORK)).toBeUndefined();

		const ok = await syncHarness(capDb({ open: 999, completed: 5, linked: false }));
		const p2 = ok.tt.addProject("Work");
		await expect(ok.sync.planFirstSync(WORK, p2.id)).resolves.toMatchObject({ toTickTick: 999 });
	});

	it("a pull is never refused by the cap: a task added in TickTick to a full list comes in", async () => {
		const clock = new FakeClock(NOW);
		const tt = new FakeTickTick(clock);
		const project = tt.addProject("Work");
		const db = createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-other", now: NOW });
		const categories = new Map(db.categories);
		categories.set(WORK, list(WORK, "Work", "V1"));
		const tasks = new Map<string, Task>();
		const syncLinks = new Map<string, SyncLink>([[`list:${WORK}`, listLink(WORK, project.id)]]);
		for (let i = 0; i < 999; i++) {
			const t = makeTask(uuid(i), { title: `Open ${i}`, categoryId: WORK, sortKey: `V${i.toString(36).padStart(4, "0")}` });
			tasks.set(t.id, t);
			const made = tt.add(project.id, { title: t.title });
			const base = fieldHashes({ title: t.title, status: "open", priority: 0, date: null, parent: null, section: null, tags: [] });
			syncLinks.set(`task:${t.id}`, { kind: "task", logwellId: t.id, ttId: made.id, ttProjectId: project.id, etag: made.etag ?? null, base, noteBySync: false, lastPulledAt: null, modifiedAt: NOW });
		}
		const s = await syncHarness(serializeDb({ ...db, categories, tasks, syncLinks }), tt);
		tt.add(project.id, { title: "Added in TickTick" });
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(s.tasks("Added in TickTick")).toHaveLength(1);
		expect(openIn(s.h, WORK)).toBe(1000);
		await refused(s.h.app.tasks.create({ title: "Local one", categoryId: WORK }));
	});
});
