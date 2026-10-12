import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNDO_NOTICE_MS } from "../../src/obsidian/notices";
import { undoNotice } from "../../src/obsidian/undoNotice";

// Issue 43: the Undo notice of a write has one builder, used by ViewHost.notifyUndo and the session.

const shown = vi.hoisted(() => ({ messages: [] as unknown[], timeouts: [] as number[] }));

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: unknown, timeout: number) {
			shown.messages.push(message);
			shown.timeouts.push(timeout);
		}
		hide(): void {}
	},
}));

interface Button {
	text: string;
	click: () => void;
}
const buttons: Button[] = [];
const texts: string[] = [];

/** A stand-in for Obsidian's createFragment: records the message text and the buttons, runs the click handler. */
function stubCreateFragment(): void {
	const el = {
		createDiv: (o: { text?: string }) => {
			if (o.text !== undefined) texts.push(o.text);
			return el;
		},
		createEl: (_tag: string, o: { text: string }) => {
			const button: Button = { text: o.text, click: () => undefined };
			buttons.push(button);
			return {
				addEventListener: (_type: string, handler: (evt: { stopPropagation(): void }) => void) => {
					button.click = () => handler({ stopPropagation: () => undefined });
				},
			};
		},
	};
	vi.stubGlobal("createFragment", (build: (f: typeof el) => void) => {
		build(el);
		return {};
	});
}

beforeEach(() => {
	shown.messages.length = 0;
	shown.timeouts.length = 0;
	buttons.length = 0;
	texts.length = 0;
	stubCreateFragment();
});

afterEach(() => vi.unstubAllGlobals());

describe("undoNotice", () => {
	it("shows the message with an Undo button that lasts 4 seconds", () => {
		undoNotice({ undoFor: () => async () => true }, "Moved the task.", "Move task", 3);
		expect(texts).toEqual(["Moved the task."]);
		expect(buttons.map((b) => b.text)).toEqual(["Undo"]);
		expect(shown.timeouts).toEqual([UNDO_NOTICE_MS]);
		expect(UNDO_NOTICE_MS).toBe(4000);
	});

	it("binds the Undo button to the entry named by the mark and the label", async () => {
		const undo = vi.fn(async () => true);
		const undoFor = vi.fn(() => undo);
		undoNotice({ undoFor }, "Moved the task.", "Move task", 3);
		expect(undoFor).toHaveBeenCalledWith(3, "Move task");
		buttons[0]!.click();
		await vi.waitFor(() => expect(undo).toHaveBeenCalledTimes(1));
	});
});
