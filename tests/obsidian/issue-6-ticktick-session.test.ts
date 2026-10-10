// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TickTickApi } from "../../src/app/ports";
import { SyncService } from "../../src/app/SyncService";
import type { Category, SyncLink, Task } from "../../src/domain/types";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { SYNC_CLOSE_WAIT_MS } from "../../src/obsidian/session";
import { TickTickHttp } from "../../src/obsidian/tickTickHttp";
import { TICKTICK_SECRET_ID } from "../../src/obsidian/tickTickPorts";
import { FakeTickTick } from "../app/fake-ticktick";
import { FakeClock } from "../helpers";
import { makeTask } from "../persistence/fixtures";
import { fakeApp, loadPlugin } from "./fake-vault";

// The session and the sync. A database switch stops the sync between two requests and waits up to 15 s for
// the one in flight, so a create TickTick answered is linked before the store closes; then it closes anyway. Unloading
// the plugin stops the sync and closes the store at once. No sync starts in a session the plugin never
// keeps: one still opening when the plugin unloads, or one whose open failed after the file was read.

const NOW = "2026-10-01T09:59:00.000Z";
const WORK = "00000000-0000-4000-8000-00000000000a";
const LOCAL = "00000001-0000-4000-8000-000000000001";

const LOCAL_2 = "00000001-0000-4000-8000-000000000002";

function dbText(projectId: string): string {
	const d = createEmptyDb({ dbId: "db-a", revision: "r-aaaaaaaaaaaa", deviceId: "d-other", now: NOW });
	const categories = new Map(d.categories);
	const work: Category = { id: WORK, name: "Work", icon: null, color: null, nameKey: "work", isInbox: false, sortKey: "V1", createdAt: NOW, modifiedAt: NOW };
	categories.set(WORK, work);
	const link: SyncLink = { kind: "list", logwellId: WORK, ttId: projectId, ttProjectId: null, etag: null, base: {}, noteBySync: false, lastPulledAt: NOW, modifiedAt: NOW };
	const task: Task = makeTask(LOCAL, { title: "Call the bank", categoryId: WORK, sortKey: "V1" });
	const task2: Task = makeTask(LOCAL_2, { title: "Pay the rent", categoryId: WORK, sortKey: "V2" });
	return serializeDb({ ...d, categories, tasks: new Map([[LOCAL, task], [LOCAL_2, task2]]), syncLinks: new Map([[`list:${WORK}`, link]]) });
}

/** A vault with Work linked to a project of `tt`, sync on for this device, and every TickTick call going to `tt`. */
function vault() {
	const tt = new FakeTickTick(new FakeClock(NOW));
	const project = tt.addProject("Work");
	const methods: (keyof TickTickApi)[] = ["listProjects", "getProjectData", "listCompleted", "filterTasks", "getTask", "createTask", "updateTask", "deleteTask", "moveTasks", "batchTasks", "createProject", "createColumn"];
	for (const m of methods) vi.spyOn(TickTickHttp.prototype, m).mockImplementation(((...args: never[]) => (tt[m] as (...a: never[]) => unknown)(...args)) as never);
	const fake = fakeApp();
	fake.files.set("A.cpbase", dbText(project.id));
	fake.secrets.set(TICKTICK_SECRET_ID, "token");
	fake.local.set("logwell-ticktick-device-db-a", true);
	return { fake, tt };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
	cleanup?.();
	cleanup = null;
	vi.restoreAllMocks();
});

