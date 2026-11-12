import { describe, expect, it } from "vitest";
import { css, cssBlock, cssSection, sectionMarks, selectors, uncommented } from "./styles-helpers";

// The stylesheet as a whole: its sections, the app breakpoints, the list column and the row parts. With thresholds
// that are too small for the pane widths, an app width of about 960 px with the details open squeezes the list
// column to about 200 px. happy-dom has no layout, so these tests read the stylesheet. The e2e spec ui.e2e.ts checks
// the real widths.

const px = (name: string): number => Number(new RegExp(`${name}:\\s*(\\d+)px`).exec(css)![1]);
const containerQueries = (name: string): number[] =>
	[...css.matchAll(new RegExp(`@container ${name} \\(max-width: (\\d+)px\\)`, "g"))].map((m) => Number(m[1]));
const MIN_LIST = 440;

/** The sections the UI tests read, with the selectors every rule of the section starts with. */
const SECTIONS: [string, RegExp][] = [
	["M3 calendar", /^\.checkpoint-view/],
	["Release B windowed lists", /^\.checkpoint-view /],
	["M5 focus", /^(\.checkpoint-view |\.status-bar-item\.cp-focus-status)/],
	["M6 habits", /^\.checkpoint-(view|habit-dialog)/],
	["#4 dashboard block", /^(\.checkpoint-view ?|\.cm-embed-block )\.cp-block\b/],
	["Issue #6 TickTick sync", /^\.checkpoint-(view|tt-dialog)/],
	["M7 recurrence", /^\.checkpoint-(view|quick-add-modal) /],
];

