// @vitest-environment happy-dom
import { Plugin } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyDbText } from "../persistence/fixtures";
import { type FakeApp, fakeApp, fileOf, loadPlugin } from "./fake-vault";

interface Cmd {
	id: string;
	name: string;
	hotkeys?: unknown;
	callback?: () => void;
	checkCallback?: (checking: boolean) => boolean;
}

const config = { rounds: 2, focusSec: 1500, breakSec: 300, longBreakSec: 900 };

async function setup() {
	const commands: Cmd[] = [];
	vi.spyOn(Plugin.prototype, "addCommand").mockImplementation(((c: Cmd) => void commands.push(c)) as never);
	const fake = fakeApp();
	fake.files.set("A.cpbase", emptyDbText("db-a", "r-aaaaaaaaaaaa"));
	const plugin = await loadPlugin(fake, "A.cpbase");
	return { fake, plugin, commands, cmd: (id: string) => commands.find((c) => c.id === id)! };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("focus commands (D13)", () => {
	it("registers the four commands with the agreed names and no hotkeys", async () => {
		const { commands } = await setup();
		const focus = commands.filter((c) => /focus/.test(c.id));
		expect(focus.map((c) => [c.id, c.name])).toEqual([
			["open-focus", "Open focus"],
			["start-focus", "Start focus on selected task"],
			["toggle-focus", "Pause or resume focus"],
			["stop-focus", "Stop focus"],
		]);
		for (const c of focus) expect(c.hotkeys).toBeUndefined();
	});

	it("Pause or resume and Stop are unavailable without a timer", async () => {
		const { cmd } = await setup();
		expect(cmd("toggle-focus").checkCallback!(true)).toBe(false);
		expect(cmd("stop-focus").checkCallback!(true)).toBe(false);
	});

	it("both become available while a timer exists, and act", async () => {
		const { plugin, cmd } = await setup();
		const focus = plugin.session!.app.focus;
		await focus.start(config, null);
		expect(cmd("toggle-focus").checkCallback!(true)).toBe(true);
		expect(cmd("stop-focus").checkCallback!(true)).toBe(true);

		cmd("toggle-focus").checkCallback!(false);
		await vi.waitFor(() => expect(focus.timer()?.state).toBe("paused"));
		cmd("toggle-focus").checkCallback!(false);
		await vi.waitFor(() => expect(focus.timer()?.state).toBe("running"));

		cmd("stop-focus").checkCallback!(false);
		await vi.waitFor(() => expect(focus.timer()).toBeNull());
		expect(cmd("stop-focus").checkCallback!(true)).toBe(false);
	});
});

describe("closing a session while the heartbeat runs (B1)", () => {
	it("the plugin stops pointing at the old session before it closes, and the service stops ticking", async () => {
		const { plugin } = await setup();
		const old = plugin.session!;
		await old.app.focus.start(config, null);
		const seen: unknown[] = [];
		const realClose = old.close.bind(old);
		vi.spyOn(old, "close").mockImplementation(async () => {
			seen.push(plugin.session);
			await realClose();
		});
		const closeFocus = vi.spyOn(old.app.focus, "close");
		await plugin.openActiveDatabase();
		expect(seen).toEqual([null]);
		expect(closeFocus).toHaveBeenCalledTimes(1);
		await expect(old.app.focus.tick()).resolves.toBeUndefined();
	});

	it("unloading detaches the focus host", async () => {
		const { plugin } = await setup();
		const detach = vi.spyOn((plugin as unknown as { focusHost: { detach(): void } }).focusHost, "detach");
		plugin.onunload();
		expect(detach).toHaveBeenCalled();
	});
});

describe("active timer wiring (D11)", () => {
	it("is kept under logwell-active-timer-<dbId> and restored when the database opens again", async () => {
		const { fake, plugin } = await setup();
		await plugin.session!.app.focus.start(config, null);
		const stored = fake.app.loadLocalStorage("logwell-active-timer-db-a") as { v: number; sessionId: string } | null;
		expect(stored?.v).toBe(1);
		const sessionId = stored!.sessionId;

		const again = await loadPlugin(fake, "A.cpbase");
		expect(again.session!.focusOpened).not.toBe("none");
		expect(again.session!.app.focus.timer()?.sessionId).toBe(sessionId);
	});

	const timerOf = (fake: FakeApp, dbId: string) => fake.app.loadLocalStorage(`logwell-active-timer-${dbId}`) as { sessionId: string } | null;

	it("#115: a timer started after a damaged database got its real id back is kept under that id, never the placeholder", async () => {
		// The damaged-file notice is built with Obsidian's createFragment.
		vi.stubGlobal("createFragment", () => document.createDocumentFragment());
		const fake = fakeApp();
		const good = emptyDbText("db-a", "r-aaaaaaaaaaaa");
		// Damaged in its first line, on a device that never knew it: it opens read-only under the placeholder id.
		fake.files.set("A.cpbase", `<<<<<<< HEAD\n${good}`);
		const plugin = await loadPlugin(fake, "A.cpbase");
		const session = plugin.session!;
		expect(session.store.data.meta.dbId).toBe("unknown");
		// The good file is put back outside Obsidian.
		fake.files.set("A.cpbase", good);
		fake.fire("modify", fileOf("A.cpbase"));
		await vi.waitFor(() => expect(session.store.readOnlyState).toBeNull());
		await session.app.focus.start(config, null);
		const sessionId = session.app.focus.timer()!.sessionId;
		expect(timerOf(fake, "db-a")?.sessionId).toBe(sessionId);
		expect(timerOf(fake, "unknown")).toBeNull();

		// Obsidian restarts: the round is found and offered for recovery.
		plugin.onunload();
		const again = await loadPlugin(fake, "A.cpbase");
		expect(again.session!.focusOpened).toBe("recovery");
		expect(again.session!.app.focus.timer()?.sessionId).toBe(sessionId);
	});

	it("#115: a timer running when the file is replaced by another database is kept under that database's id from then on", async () => {
		const { fake, plugin } = await setup();
		const session = plugin.session!;
		await session.app.focus.start(config, null);
		fake.files.set("A.cpbase", emptyDbText("db-b", "r-bbbbbbbbbbbb"));
		fake.fire("modify", fileOf("A.cpbase"));
		await vi.waitFor(() => expect(session.store.data.meta.dbId).toBe("db-b"));
		await session.app.focus.pause();
		expect(timerOf(fake, "db-b")?.sessionId).toBe(session.app.focus.timer()!.sessionId);
		// Nothing is left under the old id for another database to pick up.
		expect(timerOf(fake, "db-a")).toBeNull();
	});
});
