// @vitest-environment happy-dom
import { Modal } from "obsidian";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/app/settings";
import { QuickAddModal } from "../../src/obsidian/QuickAddModal";
import { appHarness } from "../app/harness";

// The modal's Escape rules. Obsidian's own Escape handler runs before anything registered
// on the modal scope and calls close(), so close() itself must close an open popover first
// (found by e2e for chip pickers). `obsidian` is the stub from tests/app/obsidian-stub.ts.

type Dom = HTMLElement & { addClass(...c: string[]): void; empty(): void };

function dom(): Dom {
	const el = document.createElement("div") as Dom;
	el.addClass = (...c) => el.classList.add(...c);
	el.empty = () => el.replaceChildren();
	return el;
}

const superClose = vi.fn();
beforeAll(() => {
	(Modal as unknown as { prototype: { close: () => void } }).prototype.close = superClose;
});
afterEach(() => {
	superClose.mockClear();
	document.body.replaceChildren();
});

async function openModal(accent: "theme" | "purple" = "theme", eveningTime = DEFAULT_SETTINGS.eveningTime) {
	const h = await appHarness();
	const plugin = { app: {}, settings: { ...DEFAULT_SETTINGS, accent, eveningTime } };
	const modal = new QuickAddModal(plugin as never, { app: h.app } as never, {});
	const m = modal as unknown as { modalEl: Dom; contentEl: Dom; scope: { register: () => void }; setTitle: () => void };
	m.modalEl = dom();
	m.contentEl = dom();
	m.modalEl.appendChild(m.contentEl);
	document.body.appendChild(m.modalEl);
	m.scope = { register: () => undefined };
	m.setTitle = () => undefined;
	modal.onOpen();
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
	return { modal, modalEl: m.modalEl };
}

describe("QuickAddModal", () => {
	it("puts the accent class on the modal element next to its own class", async () => {
		const { modalEl } = await openModal("purple");
		expect(modalEl.classList.contains("checkpoint-quick-add-modal")).toBe(true);
		expect(modalEl.classList.contains("cp-accent-purple")).toBe(true);
	});

	it("close() with a popover open closes the popover and keeps the modal open", async () => {
		const { modal, modalEl } = await openModal();
		modalEl.querySelector<HTMLButtonElement>('.cp-qa-tool[aria-label="Date"]')!.click();
		await new Promise((r) => setTimeout(r, 0));
		expect(modalEl.querySelector(".cp-date-pop")).not.toBeNull();
		modal.close();
		await new Promise((r) => setTimeout(r, 0));
		expect(modalEl.querySelector(".cp-date-pop")).toBeNull();
		expect(superClose).not.toHaveBeenCalled();
		modal.close();
		expect(superClose).toHaveBeenCalledTimes(1);
	});

	it("a capture-phase Escape on the modal closes only the popover", async () => {
		const { modalEl } = await openModal();
		modalEl.querySelector<HTMLButtonElement>('.cp-qa-tool[aria-label="Priority, list, tags and note"]')!.click();
		await new Promise((r) => setTimeout(r, 0));
		const evt = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		modalEl.querySelector(".cp-quick-add-title")!.dispatchEvent(evt);
		await new Promise((r) => setTimeout(r, 0));
		expect(modalEl.querySelector(".cp-more-pop")).toBeNull();
		expect(evt.defaultPrevented).toBe(true);
		expect(superClose).not.toHaveBeenCalled();
	});

	it("the Tonight quick pick uses the evening time setting", async () => {
		const { modalEl } = await openModal("theme", "17:10");
		modalEl.querySelector<HTMLButtonElement>('.cp-qa-tool[aria-label="Date"]')!.click();
		await new Promise((r) => setTimeout(r, 0));
		const tonight = [...modalEl.querySelectorAll<HTMLButtonElement>(".cp-quick button")].find((b) => b.textContent?.includes("Tonight"))!;
		tonight.click();
		await new Promise((r) => setTimeout(r, 0));
		expect(modalEl.querySelector('.cp-pop-row[data-row="time"] .cp-pop-val')!.textContent).toBe("17:10");
	});
});
