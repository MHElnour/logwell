// @vitest-environment happy-dom
import { Modal } from "obsidian";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { pickListIcon } from "../../src/obsidian/modals";

// The icon picker's grid is a container: Obsidian tooltips any element with an aria-label, so
// the grid is named through aria-labelledby (a visually hidden label), not aria-label.
// `obsidian` is the stub from tests/app/obsidian-stub.ts; the Obsidian DOM helpers are faked.

interface Opts {
	cls?: string;
	text?: string;
	type?: string;
	attr?: Record<string, string>;
}
type Dom = HTMLElement & {
	addClass(...c: string[]): void;
	toggleClass(c: string, on: boolean): void;
	empty(): void;
	createEl(tag: string, o?: Opts): Dom;
	createDiv(o?: Opts): Dom;
	createSpan(o?: Opts): Dom;
};

function dom(tag = "div"): Dom {
	const el = document.createElement(tag) as Dom;
	el.addClass = (...c) => el.classList.add(...c);
	el.toggleClass = (c, on) => {
		for (const cls of [c].flat()) el.classList.toggle(cls, on);
	};
	el.empty = () => el.replaceChildren();
	el.createEl = ((t: string, o: Opts = {}) => {
		const child = dom(t);
		if (o.cls !== undefined) child.className = o.cls;
		if (o.text !== undefined) child.textContent = o.text;
		if (o.type !== undefined) child.setAttribute("type", o.type);
		for (const [k, v] of Object.entries(o.attr ?? {})) child.setAttribute(k, v);
		el.appendChild(child);
		return child;
	}) as unknown as Dom["createEl"];
	el.createDiv = (o) => el.createEl("div", o);
	el.createSpan = (o) => el.createEl("span", o);
	return el;
}

let opened: { contentEl: Dom }[] = [];
beforeAll(() => {
	(Modal as unknown as { prototype: Record<string, unknown> }).prototype.open = function (this: { contentEl: Dom; modalEl: Dom; setTitle: () => void; onOpen: () => void }) {
		this.modalEl = dom();
		this.contentEl = dom();
		this.modalEl.appendChild(this.contentEl);
		document.body.appendChild(this.modalEl);
		this.setTitle = () => undefined;
		this.onOpen();
		opened.push(this);
	};
});
afterEach(() => {
	opened = [];
	document.body.replaceChildren();
});

describe("icon picker", () => {
	it("names the icon grid with aria-labelledby, not aria-label; the buttons keep theirs", () => {
		void pickListIcon({} as never, "inbox");
		const grid = opened[0]!.contentEl.querySelector<HTMLElement>(".cp-icon-grid")!;
		expect(grid.getAttribute("role")).toBe("group");
		expect(grid.hasAttribute("aria-label")).toBe(false);
		const label = document.getElementById(grid.getAttribute("aria-labelledby")!)!;
		expect(label.textContent).toBe("Icons");
		expect(label.classList.contains("cp-sr-only")).toBe(true);
		expect(label.hasAttribute("hidden")).toBe(false);
		const buttons = grid.querySelectorAll("button.cp-icon-choice[aria-label]");
		expect(buttons.length).toBeGreaterThan(0);
	});

	it("uses a unique label id per picker instance", () => {
		void pickListIcon({} as never, null);
		void pickListIcon({} as never, null);
		const ids = opened.map((m) => m.contentEl.querySelector(".cp-icon-grid")!.getAttribute("aria-labelledby"));
		expect(new Set(ids).size).toBe(2);
		const all = [...document.querySelectorAll("[id]")].map((e) => e.id);
		expect(new Set(all).size).toBe(all.length);
	});
});
