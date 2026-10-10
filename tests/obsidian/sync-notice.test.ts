// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The one-time Sync notice closes by itself after 15 s and has a "Got it" button.

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

describe("syncNotice", () => {
	it("closes after 15 seconds and has a Got it button that closes it", async () => {
		const { syncNotice, SYNC_NOTICE_MS } = await import("../../src/obsidian/notices");
		syncNotice();
		expect(SYNC_NOTICE_MS).toBe(15000);
		const n = created[0]!;
		expect(n.timeout).toBe(15000);
		const frag = n.message as DocumentFragment;
		expect(frag.textContent).toContain("Sync all other types");
		const buttons = [...frag.querySelectorAll("button")];
		expect(buttons.map((b) => b.textContent)).toEqual(["Got it"]);
		buttons[0]!.click();
		expect(n.hide).toHaveBeenCalledTimes(1);
	});
});
