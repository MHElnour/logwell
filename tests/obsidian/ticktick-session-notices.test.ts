// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settle } from "../ui/app-helpers";
import { TickTickError } from "../../src/app/ports";
import type { TickTickApi } from "../../src/app/ports";
import type { Category, SyncLink, Task } from "../../src/domain/types";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { TickTickHttp } from "../../src/obsidian/tickTickHttp";
import { TICKTICK_SECRET_ID } from "../../src/obsidian/tickTickPorts";
import { FakeTickTick } from "../app/fake-ticktick";
import { FakeClock } from "../helpers";
import { makeTask } from "../persistence/fixtures";
import { fakeApp, loadPlugin } from "./fake-vault";

// The sync screens in the real session: failure notices with their actions, the question about
// tasks removed in TickTick, and the link flow reached from a host. The dialogs themselves are scripted.

const mocks = vi.hoisted(() => ({
	actionNotice: vi.fn(),
	showError: vi.fn(),
	notices: [] as string[],
	askMissing: vi.fn(),
	pickLinkOption: vi.fn(),
	showFirstSyncPreview: vi.fn(),
}));

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: unknown) {
			mocks.notices.push(String(message));
		}
		hide() {}
	},
}));
vi.mock("../../src/obsidian/notices", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	actionNotice: mocks.actionNotice,
	showError: mocks.showError,
}));
vi.mock("../../src/obsidian/tickTickDialogs", () => ({
	askMissing: mocks.askMissing,
	pickLinkOption: mocks.pickLinkOption,
	showFirstSyncPreview: mocks.showFirstSyncPreview,
}));

const NOW = "2026-10-01T09:59:00.000Z";
const WORK = "00000000-0000-4000-8000-00000000000a";
const id = (n: number) => `00000001-0000-4000-8000-${String(n).padStart(12, "0")}`;

function dbText(options: { linked: boolean; tasks: number }): string {
	const d = createEmptyDb({ dbId: "db-a", revision: "r-aaaaaaaaaaaa", deviceId: "d-other", now: NOW });
	const categories = new Map(d.categories);
	const work: Category = { id: WORK, name: "Work", icon: null, color: null, nameKey: "work", isInbox: false, sortKey: "V1", createdAt: NOW, modifiedAt: NOW };
	categories.set(WORK, work);
	const tasks = new Map<string, Task>();
	for (let i = 1; i <= options.tasks; i++) tasks.set(id(i), makeTask(id(i), { title: `Errand ${i}`, categoryId: WORK, sortKey: `V${i}` }));
	const link: SyncLink = { kind: "list", logwellId: WORK, ttId: "", ttProjectId: null, etag: null, base: {}, noteBySync: false, lastPulledAt: NOW, modifiedAt: NOW };
	return serializeDb({ ...d, categories, tasks, syncLinks: new Map(options.linked ? [[`list:${WORK}`, link]] : []) });
}

function vault(options: { linked: boolean; tasks: number; device?: boolean }) {
	const tt = new FakeTickTick(new FakeClock(NOW));
	const project = tt.addProject("Work");
	const methods: (keyof TickTickApi)[] = ["listProjects", "getProjectData", "listCompleted", "filterTasks", "getTask", "createTask", "updateTask", "deleteTask", "moveTasks", "batchTasks", "createProject", "createColumn"];
	for (const m of methods) vi.spyOn(TickTickHttp.prototype, m).mockImplementation(((...args: never[]) => (tt[m] as (...a: never[]) => unknown)(...args)) as never);
	const fake = fakeApp();
	fake.files.set("A.cpbase", dbText(options).replace('"ttId":""', `"ttId":"${project.id}"`));
	fake.secrets.set(TICKTICK_SECRET_ID, "token");
	if (options.device ?? true) fake.local.set("logwell-ticktick-device-db-a", true);
	return { fake, tt, project };
}

let cleanup: (() => void) | null = null;
beforeEach(() => {
	mocks.notices.length = 0;
	for (const m of [mocks.actionNotice, mocks.showError, mocks.askMissing, mocks.pickLinkOption, mocks.showFirstSyncPreview]) m.mockReset();
});
afterEach(() => {
	cleanup?.();
	cleanup = null;
	vi.restoreAllMocks();
});

