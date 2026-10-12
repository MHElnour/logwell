// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { QuickAddForm } from "../../src/ui/QuickAddForm";
import { alignPopover, applyPopoverFit, attachPopover, fitPopover } from "../../src/ui/quickadd/popoverFit";
import { appHarness } from "../app/harness";

describe("the popover layer", () => {
	// Issue #85: the date popover and the more menu were cut off by the Quick Add window and by short
	// views. They now live in the top layer (when the Popover API exists), are placed from the add bar's
	// box in window coordinates, and only the window and the status bar limit them.

	beforeAll(() => {
		(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
			this.replaceChildren();
		};
	});

	async function settle(): Promise<void> {
		for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
	}

	const rect = (top: number, height: number, left = 0, width = 0): DOMRect => ({
		top,
		bottom: top + height,
		height,
		left,
		right: left + width,
		width,
		x: left,
		y: top,
		toJSON: () => ({}),
	});

	interface Layout {
		barTop: number;
		barRight?: number;
		popHeight: number;
		popWidth?: number;
		windowHeight: number;
		windowWidth?: number;
		clipBottom?: number;
		statusTop?: number;
	}

	let layout: Layout | null = null;
	const restores: (() => void)[] = [];

	function fakeLayout(opts: Layout): void {
		layout = opts;
		const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			const l = layout!;
			if (this.classList.contains("cp-qa-barwrap") || this.classList.contains("anchor")) return rect(l.barTop, 52, (l.barRight ?? 500) - 400, 400);
			if (this.classList.contains("cp-pop") || this.classList.contains("pop")) return rect(l.barTop + 60, l.popHeight, 0, l.popWidth ?? 336);
			if (this.classList.contains("fake-clip")) return rect(0, l.clipBottom ?? 0, 0, 600);
			if (this.classList.contains("status-bar")) return rect(l.statusTop ?? 0, 30);
			return rect(0, 0);
		});
		const h = window.innerHeight;
		const w = window.innerWidth;
		Object.defineProperty(window, "innerHeight", { value: opts.windowHeight, configurable: true });
		Object.defineProperty(window, "innerWidth", { value: opts.windowWidth ?? 1200, configurable: true });
		restores.push(() => {
			spy.mockRestore();
			Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
			Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
		});
	}

	/** Gives every element the Popover API for one test, recording the calls. */
	function fakePopoverApi(): { shown: HTMLElement[]; hidden: HTMLElement[] } {
		const calls = { shown: [] as HTMLElement[], hidden: [] as HTMLElement[] };
		const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
		proto.showPopover = function (this: HTMLElement) {
			calls.shown.push(this);
		};
		proto.hidePopover = function (this: HTMLElement) {
			calls.hidden.push(this);
		};
		restores.push(() => {
			delete proto.showPopover;
			delete proto.hidePopover;
		});
		return calls;
	}

	let container: HTMLElement | null = null;
	afterEach(() => {
		if (container !== null) render(null, container);
		container?.remove();
		container = null;
		document.querySelectorAll(".fake-clip, .status-bar, .anchor").forEach((e) => e.remove());
		while (restores.length > 0) restores.pop()!();
		layout = null;
		vi.restoreAllMocks();
	});

	async function mountForm(parent: HTMLElement = document.body): Promise<HTMLElement> {
		const app = (await appHarness()).app;
		container = document.createElement("div");
		parent.appendChild(container);
		render(
			<QuickAddForm
				app={app}
				preset={{}}
				locale={() => "en"}
				weekStart={() => "MO"}
				keepOpen={() => false}
				pickNote={async () => null}
				resolveNote={() => []}
				setIcon={(el, icon) => el.setAttribute("data-icon", icon)}
				attachTokenSuggest={() => ({ isOpen: () => false, dispose: () => undefined })}
				onSaved={() => undefined}
				onError={(err) => {
					throw err;
				}}
				onClose={() => undefined}
			/>,
			container,
		);
		await settle();
		return container;
	}

	const tool = (root: HTMLElement, label: string) => root.querySelector<HTMLButtonElement>(`.cp-qa-tool[aria-label="${label}"]`)!;
	const dateTool = (root: HTMLElement) => tool(root, "Date");
	const moreTool = (root: HTMLElement) => tool(root, "Priority, list, tags and note");
	const datePop = (root: HTMLElement) => root.querySelector<HTMLElement>(".cp-date-pop");
	const morePop = (root: HTMLElement) => root.querySelector<HTMLElement>(".cp-more-pop");
	const prop = (el: HTMLElement, name: string) => el.style.getPropertyValue(name);

	/** A short scrolling container around the form, as the Quick Add modal is. */
	function shortModal(): HTMLElement {
		const clip = document.createElement("div");
		clip.className = "fake-clip";
		// A scrolling ancestor, as the modal is (no stylesheet is applied in this environment).
		const real = window.getComputedStyle.bind(window);
		vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) =>
			el.classList.contains("fake-clip") ? ({ overflowY: "auto" } as CSSStyleDeclaration) : real(el, pseudo),
		);
		document.body.appendChild(clip);
		return clip;
	}

	describe("issue #85: only the window limits a top-layer popover", () => {
		it("a short modal around the bar does not shrink the date popover", async () => {
			fakePopoverApi();
			fakeLayout({ barTop: 100, popHeight: 480, windowHeight: 900, clipBottom: 300 });
			const root = await mountForm(shortModal());
			dateTool(root).click();
			await settle();
			expect(prop(datePop(root)!, "--cp-pop-max")).toBe(`${900 - 152 - 8 - 12}px`);
			expect(datePop(root)!.classList.contains("is-above")).toBe(false);
		});

		it("applyPopoverFit ignores an overflow:auto parent and uses the window height", () => {
			fakeLayout({ barTop: 200, popHeight: 480, windowHeight: 800, clipBottom: 260 });
			const clip = shortModal();
			const anchor = document.createElement("div");
			anchor.className = "anchor";
			const pop = document.createElement("div");
			pop.className = "pop";
			anchor.appendChild(pop);
			clip.appendChild(anchor);
			pop.setAttribute("popover", "manual");
			applyPopoverFit(pop);
			expect(prop(pop, "--cp-pop-max")).toBe(`${800 - 252 - 8 - 12}px`);
		});

		it("the status bar still limits the popover", async () => {
			fakeLayout({ barTop: 100, popHeight: 480, windowHeight: 900, statusTop: 870 });
			const status = document.createElement("div");
			status.className = "status-bar";
			document.body.appendChild(status);
			const root = await mountForm();
			dateTool(root).click();
			await settle();
			expect(prop(datePop(root)!, "--cp-pop-max")).toBe(`${870 - 152 - 8 - 12}px`);
		});
	});

	describe("issue #85: the in-place fallback keeps its container's limits", () => {
		it("without the Popover API a short modal still limits the date popover", async () => {
			fakeLayout({ barTop: 100, popHeight: 480, windowHeight: 900, clipBottom: 420 });
			const root = await mountForm(shortModal());
			dateTool(root).click();
			await settle();
			expect(datePop(root)!.hasAttribute("popover")).toBe(false);
			expect(prop(datePop(root)!, "--cp-pop-max")).toBe(`${420 - 152 - 8 - 12}px`);
		});

		it("applyPopoverFit on an in-place popover stops at an overflow:auto parent", () => {
			fakeLayout({ barTop: 200, popHeight: 480, windowHeight: 800, clipBottom: 600 });
			const clip = shortModal();
			const anchor = document.createElement("div");
			anchor.className = "anchor";
			const pop = document.createElement("div");
			pop.className = "pop";
			anchor.appendChild(pop);
			clip.appendChild(anchor);
			applyPopoverFit(pop);
			expect(prop(pop, "--cp-pop-max")).toBe(`${600 - 252 - 8 - 12}px`);
		});
	});

	describe("issue #85: the top layer", () => {
		it("shows the popover once in the top layer, keeps it there across renders and hides it on close", async () => {
			const calls = fakePopoverApi();
			fakeLayout({ barTop: 100, popHeight: 480, windowHeight: 900 });
			const root = await mountForm();
			dateTool(root).click();
			await settle();
			const pop = datePop(root)!;
			expect(pop.getAttribute("popover")).toBe("manual");
			expect(calls.shown).toEqual([pop]);
			// Another render (the Duration tab) does not show it again.
			[...pop.querySelectorAll<HTMLElement>(".cp-seg-tab")].find((t) => t.textContent === "Duration")!.click();
			await settle();
			expect(calls.shown).toHaveLength(1);
			dateTool(root).click();
			await settle();
			expect(datePop(root)).toBeNull();
			expect(calls.hidden).toEqual([pop]);
		});

		it("the more menu goes to the top layer the same way", async () => {
			const calls = fakePopoverApi();
			fakeLayout({ barTop: 100, popHeight: 300, windowHeight: 900 });
			const root = await mountForm();
			moreTool(root).click();
			await settle();
			expect(calls.shown).toEqual([morePop(root)!]);
		});

		it("without the Popover API the popover stays in place, unchanged (no attribute, no window position)", async () => {
			fakeLayout({ barTop: 100, popHeight: 480, windowHeight: 900 });
			const root = await mountForm();
			dateTool(root).click();
			await settle();
			const pop = datePop(root)!;
			expect(pop.hasAttribute("popover")).toBe(false);
			expect(prop(pop, "--cp-pop-left")).toBe("");
			expect(prop(pop, "--cp-pop-top")).toBe("");
			expect(prop(pop, "--cp-pop-max")).toBe(`${900 - 152 - 8 - 12}px`);
		});

		it("a failing showPopover falls back to the in-place popover", () => {
			const pop = document.createElement("div");
			const anchor = document.createElement("div");
			anchor.appendChild(pop);
			document.body.appendChild(anchor);
			(pop as unknown as { showPopover: () => void }).showPopover = () => {
				throw new Error("InvalidStateError");
			};
			const detach = attachPopover(pop, () => undefined);
			expect(pop.hasAttribute("popover")).toBe(false);
			detach();
			anchor.remove();
		});

		it("places the popover in window coordinates: right-aligned under the bar", async () => {
			fakePopoverApi();
			fakeLayout({ barTop: 100, barRight: 900, popHeight: 480, windowHeight: 900, windowWidth: 1200 });
			const root = await mountForm();
			dateTool(root).click();
			await settle();
			const pop = datePop(root)!;
			expect(prop(pop, "--cp-pop-left")).toBe(`${900 - 336}px`);
			expect(prop(pop, "--cp-pop-top")).toBe(`${152 + 8}px`);
		});

		it("opens above in window coordinates with a bottom offset", async () => {
			fakePopoverApi();
			fakeLayout({ barTop: 600, popHeight: 480, windowHeight: 700 });
			const root = await mountForm();
			dateTool(root).click();
			await settle();
			const pop = datePop(root)!;
			expect(pop.classList.contains("is-above")).toBe(true);
			expect(prop(pop, "--cp-pop-bottom")).toBe(`${700 - 600 + 8}px`);
		});
	});

	describe("issue #85: horizontal clamp", () => {
		it("right-aligns to the anchor when it fits", () => {
			expect(alignPopover({ anchorRight: 900, width: 336, viewportWidth: 1200 })).toBe(564);
		});
		it("never starts left of the 8 px margin", () => {
			expect(alignPopover({ anchorRight: 200, width: 336, viewportWidth: 1200 })).toBe(8);
		});
		it("never ends right of the 8 px margin", () => {
			expect(alignPopover({ anchorRight: 1300, width: 336, viewportWidth: 1200 })).toBe(1200 - 8 - 336);
		});
		it("a popover wider than the window starts at the margin", () => {
			expect(alignPopover({ anchorRight: 300, width: 400, viewportWidth: 320 })).toBe(8);
		});
	});

	describe("issue #85: following the anchor", () => {
		it("adds resize and capture-phase scroll listeners and removes them on unmount", async () => {
			fakePopoverApi();
			fakeLayout({ barTop: 100, popHeight: 480, windowHeight: 900 });
			const winAdd = vi.spyOn(window, "addEventListener");
			const winRemove = vi.spyOn(window, "removeEventListener");
			const docAdd = vi.spyOn(document, "addEventListener");
			const docRemove = vi.spyOn(document, "removeEventListener");
			const root = await mountForm();
			dateTool(root).click();
			await settle();
			const resize = winAdd.mock.calls.find((c) => c[0] === "resize");
			const scroll = docAdd.mock.calls.find((c) => c[0] === "scroll");
			expect(resize).toBeDefined();
			expect(scroll).toBeDefined();
			expect(scroll![2]).toEqual(expect.objectContaining({ capture: true }));
			dateTool(root).click();
			await settle();
			expect(winRemove.mock.calls.some((c) => c[0] === "resize" && c[1] === resize![1])).toBe(true);
			expect(docRemove.mock.calls.some((c) => c[0] === "scroll" && c[1] === scroll![1] && (c[2] as AddEventListenerOptions).capture === true)).toBe(true);
		});

		it("a scroll re-places the popover", async () => {
			fakePopoverApi();
			fakeLayout({ barTop: 100, popHeight: 300, windowHeight: 900 });
			const root = await mountForm();
			dateTool(root).click();
			await settle();
			const pop = datePop(root)!;
			expect(prop(pop, "--cp-pop-top")).toBe("160px");
			layout = { ...layout!, barTop: 200 };
			document.body.dispatchEvent(new Event("scroll"));
			expect(prop(pop, "--cp-pop-top")).toBe("260px");
		});

		it("closes the popover when a scroll takes its bar out of the window", async () => {
			fakePopoverApi();
			fakeLayout({ barTop: 100, popHeight: 300, windowHeight: 900 });
			const root = await mountForm();
			dateTool(root).click();
			await settle();
			layout = { ...layout!, barTop: -200 };
			document.body.dispatchEvent(new Event("scroll"));
			await settle();
			expect(datePop(root)).toBeNull();
		});

		it("a scroll that leaves the bar where it was does not re-fit the popover", async () => {
			fakePopoverApi();
			fakeLayout({ barTop: 100, popHeight: 300, windowHeight: 900 });
			const root = await mountForm();
			dateTool(root).click();
			await settle();
			const pop = datePop(root)!;
			const remove = vi.spyOn(pop.style, "removeProperty");
			document.body.dispatchEvent(new Event("scroll"));
			expect(remove).not.toHaveBeenCalled();
		});

		it("a re-fit keeps the popover body's scroll position", async () => {
			fakePopoverApi();
			fakeLayout({ barTop: 100, popHeight: 300, windowHeight: 900 });
			const root = await mountForm();
			dateTool(root).click();
			await settle();
			const pop = datePop(root)!;
			const body = pop.querySelector<HTMLElement>(".cp-pop-body")!;
			// The browser clamps the body's scroll position while the max height is reset; emulate that.
			let stored = 0;
			Object.defineProperty(body, "scrollTop", {
				configurable: true,
				get: () => stored,
				set: (v: number) => {
					stored = v;
				},
			});
			body.scrollTop = 120;
			const remove = pop.style.removeProperty.bind(pop.style);
			vi.spyOn(pop.style, "removeProperty").mockImplementation((name: string) => {
				if (name === "--cp-pop-max") stored = 0;
				return remove(name);
			});
			layout = { ...layout!, barTop: 150 };
			document.body.dispatchEvent(new Event("scroll"));
			expect(body.scrollTop).toBe(120);
			expect(prop(pop, "--cp-pop-top")).toBe("210px");
		});

		it("closes the popover when its bar scrolls out of its scroller, even inside the window", async () => {
			fakePopoverApi();
			fakeLayout({ barTop: 100, popHeight: 300, windowHeight: 900, clipBottom: 300 });
			const root = await mountForm(shortModal());
			dateTool(root).click();
			await settle();
			expect(datePop(root)).not.toBeNull();
			layout = { ...layout!, barTop: 320 };
			document.body.dispatchEvent(new Event("scroll"));
			await settle();
			expect(datePop(root)).toBeNull();
		});

		it("a scroll inside the popover's own body does not re-place it", async () => {
			fakePopoverApi();
			fakeLayout({ barTop: 100, popHeight: 300, windowHeight: 900 });
			const root = await mountForm();
			dateTool(root).click();
			await settle();
			const pop = datePop(root)!;
			layout = { ...layout!, barTop: -200 };
			pop.querySelector(".cp-pop-body")!.dispatchEvent(new Event("scroll"));
			await settle();
			expect(datePop(root)).not.toBeNull();
			expect(prop(pop, "--cp-pop-top")).toBe("160px");
		});
	});

	describe("issue #85: the stylesheet", () => {
		it("resets the browser's popover styles and places a top-layer popover from the variables", async () => {
			const css = (await import("node:fs")).readFileSync("styles.css", "utf8");
			const rule = css.match(/\.checkpoint-view \.cp-pop\[popover\],\s*\.checkpoint-quick-add-modal \.cp-pop\[popover\]\s*\{([^}]*)\}/);
			expect(rule).not.toBeNull();
			const body = rule![1]!;
			expect(body).toMatch(/position:\s*fixed/);
			expect(body).toMatch(/inset:\s*auto/);
			expect(body).toMatch(/margin:\s*0/);
			expect(body).toMatch(/top:\s*var\(--cp-pop-top\)/);
			expect(body).toMatch(/left:\s*var\(--cp-pop-left\)/);
			expect(css).toMatch(/\.cp-pop\[popover\]\.is-above[^{]*\{[^}]*bottom:\s*var\(--cp-pop-bottom\)/);
			// Padding and overflow are reset without beating the more menu's own padding and scrolling.
			const reset = css.match(/\.checkpoint-view :where\(\.cp-pop\[popover\]\),\s*\.checkpoint-quick-add-modal :where\(\.cp-pop\[popover\]\)\s*\{([^}]*)\}/);
			expect(reset).not.toBeNull();
			expect(reset![1]).toMatch(/padding:\s*0/);
			expect(reset![1]).toMatch(/overflow:\s*visible/);
		});
	});
});

