// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { NOTHING_TO_UNDO } from "../../src/ui/format";
import { undoAction } from "../../src/obsidian/notices";
import { ViewHost } from "../../src/obsidian/host";

// Issue 19: an Undo button that cannot undo says "Nothing to undo.", whichever notice it is on.

const shown = vi.hoisted(() => ({ notices: [] as unknown[], actions: [] as { label: string; run: () => unknown }[][] }));

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: unknown) {
			shown.notices.push(message);
		}
	},
}));

vi.mock("../../src/obsidian/notices", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	actionNotice: (_message: string, actions: { label: string; run: () => unknown }[]) => {
		shown.actions.push(actions);
		return {};
	},
}));

describe("a refused Undo from a notice", () => {
	it("says Nothing to undo. on a task notice (ViewHost.notifyUndo)", async () => {
		shown.notices.length = 0;
		shown.actions.length = 0;
		const session = { app: { store: { undoFor: () => () => Promise.resolve(false) } } };
		new ViewHost({} as never, session as never, null).notifyUndo("Done", "Complete task", 0);
		await shown.actions[0]![0]!.run();
		expect(shown.notices).toEqual([NOTHING_TO_UNDO]);
		expect(NOTHING_TO_UNDO).toBe("Nothing to undo.");
	});

	it("says nothing when the undo works", async () => {
		shown.notices.length = 0;
		await undoAction(() => Promise.resolve(true)).run();
		expect(shown.notices).toEqual([]);
	});

	it("says Nothing to undo. by default for any Undo button, and lets a caller route it", async () => {
		shown.notices.length = 0;
		await undoAction(() => Promise.resolve(false)).run();
		expect(shown.notices).toEqual([NOTHING_TO_UNDO]);
		const routed: string[] = [];
		await undoAction(() => Promise.resolve(false), () => routed.push("x")).run();
		expect(routed).toEqual(["x"]);
		expect(shown.notices).toEqual([NOTHING_TO_UNDO]);
	});
});
