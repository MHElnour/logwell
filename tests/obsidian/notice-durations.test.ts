// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Notice durations: Undo notices close after 4 s; every other notice keeps its own length (issue 61).

const created = vi.hoisted(() => [] as { message: unknown; timeout: number | undefined; hide: ReturnType<typeof vi.fn> }[]);

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		hide = vi.fn();
		constructor(message: unknown, timeout?: number) {
			created.push({ message, timeout, hide: this.hide });
		}
	},
}));

beforeEach(() => {
	created.length = 0;
	const g = window as unknown as Record<string, unknown>;
	const make = (parent: Node, tag: string, o?: { text?: string; cls?: string }) => {
		const el = document.createElement(tag);
		if (o?.text !== undefined) el.textContent = o.text;
		if (o?.cls !== undefined) el.className = o.cls;
		parent.appendChild(el);
		return el;
	};
	for (const proto of [Node.prototype]) {
		(proto as unknown as Record<string, unknown>).createDiv = function (this: Node, o?: { text?: string; cls?: string }) {
			return make(this, "div", o);
		};
		(proto as unknown as Record<string, unknown>).createEl = function (this: Node, tag: string, o?: { text?: string; cls?: string }) {
			return make(this, tag, o);
		};
	}
	g.createFragment = (cb: (f: DocumentFragment) => void) => {
		const f = document.createDocumentFragment();
		cb(f);
		return f;
	};
});

describe("notice durations", () => {
	it("an Undo notice closes after 4 seconds", async () => {
		const { actionNotice, undoAction, UNDO_NOTICE_MS } = await import("../../src/obsidian/notices");
		expect(UNDO_NOTICE_MS).toBe(4000);
		actionNotice("Done", [undoAction(async () => true)]);
		expect(created[0]!.timeout).toBe(4000);
	});

	it("notices without an Undo button keep 8 seconds, and an explicit length wins", async () => {
		const { actionNotice, undoAction } = await import("../../src/obsidian/notices");
		actionNotice("Some database records were repaired: x", []);
		actionNotice("Open settings", [{ label: "Open settings", run: () => undefined }]);
		actionNotice("Added \"x\"", [], 3000);
		actionNotice("Reminder", [undoAction(async () => true)], 0);
		expect(created.map((n) => n.timeout)).toEqual([8000, 8000, 3000, 0]);
	});

	it("the Sync notice stays at 15 seconds", async () => {
		const { syncNotice, SYNC_NOTICE_MS } = await import("../../src/obsidian/notices");
		syncNotice();
		expect(SYNC_NOTICE_MS).toBe(15000);
		expect(created[0]!.timeout).toBe(15000);
	});
});