// The date popover (about 480 px tall) must not be cut off at the bottom of short
// views and of the Quick Add modal, or OK would hide under Obsidian's status bar.

describe("fitPopover", () => {
	const base = { anchorTop: 100, anchorBottom: 152, limitTop: 0, limitBottom: 1000, natural: 480 };

	it("opens below with no constraint beyond the 480 px cap when there is room", () => {
		expect(fitPopover(base)).toEqual({ above: false, maxHeight: 1000 - 152 - 8 - 12 });
	});

	it("limits the height to the space below the bar, minus the gap and a margin", () => {
		expect(fitPopover({ ...base, limitBottom: 500 })).toEqual({ above: false, maxHeight: 500 - 152 - 8 - 12 });
	});

	it("flips above the bar when the space below is too small and above has more", () => {
		const r = fitPopover({ ...base, anchorTop: 600, anchorBottom: 652, limitBottom: 700 });
		expect(r.above).toBe(true);
		expect(r.maxHeight).toBe(600 - 0 - 8 - 12);
	});

	it("stays below when above is no better", () => {
		const r = fitPopover({ ...base, anchorTop: 60, anchorBottom: 112, limitBottom: 400 });
		expect(r.above).toBe(false);
		expect(r.maxHeight).toBe(400 - 112 - 8 - 12);
	});

	it("never goes under a minimum height, even with almost no space", () => {
		expect(fitPopover({ ...base, anchorTop: 10, anchorBottom: 62, limitBottom: 80 }).maxHeight).toBe(160);
	});

	it("does not flip when the popover fits below", () => {
		expect(fitPopover({ ...base, natural: 200, anchorTop: 600, anchorBottom: 652, limitBottom: 900 }).above).toBe(false);
	});
});