describe("failure notices (screen 10)", () => {
	it("a refused token offers Open settings, which opens this plugin's tab", async () => {
		const { fake, tt } = vault({ linked: true, tasks: 0 });
		const setting = { open: vi.fn(), openTabById: vi.fn() };
		(fake.app as unknown as { setting: unknown }).setting = setting;
		tt.fail("getProjectData", new TickTickError("unauthorized", "TickTick: the API token was refused", { status: 401 }));
		const plugin = await loadPlugin(fake, "A.cpbase");
		cleanup = () => plugin.onunload();
		await vi.waitFor(() => expect(mocks.actionNotice).toHaveBeenCalled());
		const [message, actions] = mocks.actionNotice.mock.calls[0] as [string, { label: string; run: () => void }[]];
		expect(message).toContain("the API token was refused");
		expect(message.endsWith("Replace it in Settings > Logwell.")).toBe(true);
		expect(actions.map((a) => a.label)).toEqual(["Open settings"]);
		actions[0]!.run();
		expect(setting.open).toHaveBeenCalled();
		expect(setting.openTabById).toHaveBeenCalledWith("logwell");
	});

	it("opening settings does nothing where Obsidian has no such call", async () => {
		const { fake } = vault({ linked: false, tasks: 0 });
		const plugin = await loadPlugin(fake, "A.cpbase");
		cleanup = () => plugin.onunload();
		expect(() => plugin.openSettings()).not.toThrow();
	});

	it("the free plan's list limit offers Sync now", async () => {
		const { fake, tt } = vault({ linked: true, tasks: 100 });
		tt.openLimit = 99;
		const plugin = await loadPlugin(fake, "A.cpbase");
		cleanup = () => plugin.onunload();
		await vi.waitFor(() => expect(mocks.actionNotice).toHaveBeenCalled());
		const [message, actions] = mocks.actionNotice.mock.calls[0] as [string, { label: string; run: () => void }[]];
		expect(message).toContain("TickTick's free plan allows 99 per list");
		expect(actions.map((a) => a.label)).toEqual(["Sync now"]);
		const syncNow = vi.spyOn(plugin.session!.tickTick, "syncNow");
		actions[0]!.run();
		expect(syncNow).toHaveBeenCalledTimes(1);
	});

	it("#111: a TickTick list that no longer exists is named and offers Unlink, which unlinks the list", async () => {
		const { fake, tt, project } = vault({ linked: true, tasks: 0 });
		tt.projects.delete(project.id);
		const plugin = await loadPlugin(fake, "A.cpbase");
		cleanup = () => plugin.onunload();
		await vi.waitFor(() => expect(mocks.actionNotice).toHaveBeenCalled());
		const [message, actions] = mocks.actionNotice.mock.calls[0] as [string, { label: string; run: () => void }[]];
		expect(message).toBe('The TickTick list linked to "Work" no longer exists.');
		expect(actions.map((a) => a.label)).toEqual(["Unlink"]);
		actions[0]!.run();
		await vi.waitFor(() => expect(plugin.session!.app.store.state.syncLinks.size).toBe(0));
		expect(mocks.notices).toContain("Work is no longer synced with TickTick. Its tasks stay on both sides.");
	});

	it("too many requests is a plain notice", async () => {
		const { fake, tt } = vault({ linked: true, tasks: 0 });
		tt.fail("getProjectData", new TickTickError("rate-limited", "TickTick: too many requests", { status: 429, retryAfterSec: 30 }));
		const plugin = await loadPlugin(fake, "A.cpbase");
		cleanup = () => plugin.onunload();
		await vi.waitFor(() => expect(mocks.notices).toContain("TickTick: too many requests. Sync will try again at the next pull."));
		expect(mocks.actionNotice).not.toHaveBeenCalled();
	});
});

