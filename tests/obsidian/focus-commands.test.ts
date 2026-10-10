// @vitest-environment happy-dom
import { Plugin } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyDbText } from "../persistence/fixtures";
import { fakeApp, loadPlugin } from "./fake-vault";

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

afterEach(() => vi.restoreAllMocks());

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
});
