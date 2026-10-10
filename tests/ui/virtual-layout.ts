import { settle } from "./u1-helpers";

// A tiny block layout for happy-dom, which has none, for the windowed-list tests.
// Every element stacks its children top to bottom; a rule gives the height of leaves (a row, a heading, a
// card); a spacer is as tall as its `--cp-virtual-h`; a scroller is as tall as its viewport and moves its content
// up by its scrollTop. Board columns sit side by side, 300 px wide with a 10 px gap. getBoundingClientRect,
// clientHeight, scrollHeight and scrollTop follow that layout, and focus() scrolls like a browser, until `restore()`.

export interface LayoutRules {
	/** The height of an element that is not a scroller, or undefined to sum its children. */
	height(el: HTMLElement): number | undefined;
	/** The viewport height of a scroller, or undefined for any other element. */
	viewport(el: HTMLElement): number | undefined;
}

export interface FakeLayout {
	/** Sets a scroller's scrollTop (clamped like a browser) and fires its scroll event. */
	scrollTo(el: HTMLElement, top: number): Promise<void>;
	/** The height of everything inside a scroller. */
	contentHeight(el: HTMLElement): number;
	restore(): void;
}

const COLUMN_W = 300;
const COLUMN_GAP = 10;
const PAGE_W = 1000;

export function fakeLayout(rules: LayoutRules): FakeLayout {
	const scrollTops = new WeakMap<HTMLElement, number>();
	const saved = {
		rect: Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect")!,
		// happy-dom keeps clientHeight on HTMLElement and the others on Element.
		clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
		scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight"),
		scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop"),
	};
	const viewport = (el: HTMLElement) => rules.viewport(el);
	// Board columns sit side by side: together they are as tall as the tallest.
	const inline = (el: Element) => el.classList.contains("cp-board-col");
	const stacked = (children: Iterable<Element>, stop: Element | null): number => {
		let sum = 0;
		let row = 0;
		for (const c of children) {
			if (c === stop) break;
			if (inline(c)) row = Math.max(row, height(c as HTMLElement));
			else sum += height(c as HTMLElement);
		}
		return sum + row;
	};
	const contentHeight = (el: HTMLElement): number => stacked(el.children, null);
	const height = (el: HTMLElement): number => {
		if (el.hidden || el.style?.display === "none") return 0;
		const vp = viewport(el);
		if (vp !== undefined) return vp;
		const own = rules.height(el);
		if (own !== undefined) return own;
		if (el.classList.contains("cp-virtual-spacer")) return parseFloat(el.style.getPropertyValue("--cp-virtual-h")) || 0;
		return contentHeight(el);
	};
	const scrollTopOf = (el: HTMLElement) => scrollTops.get(el) ?? 0;
	const top = (el: HTMLElement): number => {
		const parent = el.parentElement;
		if (parent === null) return 0;
		const t = top(parent) - (viewport(parent) !== undefined ? scrollTopOf(parent) : 0);
		if (!inline(el)) return t + stacked(parent.children, el);
		// A column starts at the top of its row, after the stacked siblings before it.
		const before = [...parent.children];
		return t + stacked(before.slice(0, before.indexOf(el)).filter((c) => !inline(c)), null);
	};
	const horizontal = (el: HTMLElement): { left: number; width: number } => {
		if (el.classList.contains("cp-board-col") && el.parentElement !== null) {
			const cols = [...el.parentElement.children].filter((c) => c.classList.contains("cp-board-col"));
			return { left: cols.indexOf(el) * (COLUMN_W + COLUMN_GAP), width: COLUMN_W };
		}
		return el.parentElement === null ? { left: 0, width: PAGE_W } : horizontal(el.parentElement);
	};

	Object.defineProperty(Element.prototype, "getBoundingClientRect", {
		configurable: true,
		value: function (this: HTMLElement) {
			const t = top(this);
			const h = height(this);
			const { left, width } = horizontal(this);
			return { left, top: t, right: left + width, bottom: t + h, width, height: h, x: left, y: t, toJSON: () => ({}) } as DOMRect;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return viewport(this) ?? height(this);
		},
	});
	Object.defineProperty(Element.prototype, "scrollHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return viewport(this) !== undefined ? Math.max(contentHeight(this), viewport(this)!) : height(this);
		},
	});
	Object.defineProperty(Element.prototype, "scrollTop", {
		configurable: true,
		get(this: HTMLElement) {
			return scrollTopOf(this);
		},
		set(this: HTMLElement, v: number) {
			const vp = viewport(this);
			if (vp === undefined) return;
			const max = Math.max(0, contentHeight(this) - vp);
			scrollTops.set(this, Math.min(Math.max(0, v), max));
		},
	});

	// Like a browser, focusing an element scrolls its nearest scroller just enough to show it.
	const focus = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")!;
	Object.defineProperty(HTMLElement.prototype, "focus", {
		configurable: true,
		writable: true,
		value: function (this: HTMLElement, opts?: FocusOptions) {
			(focus.value as (o?: FocusOptions) => void).call(this, opts);
			if (opts?.preventScroll === true) return;
			let s = this.parentElement;
			while (s !== null && viewport(s) === undefined) s = s.parentElement;
			if (s === null) return;
			const vp = viewport(s)!;
			const r = this.getBoundingClientRect();
			const sr = s.getBoundingClientRect();
			const before = s.scrollTop;
			if (r.top < sr.top) s.scrollTop = before - (sr.top - r.top);
			else if (r.bottom > sr.top + vp) s.scrollTop = before + (r.bottom - (sr.top + vp));
			if (s.scrollTop !== before) s.dispatchEvent(new Event("scroll"));
		},
	});

	return {
		async scrollTo(el, y) {
			el.scrollTop = y;
			el.dispatchEvent(new Event("scroll"));
			await settle();
		},
		contentHeight,
		restore() {
			Object.defineProperty(Element.prototype, "getBoundingClientRect", saved.rect);
			Object.defineProperty(HTMLElement.prototype, "focus", focus);
			for (const [target, name, d] of [
				[HTMLElement.prototype, "clientHeight", saved.clientHeight],
				[Element.prototype, "scrollHeight", saved.scrollHeight],
				[Element.prototype, "scrollTop", saved.scrollTop],
			] as const) {
				if (d === undefined) delete (target as unknown as Record<string, unknown>)[name];
				else Object.defineProperty(target, name, d);
			}
		},
	};
}
