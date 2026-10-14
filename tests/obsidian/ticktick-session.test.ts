// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { type TickTickApi, TickTickError } from "../../src/app/ports";
import { SyncService } from "../../src/app/SyncService";
import type { Category, SyncLink, Task } from "../../src/domain/types";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { DbSession, SYNC_CLOSE_WAIT_MS } from "../../src/obsidian/session";
import { TickTickHttp } from "../../src/obsidian/tickTickHttp";
import { LocalStorageTickTickDevice, LocalStorageTickTickPending, SecretStorageTickTickSecret, TICKTICK_SECRET_ID } from "../../src/obsidian/tickTickPorts";
import { FakeTickTick } from "../app/fake-ticktick";
import { FakeClock } from "../helpers";
import { emptyDbText, makeTask } from "../persistence/fixtures";
import { fakeApp, fakeLocal, loadPlugin } from "./fake-vault";
import { Plugin } from "obsidian";

const NOW = "2026-10-01T09:59:00.000Z";
const WORK = "00000000-0000-4000-8000-00000000000a";

/** A database written on another device with the list Work and `tasks`, Work linked to the TickTick list `projectId` (none for null). */
function workDbText(projectId: string | null, tasks: Task[] = []): string {
	const d = createEmptyDb({ dbId: "db-a", revision: "r-aaaaaaaaaaaa", deviceId: "d-other", now: NOW });
	const categories = new Map(d.categories);
	const work: Category = { id: WORK, name: "Work", icon: null, color: null, nameKey: "work", isInbox: false, sortKey: "V1", createdAt: NOW, modifiedAt: NOW };
	categories.set(WORK, work);
	const link: SyncLink | null =
		projectId === null ? null : { kind: "list", logwellId: WORK, ttId: projectId, ttProjectId: null, etag: null, base: {}, noteBySync: false, lastPulledAt: NOW, modifiedAt: NOW };
	return serializeDb({
		...d,
		categories,
		tasks: new Map(tasks.map((t) => [t.id, t])),
		syncLinks: link === null ? new Map() : new Map([[`list:${WORK}`, link]]),
	});
}