describe("stylesheet sections", () => {
	it("each is present once and closed before the next one opens, and the repeat section is the last block of the file", () => {
		const marks = sectionMarks();
		const names = marks.filter((m) => !m.end).map((m) => m.name);
		expect(new Set(names).size).toBe(names.length);
		marks.forEach((m, i) => {
			expect(m.end, m.name).toBe(i % 2 === 1);
			if (m.end) expect(marks[i - 1]!.name.startsWith(m.name), m.name).toBe(true);
		});
		expect(css.trimEnd().endsWith("/* == end M7 recurrence == */")).toBe(true);
	});

	it.each(SECTIONS)("%s: every rule is scoped, with no !important, no :has, no lookbehind and no hard-coded colors", (name, scope) => {
		const bare = uncommented(cssSection(name));
		expect(bare).not.toBe("");
		expect(selectors(bare).filter((s) => !scope.test(s))).toEqual([]);
		expect(bare).not.toMatch(/!important/);
		expect(bare).not.toMatch(/:has\(/);
		expect(bare).not.toMatch(/\(\?<[=!]/);
		expect(bare).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(bare).not.toMatch(/\b(rgba?|hsla?)\(/);
	});
});

describe("app breakpoints", () => {
	it("the old 900 and 600 px thresholds are gone", () => {
		expect(containerQueries("cp-app")).not.toContain(900);
		expect(containerQueries("cp-app")).not.toContain(600);
	});

	it("the details pane is a drawer below 1200 px, so the list keeps at least 440 px", () => {
		const rail = px("--cp-rail-w");
		const side = px("--cp-side-w");
		const details = px("--cp-details-w");
		expect(containerQueries("cp-app")).toContain(1200);
		expect(rail + side + details + MIN_LIST).toBeLessThanOrEqual(1200);
		const q = cssBlock("@container cp-app (max-width: 1200px)");
		expect(q).toMatch(/\.cp-details-pane\s*\{[^}]*position:\s*absolute/);
		expect(q).toMatch(/\.cp-details-close\s*\{[^}]*display:\s*inline-flex/);
	});

	it("the sidebar collapses behind the menu button below 800 px", () => {
		expect(containerQueries("cp-app")).toContain(800);
		const q = cssBlock("@container cp-app (max-width: 800px)");
		expect(q).toMatch(/\.cp-sidebar-pane\s*\{[^}]*display:\s*none/);
		expect(q).toMatch(/is-sidebar-open \.cp-sidebar-pane\s*\{[^}]*position:\s*absolute/);
		expect(q).toMatch(/\.cp-sidebar-toggle\s*\{[^}]*display:\s*inline-flex/);
	});

	it("keeps the mechanics the e2e specs use", () => {
		for (const cls of [".cp-details-pane", ".cp-details-close", ".cp-sidebar-toggle", ".cp-sidebar-pane"]) expect(css).toContain(cls);
	});
});

describe("list column", () => {
	it("cannot collapse below a readable width inside the inline layout", () => {
		expect(cssBlock(".checkpoint-view .cp-main {")).toMatch(/min-width:\s*min\(440px,\s*100%\)/);
	});

	it("is a size container, so rows adapt to the list width and not the window", () => {
		const main = cssBlock(".checkpoint-view .cp-main {");
		expect(main).toMatch(/container-type:\s*inline-size/);
		expect(main).toMatch(/container-name:\s*cp-list/);
	});

	it("a row has no fixed height and keeps a minimum hit height", () => {
		const row = cssBlock(".checkpoint-view .cp-task-row {");
		expect(row).toMatch(/min-height:\s*var\(--cp-hit\)/);
		expect(row).not.toMatch(/(^|[\s;])height:/);
		expect(css).not.toContain("--cp-row-h");
		// The matrix frames the same row as a card and the drag ghost copies it: both take the row's natural height.
		expect(cssBlock(".checkpoint-view .cp-matrix-q .cp-task-row {")).not.toMatch(/(^|[\s;])height:/);
		expect(cssBlock(".checkpoint-view .cp-matrix-ghost {")).not.toMatch(/(^|[\s;])height:/);
		for (const token of ["--cp-row-pad-y", "--cp-row-date-size", "--cp-row-meta-size", "--cp-row-meta-icon"]) expect(css, token).toContain(`${token}: `);
	});

	it("the title shrinks to an ellipsis and the date never shrinks, so the date stays inside the row", () => {
		const t = cssBlock(".checkpoint-view .cp-task-title {");
		expect(t).toMatch(/min-width:\s*0/);
		expect(t).toMatch(/text-overflow:\s*ellipsis/);
		expect(t).toMatch(/overflow:\s*hidden/);
		expect(cssBlock(".checkpoint-view .cp-task-body {")).toMatch(/min-width:\s*0/);
		expect(cssBlock(".checkpoint-view .cp-task-top > .cp-meta-date {")).toMatch(/flex:\s*none/);
	});

	it("the second line wraps and nothing is hidden by width", () => {
		const meta = cssBlock(".checkpoint-view .cp-task-meta {");
		expect(meta).toMatch(/flex-wrap:\s*wrap/);
		expect(meta).toMatch(/min-width:\s*0/);
		expect(meta).not.toMatch(/overflow:\s*hidden/);
		// No mark is hidden when the list narrows: no container query on the list, no `display: none` on a mark.
		expect(containerQueries("cp-list")).toEqual([]);
		expect(uncommented(css)).not.toMatch(/(\.cp-meta-[\w-]+|\.cp-task-meta)[^{}]*\{[^}]*display:\s*none/);
	});
});

describe("view header", () => {
	it("the title does not shrink, so 'Today' is never cut to 'To…'", () => {
		const t = cssBlock(".checkpoint-view .cp-main-title {");
		expect(t).toMatch(/flex:\s*0 0 auto/);
		// A very long list name may still ellipsize, but only against the whole header width.
		expect(t).toMatch(/max-width:\s*100%/);
	});

	it("the search field shrinks to 120 px and the header wraps before anything else shrinks", () => {
		const s = cssBlock(".checkpoint-view .cp-view-search {");
		expect(s).toMatch(/min-width:\s*120px/);
		expect(s).toMatch(/flex:\s*1 1 120px/);
		expect(cssBlock(".checkpoint-view .cp-main-header {")).toMatch(/flex-wrap:\s*wrap/);
	});
});

describe("task checkbox", () => {
	// Obsidian's check mark is a :after offset by -1px, which assumes a 1 px border.
	it("offsets the check mark by the border width so it is centered", () => {
		const own = cssBlock(".checkpoint-view .cp-task-checkbox:checked:after");
		expect(own).toMatch(/top:\s*calc\(-1 \* var\(--cp-cb-border\)\)/);
		expect(own).toMatch(/inset-inline-start:\s*calc\(-1 \* var\(--cp-cb-border\)\)/);
		expect(cssBlock(".checkpoint-view .cp-task-checkbox {")).toMatch(/border-width:\s*var\(--cp-cb-border\)/);
		expect(own).not.toContain("!important");
	});
});

describe("completed titles", () => {
	it("a completed title is not struck through in a row, a card or the details subtask list, only faint", () => {
		for (const rule of [
			".checkpoint-view .cp-task-row.is-completed .cp-task-title {",
			".checkpoint-view .cp-board-item.is-completed .cp-board-title {",
			".checkpoint-view .cp-subtasks li.is-completed .cp-link-button {",
		]) {
			const block = cssBlock(rule);
			expect(block, rule).not.toMatch(/text-decoration/);
			expect(block, rule).toMatch(/color:\s*var\(--text-(faint|muted)\)/);
		}
	});
});

describe("task row tag", () => {
	it("is tinted text, not a pill, and ellipsized when longer than the line", () => {
		const rule = cssBlock(".checkpoint-view .cp-meta-tag {");
		expect(rule).toMatch(/color:\s*var\(--cp-hue-text/);
		expect(rule).not.toMatch(/background|border/);
		expect(cssBlock(".checkpoint-view .cp-task-meta > * {")).toMatch(/text-overflow:\s*ellipsis/);
	});
});

describe("group headings", () => {
	it("a past date's heading and its overdue label are red", () => {
		expect(cssBlock(".checkpoint-view .cp-task-group > .cp-group-heading.is-overdue {")).toMatch(/color:\s*var\(--cp-red-text\)/);
		expect(cssBlock(".checkpoint-view .cp-group-heading .cp-group-overdue {")).toMatch(/color:\s*var\(--cp-red-text\)/);
	});
});
