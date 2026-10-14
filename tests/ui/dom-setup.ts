import { expect } from "vitest";

// Obsidian's element additions that the UI and the modals call and happy-dom does not have, installed before every
// tests/ui file that runs in a DOM (`ObsidianElement` in app-helpers.tsx types them). Files elsewhere (tests/obsidian,
// tests/perf) install their own, so they are left alone.

interface ElementOptions {
	cls?: string;
	text?: string;
	type?: string;
	attr?: Record<string, string>;
}

const inUiTests = /[\\/]tests[\\/]ui[\\/]/u.test(expect.getState().testPath ?? "");

if (inUiTests && typeof HTMLElement !== "undefined") {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
	proto.addClass = function (this: HTMLElement, ...classes: string[]) {
		this.classList.add(...classes);
	};
	proto.toggleClass = function (this: HTMLElement, classes: string | string[], on: boolean) {
		for (const c of [classes].flat()) this.classList.toggle(c, on);
	};
	proto.createEl = function (this: HTMLElement, tag: string, o: ElementOptions = {}) {
		const node = this.ownerDocument.createElement(tag);
		if (o.cls !== undefined) node.className = o.cls;
		if (o.text !== undefined) node.textContent = o.text;
		if (o.type !== undefined) node.setAttribute("type", o.type);
		for (const [k, v] of Object.entries(o.attr ?? {})) node.setAttribute(k, v);
		this.appendChild(node);
		return node;
	};
	proto.createDiv = function (this: HTMLElement, o: ElementOptions = {}) {
		return (this as unknown as { createEl: (tag: string, o: ElementOptions) => HTMLElement }).createEl("div", o);
	};
	proto.createSpan = function (this: HTMLElement, o: ElementOptions = {}) {
		return (this as unknown as { createEl: (tag: string, o: ElementOptions) => HTMLElement }).createEl("span", o);
	};
}