describe("the session and the sync", () => {
	// The session and the sync. A database switch stops the sync between two requests and waits up to 15 s for
	// the one in flight, so a create TickTick answered is linked before the store closes; then it closes anyway. Unloading
	// the plugin stops the sync and closes the store at once. No sync starts in a session the plugin never
	// keeps: one still opening when the plugin unloads, or one whose open failed after the file was read.

	const LOCAL = "00000001-0000-4000-8000-000000000001";

	const LOCAL_2 = "00000001-0000-4000-8000-000000000002";

	const dbText = (projectId: string): string =>
		workDbText(projectId, [
			makeTask(LOCAL, { title: "Call the bank", categoryId: WORK, sortKey: "V1" }),
			makeTask(LOCAL_2, { title: "Pay the rent", categoryId: WORK, sortKey: "V2" }),
		]);

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

	describe("closing a session while a sync is in flight", () => {
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

	describe("a restart", () => {
		it("#122: a create whose answer was lost is remembered on this device, and after a restart its copy is linked, not imported", async () => {
			const { fake, tt } = vault();
			tt.fail("createTask", new TickTickError("server", "TickTick: server error (HTTP 500)", { status: 500, maybePartial: true }), { applyFirst: true });
			const first = await loadPlugin(fake, "A.cpbase");
			await vi.waitFor(() => expect(fake.local.get("logwell-ticktick-pending-db-a")).toMatchObject({ v: 1, lists: { [WORK]: { [LOCAL]: null } } }));
			await first.session!.sync.idle();
			first.onunload();
			const second = await loadPlugin(fake, "A.cpbase");
			cleanup = () => second.onunload();
			const state = () => second.session!.app.store.state;
			await vi.waitFor(() => expect(state().syncLinks.get(`task:${LOCAL}`)).toBeDefined());
			await second.session!.sync.idle();
			expect([...state().tasks.values()].filter((t) => t.title === "Call the bank")).toHaveLength(1);
			expect([...tt.tasks.values()].filter((t) => t.title === "Call the bank")).toHaveLength(1);
			expect(fake.local.get("logwell-ticktick-pending-db-a") ?? null).toBeNull();
		});
	});

	describe("no sync in a session the plugin does not keep", () => {
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
});

describe("the Sync now command", () => {
	// The sync is wired into the session, and "Sync with TickTick now" is available only
	// while the sync is on for this device: the switch on, a token set and a list linked.

	interface Cmd {
		id: string;
		name: string;
		hotkeys?: unknown;
		callback?: () => void;
		checkCallback?: (checking: boolean) => boolean;
	}

	async function setup(options: { linked?: boolean; device?: boolean; token?: boolean; minutes?: number } = {}) {
		const commands: Cmd[] = [];
		vi.spyOn(Plugin.prototype, "addCommand").mockImplementation(((c: Cmd) => void commands.push(c)) as never);
		const sync = vi.spyOn(SyncService.prototype, "sync");
		const fake = fakeApp();
		fake.files.set("A.cpbase", workDbText((options.linked ?? true) ? "p-work" : null));
		if (options.token ?? true) fake.secrets.set(TICKTICK_SECRET_ID, "token");
		if (options.device ?? true) fake.local.set("logwell-ticktick-device-db-a", true);
		const { default: CheckpointPlugin } = await import("../../src/main");
		const loadData = vi.spyOn(CheckpointPlugin.prototype, "loadData").mockResolvedValue({ tickTickPullMinutes: options.minutes ?? 5 });
		const plugin = await loadPlugin(fake, "A.cpbase");
		loadData.mockRestore();
		return { fake, plugin, sync, cmd: commands.find((c) => c.id === "sync-ticktick-now") };
	}

	let unload: (() => void) | null = null;
	afterEach(() => {
		unload?.();
		unload = null;
		vi.restoreAllMocks();
	});

	describe("Sync with TickTick now", () => {
		it("is registered with its name, a check callback and no hotkey", async () => {
			const { plugin, cmd } = await setup();
			unload = () => plugin.onunload();
			expect(cmd).toMatchObject({ id: "sync-ticktick-now", name: "Sync with TickTick now" });
			expect(cmd!.hotkeys).toBeUndefined();
			expect(cmd!.callback).toBeUndefined();
			expect(typeof cmd!.checkCallback).toBe("function");
		});

		for (const [name, options] of [
			["the device switch is off", { device: false }],
			["no token is set", { token: false }],
			["no list is linked", { linked: false }],
		] as const) {
			it(`is unavailable when ${name}, and nothing syncs on open`, async () => {
				const { plugin, cmd, sync } = await setup(options);
				unload = () => plugin.onunload();
				expect(cmd!.checkCallback!(true)).toBe(false);
				expect(sync).not.toHaveBeenCalled();
			});
		}

		it("is available while sync is on, and runs a sync", async () => {
			const { plugin, cmd, sync } = await setup();
			unload = () => plugin.onunload();
			// The pull when the database opens (always).
			expect(sync).toHaveBeenCalledTimes(1);
			await plugin.session!.sync.idle();
			expect(cmd!.checkCallback!(true)).toBe(true);
			expect(cmd!.checkCallback!(false)).toBe(true);
			await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
			await plugin.session!.sync.idle();
		});

		it("the open session pulls once when it opens, and closing it stops the scheduler", async () => {
			const { plugin, sync } = await setup({ minutes: 5 });
			unload = () => plugin.onunload();
			expect(sync).toHaveBeenCalledTimes(1);
			const session = plugin.session!;
			expect(session.sync).toBeInstanceOf(SyncService);
			const dispose = vi.spyOn(session.tickTick, "dispose");
			await session.sync.idle();
			await plugin.openActiveDatabase();
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(session.tickTick.isActive()).toBe(false);
		});
	});
});

describe("the token and device ports", () => {
	// The token lives in Obsidian's secret storage; "Sync with TickTick on this device" lives in
	// the vault's local storage, per database. Nothing reads either yet.

	function fakeSecrets() {
		const secrets = new Map<string, string>();
		return {
			secrets,
			app: {
				secretStorage: {
					getSecret: (id: string) => secrets.get(id) ?? null,
					setSecret: (id: string, secret: string) => {
						// Obsidian: "Lowercase alphanumeric ID with optional dashes", else it throws.
						if (!/^[a-z0-9-]+$/u.test(id)) throw new Error("invalid id");
						secrets.set(id, secret);
					},
					listSecrets: () => [...secrets.keys()],
				},
			},
		};
	}

	describe("SecretStorageTickTickSecret", () => {
		it("stores the token under a valid secret id and reads it back", () => {
			const f = fakeSecrets();
			const port = new SecretStorageTickTickSecret(f.app);
			expect(port.get()).toBeNull();
			port.set("tok-1");
			expect([...f.secrets.keys()]).toEqual([TICKTICK_SECRET_ID]);
			expect(port.get()).toBe("tok-1");
		});

		it("clear empties the secret, which then reads as no token", () => {
			const f = fakeSecrets();
			const port = new SecretStorageTickTickSecret(f.app);
			port.set("tok-1");
			port.clear();
			expect(port.get()).toBeNull();
		});
	});

	describe("LocalStorageTickTickDevice", () => {
		it("is off by default and stored per database under logwell-ticktick-device-<dbId>", () => {
			const f = fakeLocal();
			let dbId: string | null = "db-1";
			const port = new LocalStorageTickTickDevice(f.app, () => dbId);
			expect(port.isEnabled()).toBe(false);
			port.setEnabled(true);
			expect([...f.store.entries()]).toEqual([["logwell-ticktick-device-db-1", true]]);
			expect(port.isEnabled()).toBe(true);
			dbId = "db-2";
			expect(port.isEnabled()).toBe(false);
			dbId = "db-1";
			port.setEnabled(false);
			expect(f.store.size).toBe(0);
			expect(port.isEnabled()).toBe(false);
		});

		it("reads an unreadable value as off and leaves it alone", () => {
			const f = fakeLocal();
			f.store.set("logwell-ticktick-device-db-1", "yes");
			const port = new LocalStorageTickTickDevice(f.app, () => "db-1");
			expect(port.isEnabled()).toBe(false);
			expect(f.store.get("logwell-ticktick-device-db-1")).toBe("yes");
		});

		it("#122: LocalStorageTickTickPending keeps the waiting creates per database and ignores an unreadable value", () => {
			const f = fakeLocal();
			const port = new LocalStorageTickTickPending(f.app);
			const pending = { v: 1 as const, lists: { work: { "task-1": { ttId: "tt-1", base: { title: "h" } }, "task-2": null } } };
			port.save("db-1", pending);
			expect([...f.store.keys()]).toEqual(["logwell-ticktick-pending-db-1"]);
			expect(port.load("db-1")).toEqual(pending);
			expect(port.load("db-2")).toBeNull();
			port.save("db-1", null);
			expect(f.store.size).toBe(0);
			f.store.set("logwell-ticktick-pending-db-1", { v: 2 });
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			expect(port.load("db-1")).toBeNull();
			expect(warn).toHaveBeenCalledTimes(1);
			expect(f.store.get("logwell-ticktick-pending-db-1")).toEqual({ v: 2 });
		});

		it("with no known database it reads off and turning it on does nothing", () => {
			const f = fakeLocal();
			const port = new LocalStorageTickTickDevice(f.app, () => null);
			expect(port.isEnabled()).toBe(false);
			port.setEnabled(true);
			expect(f.store.size).toBe(0);
			expect(port.isEnabled()).toBe(false);
		});
	});

	describe("DbSession wiring", () => {
		it("hands the Obsidian ports to the app, keyed by the open database", async () => {
			const fake = fakeApp();
			fake.files.set("A.cpbase", emptyDbText("db-a", "r-aaaaaaaaaaaa"));
			const plugin = await loadPlugin(fake, "A.cpbase");
			const app = plugin.session!.app;
			expect(app.tickTickDevice).toBeInstanceOf(LocalStorageTickTickDevice);
			expect(app.tickTickSecret).toBeInstanceOf(SecretStorageTickTickSecret);
			app.tickTickDevice.setEnabled(true);
			expect(fake.app.loadLocalStorage("logwell-ticktick-device-db-a")).toBe(true);
			app.tickTickSecret.set("tok-1");
			expect(fake.secrets.get(TICKTICK_SECRET_ID)).toBe("tok-1");
		});

		it("before the session's store is open the switch reads off and setEnabled stores nothing", async () => {
			const fake = fakeApp();
			fake.files.set("A.cpbase", emptyDbText("db-a", "r-aaaaaaaaaaaa"));
			fake.files.set("B.cpbase", emptyDbText("db-b", "r-bbbbbbbbbbbb"));
			const plugin = await loadPlugin(fake, "A.cpbase");
			const keysBefore = [...fake.local.keys()].sort();
			const unopened = new DbSession(plugin, "B.cpbase");
			expect(unopened.store.isLoaded).toBe(false);
			const device = unopened.app.tickTickDevice;
			expect(device.isEnabled()).toBe(false);
			device.setEnabled(true);
			expect([...fake.local.keys()].sort()).toEqual(keysBefore);
			expect(device.isEnabled()).toBe(false);
		});
	});
});
