// NOT RUN. These specs were written in a cloud session that cannot start
// Obsidian. They typecheck (`npx tsc -p e2e-tests/tsconfig.json`) but have never
// executed. Run `npm run e2e` locally and fix what the real app shows.
// The add bar's popovers and layout in the real app, where happy-dom has no layout: popovers shown in full
// over the Quick Add modal and in a short view, the All fields grid, and the highlight layer's width. The keys,
// picks and saves of the add bar are in tests/ui/add-bar.test.tsx.
import { browser, expect } from "@wdio/globals";
import {
	closeQuickAdd,
	freshDatabase,
	openQuickAdd,
	showInbox,
	visibleTasksSection,
} from "../helpers";

const addInput = (section: WebdriverIO.Element) => section.$('.cp-add-bar input[aria-label="Add task"]');
const dateTool = (scope: WebdriverIO.Element) => scope.$('.cp-qa-tool[aria-label="Date"]');
const moreTool = (scope: WebdriverIO.Element) => scope.$('.cp-qa-tool[aria-label="Priority, list, tags and note"]');

async function openInboxBar(): Promise<WebdriverIO.Element> {
	const section = await visibleTasksSection();
	await showInbox(section);
	await addInput(section).waitForExist({ timeout: 5000 });
	return section;
}

interface PopGeometry {
	layered: boolean;
	count: number;
	popTop: number;
	popBottom: number;
	limit: number;
	allInside: boolean;
	lastHit: boolean;
	modalScrolls: boolean;
}

/**
 * Measures the open popover in the visible view or modal: its body is scrolled to the end first,
 * then the last `item` is hit-tested at its center, so a popover clipped by the modal or a
 * scroller fails. `limit` is the window height above Obsidian's status bar.
 */
async function popGeometry(popSel: string, itemSel: string): Promise<PopGeometry | null> {
	return browser.execute(
		(pSel: string, iSel: string) => {
			const pop = Array.from(document.querySelectorAll<HTMLElement>(pSel)).filter((p) => p.getClientRects().length > 0).pop();
			if (pop === undefined) return null;
			const body = pop.querySelector<HTMLElement>(".cp-pop-body") ?? pop;
			body.scrollTop = body.scrollHeight;
			const statusTop = document.querySelector(".status-bar")?.getBoundingClientRect().top ?? 0;
			const limit = statusTop > 0 ? Math.min(window.innerHeight, statusTop) : window.innerHeight;
			const items = Array.from(pop.querySelectorAll<HTMLElement>(iSel));
			const last = items[items.length - 1];
			let lastHit = false;
			if (last !== undefined) {
				const r = last.getBoundingClientRect();
				const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
				lastHit = hit !== null && last.contains(hit);
			}
			const p = pop.getBoundingClientRect();
			const modal = pop.closest<HTMLElement>(".modal");
			return {
				layered: pop.matches(":popover-open"),
				count: items.length,
				popTop: p.top,
				popBottom: p.bottom,
				limit,
				allInside: items.every((i) => {
					const r = i.getBoundingClientRect();
					return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
				}),
				lastHit,
				modalScrolls: modal !== null && modal.scrollHeight > modal.clientHeight + 1,
			};
		},
		popSel,
		itemSel,
	);
}

function expectFullyShown(g: PopGeometry | null, minItems: number): void {
	expect(g).not.toBeNull();
	expect(g!.layered).toBe(true);
	expect(g!.count).toBeGreaterThanOrEqual(minItems);
	expect(g!.popTop).toBeGreaterThanOrEqual(0);
	expect(g!.popBottom).toBeLessThanOrEqual(g!.limit + 0.5);
	expect(g!.allInside).toBe(true);
	expect(g!.lastHit).toBe(true);
	expect(g!.modalScrolls).toBe(false);
}

/** The Obsidian window's outer size through Electron (the driver has no window/rect command here). */
async function windowSize(): Promise<{ width: number; height: number }> {
	return browser.execute(() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const [width, height] = (window as any).require("@electron/remote").getCurrentWindow().getSize() as [number, number];
		return { width, height };
	});
}

async function resizeWindow(width: number, height: number): Promise<void> {
	await browser.execute(
		(w, h) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(window as any).require("@electron/remote").getCurrentWindow().setSize(w, h);
		},
		width,
		height,
	);
	await browser.pause(300);
}