describe("tasks removed in TickTick (screens 8 and 9)", () => {
	async function removedFive() {
		const v = vault({ linked: true, tasks: 6 });
		const plugin = await loadPlugin(v.fake, "A.cpbase");
		cleanup = () => plugin.onunload();
		const session = plugin.session!;
		await session.sync.idle();
		await settle();
		for (let i = 1; i <= 5; i++) v.tt.remove(v.tt.findByTitle(`Errand ${i}`)!.id);
		// The first read of the deleted tasks: nothing is asked until a second read finds them unchanged.
		await session.tickTick.syncNow();
		await settle();
		expect(mocks.askMissing).not.toHaveBeenCalled();
		return { ...v, plugin, session };
	}

	it("a sync that finds 5 removed tasks opens the question; Move to Trash applies it with an Undo notice", async () => {
		const { session } = await removedFive();
		mocks.askMissing.mockResolvedValue("trash");
		await session.tickTick.syncNow();
		await vi.waitFor(() => expect(session.app.store.state.tasks.size).toBe(1));
		expect(mocks.askMissing).toHaveBeenCalledTimes(1);
		const [, deps] = mocks.askMissing.mock.calls[0] as [unknown, { pending: { reason: string; tasks: unknown[] }; listName: string }];
		expect(deps).toMatchObject({ listName: "Work", pending: { reason: "many" } });
		expect(deps.pending.tasks).toHaveLength(5);
		await vi.waitFor(() => expect(mocks.actionNotice).toHaveBeenCalled());
		const [message, actions] = mocks.actionNotice.mock.calls.at(-1) as [string, { label: string }[]];
		expect(message).toBe("Moved 5 tasks to Trash.");
		expect(actions.map((a) => a.label)).toEqual(["Undo"]);
	});

	it("Keep keeps them and the next pull does not ask again", async () => {
		const { session, tt } = await removedFive();
		mocks.askMissing.mockResolvedValue("keep");
		await session.tickTick.syncNow();
		await vi.waitFor(() => expect(mocks.notices).toContain("Kept 5 tasks in Logwell only. They are not synced."));
		expect(session.app.store.state.tasks.size).toBe(6);
		await session.tickTick.syncNow();
		await settle();
		expect(mocks.askMissing).toHaveBeenCalledTimes(1);
		expect(tt.live([...tt.projects.keys()][0]!)).toHaveLength(1);
	});

	it("a dialog dismissed (null) is not asked again by the next pull", async () => {
		const { session } = await removedFive();
		mocks.askMissing.mockResolvedValue(null);
		await session.tickTick.syncNow();
		await session.tickTick.syncNow();
		await settle();
		expect(mocks.askMissing).toHaveBeenCalledTimes(1);
		expect(session.app.store.state.tasks.size).toBe(6);
	});

	it("no question once the session is closing", async () => {
		const { session } = await removedFive();
		mocks.askMissing.mockResolvedValue("trash");
		const synced = session.tickTick.syncNow();
		void session.close();
		await synced;
		await settle();
		expect(session.app.store.state.tasks.size).toBe(6);
	});
});

describe("link flow from the session (screens 5 and 6)", () => {
	it("is not ready without the device switch", async () => {
		const { fake } = vault({ linked: false, tasks: 0, device: false });
		const plugin = await loadPlugin(fake, "A.cpbase");
		cleanup = () => plugin.onunload();
		expect(plugin.session!.tickTickReady()).toBe(false);
		await plugin.session!.linkWithTickTick(WORK);
		expect(mocks.notices).toEqual(["Add your TickTick token and turn on sync for this device in Settings > Logwell first."]);
		expect(mocks.pickLinkOption).not.toHaveBeenCalled();
	});

	it("links the list to the chosen project and runs the first sync", async () => {
		const { fake, tt, project } = vault({ linked: false, tasks: 2 });
		tt.add(project.id, { title: "Water the plants" });
		const plugin = await loadPlugin(fake, "A.cpbase");
		cleanup = () => plugin.onunload();
		const session = plugin.session!;
		expect(session.tickTickReady()).toBe(true);
		mocks.pickLinkOption.mockImplementation(async (_app: unknown, deps: { load: () => Promise<{ key: string }[]> }) => (await deps.load()).find((o) => o.key === project.id));
		mocks.showFirstSyncPreview.mockResolvedValue("sync");
		await session.linkWithTickTick(WORK);
		expect(mocks.showFirstSyncPreview.mock.calls[0]![1]).toMatchObject({ listName: "Work", projectName: "Work", plan: { toLogwell: 1, toTickTick: 2 } });
		expect(mocks.notices).toContain("Synced “Work”: 1 in, 2 out.");
		expect(session.app.store.state.syncLinks.has(`list:${WORK}`)).toBe(true);
		expect(session.tickTick.isActive()).toBe(true);
		// The first sync is this device's latest sync, for the settings and the list header.
		expect(session.tickTick.status().lastSyncAt).not.toBeNull();
		// And unlinking it again.
		await session.unlinkFromTickTick(WORK);
		expect(session.app.store.state.syncLinks.has(`list:${WORK}`)).toBe(false);
	});

	it("does nothing once the session is closing", async () => {
		const { fake } = vault({ linked: false, tasks: 0 });
		const plugin = await loadPlugin(fake, "A.cpbase");
		cleanup = () => plugin.onunload();
		const session = plugin.session!;
		void session.close();
		await session.linkWithTickTick(WORK);
		expect(mocks.pickLinkOption).not.toHaveBeenCalled();
	});
});
