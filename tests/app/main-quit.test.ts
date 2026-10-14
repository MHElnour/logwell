// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { NoticeAction } from "../../src/obsidian/notices";
import { fakeApp, loadPlugin as loadFakePlugin } from "../obsidian/fake-vault";

const shown = vi.hoisted(() => ({ notices: [] as string[], actions: [] as { message: string; actions: NoticeAction[] }[] }));

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: string) {
			shown.notices.push(message);
		}
	},
}));

vi.mock("../../src/obsidian/notices", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	actionNotice: (message: string, actions: NoticeAction[]) => {
		shown.actions.push({ message, actions });
		return { hide: () => undefined };
	},
}));

// Pending saves are flushed when the app quits. The plugin's onload
// runs against tests/app/obsidian-stub.ts (vitest.config.ts aliases "obsidian"), over the fake vault, and no
// database is opened.

async function loadPlugin() {
	const fake = fakeApp();
	const plugin = await loadFakePlugin(fake, "", { ready: false });
	return { plugin, refs: fake.workspaceRefs, registered: (plugin as unknown as { registered: unknown[] }).registered };
}

describe("plugin lifecycle", () => {
	it("a registered quit handler flushes pending saves", async () => {
		const { plugin, refs, registered } = await loadPlugin();
		const quit = refs.find((r) => r.name === "quit");
		expect(quit).toBeDefined();
		expect(registered).toContain(quit);

		const order: string[] = [];
		const flush = vi.fn(() => Promise.resolve(void order.push("store.flush")));
		const flushRenames = vi.fn(() => void order.push("flushRenames"));
		plugin.session = { app: { noteRenames: { flushRenames } }, store: { flushBeforeQuit: flush } } as unknown as typeof plugin.session;
		const tasks: (() => Promise<unknown>)[] = [];
		quit!.callback({ add: (fn: () => Promise<unknown>) => tasks.push(fn), addPromise: () => undefined });
		expect(tasks).toHaveLength(1);
		await tasks[0]!();
		expect(flush).toHaveBeenCalledTimes(1);
		// Held-back renames are queued before the store writes.
		expect(order).toEqual(["flushRenames", "store.flush"]);

		// Without an open database the task is a no-op.
		plugin.session = null;
		await expect(tasks[0]!()).resolves.toBeUndefined();
	});

	it("#117: the quit task saves a database that is closing or opening too, and waits for each", async () => {
		const { plugin, refs } = await loadPlugin();
		const quit = refs.find((r) => r.name === "quit")!;
		const saved: string[] = [];
		const sessionOf = (name: string) =>
			({
				app: { noteRenames: { flushRenames: () => undefined } },
				store: {
					flushBeforeQuit: () =>
						new Promise<void>((resolve) => {
							setTimeout(() => {
								saved.push(name);
								resolve();
							}, 0);
						}),
				},
			}) as unknown as NonNullable<typeof plugin.session>;
		const fields = plugin as unknown as { openingSession: unknown; closingSession: unknown };
		fields.closingSession = sessionOf("closing");
		fields.openingSession = sessionOf("opening");
		plugin.session = null;
		const tasks: (() => Promise<unknown>)[] = [];
		quit.callback({ add: (fn: () => Promise<unknown>) => tasks.push(fn), addPromise: () => undefined });
		await tasks[0]!();
		expect(saved.sort()).toEqual(["closing", "opening"]);

		// One session in two places is saved once.
		saved.length = 0;
		const open = sessionOf("open");
		plugin.session = open;
		fields.openingSession = open;
		fields.closingSession = null;
		await tasks[0]!();
		expect(saved).toEqual(["open"]);
	});

	it("renames that arrive while the database is opening are applied once it is open", async () => {
		const { plugin } = await loadPlugin();
		plugin.settings.activeDatabasePath = "Checkpoint.cpbase";
		plugin.session = null;
		(plugin as unknown as { openingNow: boolean }).openingNow = true;
		plugin.forwardRename("A.md", "B.md", false);
		plugin.forwardRename("B.md", "Folder/B.md", false);

		const calls: unknown[][] = [];
		const session = {
			app: {
				noteRenames: {
					rewriteNotePaths: (...args: unknown[]) => {
						calls.push(args);
						return Promise.resolve(1);
					},
				},
			},
		} as unknown as NonNullable<typeof plugin.session>;
		await plugin.applyBufferedRenames(session);
		expect(calls).toEqual([
			["A.md", "B.md", false],
			["B.md", "Folder/B.md", false],
		]);
		await plugin.applyBufferedRenames(session);
		expect(calls).toHaveLength(2);
	});

	it("openHabits opens the Habits page, then selects the habit in the view openApp showed, not the active one", async () => {
		const { plugin } = await loadPlugin();
		const calls: string[] = [];
		const shownView = { showHabit: vi.fn((id: string, focus: boolean) => void calls.push(`showHabit ${id} ${focus}`)) };
		const activeView = { showHabit: vi.fn() };
		(plugin.app.workspace as unknown as { getActiveViewOfType: () => unknown }).getActiveViewOfType = () => activeView;
		plugin.openApp = vi.fn((section?: string) => {
			calls.push(`openApp ${section}`);
			return Promise.resolve(shownView as never);
		});
		await plugin.openHabits("h-1", true);
		expect(calls).toEqual(["openApp habits", "showHabit h-1 true"]);
		expect(activeView.showHabit).not.toHaveBeenCalled();
		calls.length = 0;
		await plugin.openHabits(null, false);
		expect(calls).toEqual(["openApp habits"]);
		// No view to show (no database): nothing is selected and nothing throws.
		calls.length = 0;
		plugin.openApp = vi.fn(() => Promise.resolve(null));
		await plugin.openHabits("h-2", false);
		expect(calls).toEqual([]);
	});

	it("the reminder's Undo runs the undo the host bound, and says so when there is nothing to undo", async () => {
		const { plugin } = await loadPlugin();
		const ui = (plugin.reminderHost as unknown as { ui: { notifyUndo(m: string, u: () => Promise<boolean>): void } }).ui;
		shown.notices.length = 0;
		shown.actions.length = 0;
		const results = [true, false];
		const undo = vi.fn(() => Promise.resolve(results.shift()!));
		ui.notifyUndo("Checked in Meditate.", undo);
		expect(shown.actions).toHaveLength(1);
		expect(shown.actions[0]!.message).toBe("Checked in Meditate.");
		const button = shown.actions[0]!.actions.find((a) => a.label === "Undo")!;
		// No session at all: the bound undo still decides (it acts on the database written to).
		plugin.session = null;
		await button.run();
		expect(undo).toHaveBeenCalledTimes(1);
		expect(shown.notices).toEqual([]);
		await button.run();
		expect(undo).toHaveBeenCalledTimes(2);
		expect(shown.notices).toEqual(["Nothing to undo."]);
	});
});
