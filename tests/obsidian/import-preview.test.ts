// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ImportPreview } from "../../src/app/DataService";
import { COLLECTIONS, type CollectionName } from "../../src/persistence/schema";

// The Import backup preview: the counts table and the list of records a merge would change, in words.

const modals = vi.hoisted(() => ({ last: null as { contentEl: HTMLElement } | null }));

vi.mock("obsidian", async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>();
	class FakeModal {
		contentEl = document.createElement("div");
		constructor(readonly app: unknown) {
			modals.last = this;
		}
		setTitle(): void {}
		open(): void {
			(this as unknown as { onOpen(): void }).onOpen();
		}
		close(): void {
			(this as unknown as { onClose(): void }).onClose();
		}
	}
	class FakeSetting {
		constructor(readonly el: unknown) {}
		addButton(cb: (b: Record<string, () => unknown>) => void): this {
			const btn: Record<string, () => unknown> = {};
			for (const k of ["setButtonText", "setCta", "setDestructive", "onClick"]) btn[k] = () => btn;
			cb(btn);
			return this;
		}
	}
	return { ...original, Modal: FakeModal, Setting: FakeSetting };
});

beforeAll(() => {
	// Obsidian's createEl, addClass and empty, which happy-dom does not have.
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.createEl = function (this: HTMLElement, tag: string, o: { cls?: string; text?: string } = {}) {
		const node = this.ownerDocument.createElement(tag);
		if (o.cls !== undefined) node.className = o.cls;
		if (o.text !== undefined) node.textContent = o.text;
		this.appendChild(node);
		return node;
	};
	proto.addClass = function (this: HTMLElement, c: string) {
		this.classList.add(c);
	};
	proto.empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
});

describe("import preview", () => {
	it("#137: names every collection in words, sections included, never by its key", async () => {
		const { showImportPreview } = await import("../../src/obsidian/ImportModal");
		const counts = Object.fromEntries(COLLECTIONS.map((c) => [c, 1])) as Record<CollectionName, number>;
		const preview = { schemaVersion: 6, migratedFrom: null, counts, changes: [{ collection: "sections", label: "Doing", kind: "add" }] } as unknown as ImportPreview;
		void showImportPreview({} as never, "backup.json", preview);
		const content = modals.last!.contentEl;
		const text = content.textContent ?? "";
		const cells = [...content.querySelectorAll(".checkpoint-import-counts td:first-child")].map((td) => td.textContent);
		expect(cells).toHaveLength(COLLECTIONS.length);
		expect(cells).toContain("Sections");
		expect(cells.every((c) => /^[A-Z]/u.test(c ?? ""))).toBe(true);
		expect(text).toContain("Sections: Doing (new)");
		expect(text).not.toMatch(/\bsections\b/u);
	});
});
