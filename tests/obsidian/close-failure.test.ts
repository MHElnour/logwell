// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { descendant, emptyDbText, makeTask, withTask } from "../persistence/fixtures";
import { type FakeApp, fakeApp, loadPlugin } from "./fake-vault";

// Lifecycle: a session whose close() rejects must not leave the
// plugin pointing at the closed session, and must not leak an unhandled rejection.

interface Recorded {
	message: string;
	labels: string[];
	run: () => unknown;
}
const notices = vi.hoisted(() => ({ actions: [] as Recorded[], errors: [] as unknown[] }));

vi.mock("../../src/obsidian/notices", () => ({
	actionNotice: (message: string, actions: { label: string; run: () => unknown }[]) => {
		notices.actions.push({ message, labels: actions.map((a) => a.label), run: () => actions[0]?.run() });
		return {};
	},
	showError: (err: unknown) => void notices.errors.push(err),
}));

const A = "A.cpbase";
const B = "B.cpbase";

function setup(): FakeApp {
	const fake = fakeApp();
	fake.files.set(A, emptyDbText("db-a", "r-aaaaaaaaaaaa"));
	fake.files.set(B, emptyDbText("db-b", "r-bbbbbbbbbbbb"));
	notices.actions.length = 0;
	notices.errors.length = 0;
	return fake;
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
beforeEach(() => {
	unhandled.length = 0;
	process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
	process.off("unhandledRejection", onUnhandled);
	vi.restoreAllMocks();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("a session whose close() rejects", () => {
	it("switching databases still opens the new one and plugin.session is the new session", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const old = plugin.session!;
		vi.spyOn(old.store, "close").mockRejectedValue(new Error("EACCES"));

		await plugin.setActiveDatabase(B);

		expect(plugin.session).not.toBeNull();
		expect(plugin.session).not.toBe(old);
		expect(plugin.session!.path).toBe(B);
		expect(plugin.settings.activeDatabasePath).toBe(B);
		expect(notices.errors.map(String)).toEqual(["Error: EACCES"]);
	});

	it("the closed session's bus is cleared even though close() rejects", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const old = plugin.session!;
		const onChanged = vi.fn();
		old.app.store.bus.on("changed", onChanged);
		vi.spyOn(old.store, "close").mockRejectedValue(new Error("EACCES"));

		await expect(old.close()).rejects.toThrow("EACCES");

		old.app.store.bus.emit("changed", { label: "x" });
		expect(onChanged).not.toHaveBeenCalled();
	});

	it("held-back renames are still flushed before the failing close", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const old = plugin.session!;
		const flush = vi.spyOn(old.app.noteRenames, "flushRenames");
		vi.spyOn(old.store, "close").mockRejectedValue(new Error("EACCES"));
		await expect(old.close()).rejects.toThrow("EACCES");
		expect(flush).toHaveBeenCalledTimes(1);
	});

	it("a database whose pending edits and conflict copy cannot be written: the switch still completes", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		await plugin.session!.app.tasks.create({ title: "pending" });
		const origProcess = fake.app.vault.process;
		fake.app.vault.process = (f, fn) =>
			f.path === A ? Promise.reject(new Error("EACCES")) : origProcess(f, fn);
		fake.plugin.failNextWrite((p) => p.includes("/conflicts/"));

		await plugin.setActiveDatabase(B);

		expect(plugin.session?.path).toBe(B);
		await tick();
		expect(unhandled).toEqual([]);
	});

	it("unloading the plugin does not leak an unhandled rejection and drops the session", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const old = plugin.session!;
		vi.spyOn(old.store, "close").mockRejectedValue(new Error("EACCES"));

		plugin.onunload();
		await tick();
		await tick();

		expect(unhandled).toEqual([]);
		expect(plugin.session).toBeNull();
		expect(notices.errors.map(String)).toEqual(["Error: EACCES"]);
	});
});

describe("'Open conflict view' for a closed database whose file is gone", () => {
	async function closedWithConflictCopy(fake: FakeApp) {
		const plugin = await loadPlugin(fake, A);
		await plugin.session!.app.tasks.create({ title: "mine" });
		fake.files.set(A, descendant(fake.files.get(A)!, (d) => withTask(d, makeTask("remote")).next, "r-remote000001"));
		await plugin.setActiveDatabase(B);
		expect(notices.actions).toHaveLength(1);
		return plugin;
	}

	it("does not switch to or open the active database; explains where the copy is kept", async () => {
		const fake = setup();
		const plugin = await closedWithConflictCopy(fake);
		fake.files.delete(A);
		const openApp = vi.spyOn(plugin, "openApp").mockResolvedValue(null);
		const setActive = vi.spyOn(plugin, "setActiveDatabase");

		await notices.actions[0]!.run();

		expect(openApp).not.toHaveBeenCalled();
		expect(setActive).not.toHaveBeenCalled();
		expect(plugin.settings.activeDatabasePath).toBe(B);
		expect(plugin.session!.path).toBe(B);
		expect(notices.actions).toHaveLength(2);
		const msg = notices.actions[1]!.message;
		expect(msg).toContain(A);
		expect(msg).toContain("config/plugins/logwell/backups/db-a/conflicts");
		expect(msg).toMatch(/back/);
	});

	it("still works when the file is there", async () => {
		const fake = setup();
		const plugin = await closedWithConflictCopy(fake);
		const openApp = vi.spyOn(plugin, "openApp").mockResolvedValue(null);
		await notices.actions[0]!.run();
		expect(plugin.settings.activeDatabasePath).toBe(A);
		expect(openApp).toHaveBeenCalledWith("data");
		expect(notices.actions).toHaveLength(1);
	});
});