describe("Popovers are never cut off (#85)", function () {
	let size: { width: number; height: number } | null = null;

	before(async function () {
		size = await windowSize();
		await resizeWindow(1400, 900);
	});

	after(async function () {
		if (size !== null) await resizeWindow(size.width, size.height);
	});

	beforeEach(async function () {
		await freshDatabase();
	});

	afterEach(async function () {
		await resizeWindow(1400, 900);
		await closeQuickAdd();
	});

	it("the Quick Add modal: the date popover's Repeat presets show in full, over the modal", async function () {
		const modal = await openQuickAdd();
		await dateTool(modal).click();
		const pop = modal.$(".cp-date-pop");
		await pop.waitForDisplayed({ timeout: 3000 });
		await pop.$(".cp-pop-row[data-row='repeat']").click();
		await pop.$(".cp-repeat-opts").waitForDisplayed({ timeout: 3000 });
		const g = await popGeometry(".checkpoint-quick-add-modal .cp-date-pop", ".cp-repeat-opt");
		expectFullyShown(g, 5);
		// The listbox itself ends above the status bar.
		const listBottom = await browser.execute(
			() => document.querySelector(".checkpoint-quick-add-modal .cp-repeat-opts")?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY,
		);
		expect(listBottom).toBeLessThanOrEqual(g!.limit + 0.5);
	});

	it("the Quick Add modal: the more menu shows in full, over the modal", async function () {
		const modal = await openQuickAdd();
		await moreTool(modal).click();
		await modal.$(".cp-more-pop").waitForDisplayed({ timeout: 3000 });
		expectFullyShown(await popGeometry(".checkpoint-quick-add-modal .cp-more-pop", ".cp-pop-row"), 4);
	});

	it("the Quick Add modal at a 600 px tall window: the date popover's OK is reachable", async function () {
		await resizeWindow(1400, 600);
		const modal = await openQuickAdd();
		await dateTool(modal).click();
		await modal.$(".cp-date-pop").waitForDisplayed({ timeout: 3000 });
		expectFullyShown(await popGeometry(".checkpoint-quick-add-modal .cp-date-pop", ".cp-pop-ok"), 1);
	});

	it("the inline add bar in a short view: the date popover shows in full and the list does not grow", async function () {
		await resizeWindow(1400, 600);
		const section = await openInboxBar();
		const scrollBefore = await browser.execute(() => {
			const main = Array.from(document.querySelectorAll<HTMLElement>(".cp-main")).find((m) => m.offsetParent !== null);
			return main?.scrollHeight ?? 0;
		});
		await dateTool(section).click();
		const pop = section.$(".cp-add-bar .cp-date-pop");
		await pop.waitForDisplayed({ timeout: 3000 });
		await pop.$(".cp-pop-row[data-row='repeat']").click();
		await pop.$(".cp-repeat-opts").waitForDisplayed({ timeout: 3000 });
		expectFullyShown(await popGeometry(".checkpoint-view .cp-add-bar .cp-date-pop", ".cp-repeat-opt"), 5);
		const scrollAfter = await browser.execute(() => {
			const main = Array.from(document.querySelectorAll<HTMLElement>(".cp-main")).find((m) => m.offsetParent !== null);
			return main?.scrollHeight ?? 0;
		});
		expect(scrollAfter).toBe(scrollBefore);
	});
});

describe("Quick Add All fields lines up (#85)", function () {
	beforeEach(async function () {
		await freshDatabase();
	});

	afterEach(async function () {
		await closeQuickAdd();
	});

	it("three aligned columns, Link existing note below the tag box, List drawn like an input, Time says it needs a date", async function () {
		const modal = await openQuickAdd();
		await modal.$(".cp-quick-add-all > summary").click();
		await modal.$(".cp-quick-add-fields").waitForDisplayed({ timeout: 3000 });
		const r = await browser.execute(() => {
			const root = document.querySelector<HTMLElement>(".checkpoint-quick-add-modal")!;
			const fields = Array.from(root.querySelectorAll<HTMLElement>(".cp-quick-add-fields > .cp-field:not(.cp-field-row)"));
			const lefts = [...new Set(fields.map((f) => Math.round(f.getBoundingClientRect().left)))];
			const tagBottom = root.querySelector(".cp-tag-input")!.getBoundingClientRect().bottom;
			const noteTop = root.querySelector(".cp-quick-add-note")!.getBoundingClientRect().top;
			const select = root.querySelector<HTMLElement>(".cp-quick-add-fields select")!;
			const input = root.querySelector<HTMLElement>('.cp-quick-add-fields input[type="number"]')!;
			const hint = root.querySelector<HTMLElement>(".cp-quick-add-fields .cp-field-hint");
			return {
				columns: lefts.length,
				gap: noteTop - tagBottom,
				selectBg: getComputedStyle(select).backgroundColor,
				inputBg: getComputedStyle(input).backgroundColor,
				hint: hint?.textContent ?? "",
			};
		});
		expect(r.columns).toBe(3);
		expect(r.gap).toBeGreaterThanOrEqual(4);
		expect(r.selectBg).toBe(r.inputBg);
		expect(r.hint).toContain("needs a date");
	});
});

describe("Add bar: highlight alignment", function () {
	beforeEach(async function () {
		await freshDatabase();
	});

	it("the highlight layer is exactly as wide as the typed text, with many adjacent tokens", async function () {
		const section = await visibleTasksSection();
		const bar = section.$(".cp-qa-input");
		await bar.click();
		await browser.keys("Prepare demo next friday at 2:30pm for 1h30m by oct 12 #Inbox !1".split(""));
		await browser.pause(300);
		const r = await browser.execute(() => {
			const views = Array.from(document.querySelectorAll<HTMLElement>(".cp-tasks")).filter((e) => e.offsetParent !== null);
			const root = views[0]!;
			const input = root.querySelector<HTMLInputElement>(".cp-qa-input")!;
			const run = root.querySelector<HTMLElement>(".cp-qa-mirror-text")!;
			const ctx = document.createElement("canvas").getContext("2d")!;
			const cs = getComputedStyle(input);
			ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
			return { text: ctx.measureText(input.value).width, mirror: run.getBoundingClientRect().width };
		});
		expect(Math.abs(r.mirror - r.text)).toBeLessThan(2);
	});
});