describe("closing a session while a sync is in flight (issue #6)", () => {
	const creates = (calls: string[]) => calls.filter((c) => c.startsWith("createTask")).length;

	it("a database switch waits for the request in flight, sends no other, and links what TickTick answered", async () => {
		const { fake, tt } = vault();
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		tt.onCall = (m) => (m === "createTask" && creates(tt.calls) === 1 ? held : undefined);
		const plugin = await loadPlugin(fake, "A.cpbase");
		cleanup = () => plugin.onunload();
		await vi.waitFor(() => expect(creates(tt.calls)).toBe(1));
		let switched = false;
		const switching = plugin.openActiveDatabase().then(() => (switched = true));
		await new Promise((r) => setTimeout(r, 20));
		expect(switched).toBe(false);
		release();
		await switching;
		expect(creates(tt.calls)).toBe(1);
		const made = [...tt.tasks.values()].find((t) => t.deleted !== true)!;
		expect(fake.files.get("A.cpbase")).toContain(`"ttId":"${made.id}"`);
	});

	it("a database switch waits at most 15 s for a request that never answers", async () => {
		const { fake, tt } = vault();
		tt.onCall = (m) => (m === "createTask" ? new Promise<void>(() => undefined) : undefined);
		const plugin = await loadPlugin(fake, "A.cpbase");
		cleanup = () => plugin.onunload();
		await vi.waitFor(() => expect(creates(tt.calls)).toBe(1));
		const old = plugin.session!;
		const storeClose = vi.spyOn(old.store, "close");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			let switched = false;
			const switching = plugin.openActiveDatabase().then(() => (switched = true));
			await vi.advanceTimersByTimeAsync(SYNC_CLOSE_WAIT_MS - 1);
			expect(storeClose).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(storeClose).toHaveBeenCalledTimes(1);
			vi.useRealTimers();
			await switching;
			expect(switched).toBe(true);
			// The new session took over (it creates the task again: TickTick never answered the old request).
			expect(plugin.session).not.toBe(old);
			expect(plugin.session).not.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("unloading the plugin mid-push closes the store at once and sends nothing more", async () => {
		const { fake, tt } = vault();
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		tt.onCall = (m) => (m === "createTask" && creates(tt.calls) === 1 ? held : undefined);
		const plugin = await loadPlugin(fake, "A.cpbase");
		await vi.waitFor(() => expect(creates(tt.calls)).toBe(1));
		const session = plugin.session!;
		const storeClose = vi.spyOn(session.store, "close");
		plugin.onunload();
		expect(storeClose).toHaveBeenCalledTimes(1);
		release();
		await session.sync.idle();
		expect(creates(tt.calls)).toBe(1);
	});

	it("closes at once when no sync is in flight", async () => {
		const { fake } = vault();
		const plugin = await loadPlugin(fake, "A.cpbase");
		cleanup = () => plugin.onunload();
		const session = plugin.session!;
		await session.sync.idle();
		const storeClose = vi.spyOn(session.store, "close");
		void session.close();
		// Synchronous up to the store close.
		expect(storeClose).toHaveBeenCalledTimes(1);
	});
});

describe("no sync in a session the plugin does not keep (issue #6)", () => {
	async function plugin(fake: ReturnType<typeof fakeApp>) {
		const { default: CheckpointPlugin } = await import("../../src/main");
		const Ctor = CheckpointPlugin as unknown as new (a: unknown, m: unknown) => InstanceType<typeof CheckpointPlugin>;
		const p = new Ctor(fake.app, { id: "logwell", dir: "config/plugins/logwell" });
		await p.onload();
		p.settings.activeDatabasePath = "A.cpbase";
		return p;
	}

	it("unloading while the database opens: the opening session is closed and never syncs", async () => {
		const { fake } = vault();
		const sync = vi.spyOn(SyncService.prototype, "sync");
		const p = await plugin(fake);
		fake.layoutReady();
		p.onunload();
		await p.ready();
		await new Promise((r) => setTimeout(r, 20));
		expect(p.session).toBeNull();
		expect(sync).not.toHaveBeenCalled();
	});

	it("an open that fails after the file was read starts no sync", async () => {
		const { fake } = vault();
		const sync = vi.spyOn(SyncService.prototype, "sync");
		const p = await plugin(fake);
		cleanup = () => p.onunload();
		vi.spyOn(p, "applyBufferedRenames").mockRejectedValue(new Error("renames failed"));
		fake.layoutReady();
		await p.ready();
		await new Promise((r) => setTimeout(r, 20));
		expect(p.session).toBeNull();
		expect(sync).not.toHaveBeenCalled();
	});
});
