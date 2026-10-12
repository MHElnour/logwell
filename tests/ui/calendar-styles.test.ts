import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOUR_PX, LABEL_PEEK_PX, initialScrollTop } from "../../src/ui/calendar/geometry";

// The calendar stylesheet section and the initial scroll it is drawn for. happy-dom has no layout, so the stylesheet rules are checked as text; e2e checks the real rendering.

const css = readFileSync("styles.css", "utf8");
const MARK = "/* == M3 calendar == */";
const END = "/* == end M3 calendar == */";
const section = css.slice(css.indexOf(MARK), css.indexOf(END) + END.length);

/** Every selector in a stylesheet text, comments removed, at-rule preludes skipped. */
function selectors(text: string): string[] {
	const out: string[] = [];
	const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
	const re = /([^{}]+)\{/g;
	for (let m = re.exec(clean); m !== null; m = re.exec(clean)) {
		const prelude = m[1]!.trim();
		if (prelude.startsWith("@")) continue;
		for (const s of prelude.split(",")) out.push(s.trim());
	}
	return out;
}

describe("calendar stylesheet section", () => {
	it("is present once, intact, and followed only by the later sections", () => {
		expect(css.split(MARK)).toHaveLength(2);
		expect(css.split(END)).toHaveLength(2);
		expect(css.indexOf(MARK)).toBeLessThan(css.indexOf(END));
		// What follows the calendar block is exactly the listed blocks, in that order; earlier sections are untouched.
		const after = css.slice(css.indexOf(END) + END.length);
		const marks = (after.match(/\/\* == [^=]+ == \*\//g) ?? []).filter((m) => !m.startsWith("/* == end "));
		expect(marks).toEqual(["/* == M4 matrix == */", "/* == M4 drag == */", "/* == K1a list drag == */", "/* == Release B windowed lists == */", "/* == K1a board == */", "/* == K1b sections == */", "/* == G1 group by == */", "/* == M5 focus == */", "/* == 0.3.0 tag tree == */", "/* == M6 habits == */", "/* == #4 dashboard block == */", "/* == Issue #6 TickTick sync == */", "/* == M7 recurrence == */"]);
		expect(css.indexOf("/* == end M5 focus == */")).toBeLessThan(css.indexOf("/* == 0.3.0 tag tree == */"));
		// Every block after the calendar block is closed by its end marker, in the same order.
		expect(css.indexOf("/* == end 0.3.0 tag tree == */")).toBeLessThan(css.indexOf("/* == M6 habits == */"));
		expect(css.indexOf("/* == end M6 habits == */")).toBeLessThan(css.indexOf("/* == #4 dashboard block == */"));
		expect(css.indexOf("/* == end #4 dashboard block == */")).toBeLessThan(css.indexOf("/* == Issue #6 TickTick sync == */"));
		expect(css.indexOf("/* == end Issue #6 TickTick sync == */")).toBeLessThan(css.indexOf("/* == M7 recurrence == */"));
		expect(css.trimEnd().endsWith("/* == end M7 recurrence == */")).toBe(true);
	});

	it("scopes every rule to the plugin view", () => {
		const bad = selectors(section).filter((s) => !s.startsWith(".checkpoint-view"));
		expect(bad).toEqual([]);
	});

	it("uses no !important, no :has and no regex-like lookbehind", () => {
		expect(section).not.toMatch(/!important/);
		expect(section).not.toMatch(/:has\(/);
		expect(section).not.toMatch(/\(\?<[=!]/);
	});

	it("uses theme variables only: no hex or rgb colors", () => {
		const bare = section.replace(/\/\*[\s\S]*?\*\//g, "");
		expect(bare).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(bare).not.toMatch(/\brgba?\(/);
	});

	it("gives entries and header controls the accent focus ring", () => {
		expect(section).toMatch(/\.cp-cal-entry:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--cp-accent\)/);
		expect(section).toMatch(/\.cp-cal-daynum:focus-visible|\.cp-cal-btn:focus-visible/);
	});

	it("keeps the hour height in one place that matches the scroll math", () => {
		const m = /--cp-cal-hour:\s*(\d+)px/.exec(section);
		expect(Number(m?.[1])).toBe(HOUR_PX);
		expect(HOUR_PX).toBe(48);
	});

	it("keeps 7 week columns and scrolls horizontally inside the grid below 800 px", () => {
		const start = section.indexOf("@container cp-app (max-width: 800px)");
		expect(start).toBeGreaterThan(-1);
		const q = section.slice(start);
		expect(q).toMatch(/\.cp-cal-week-inner\s*\{[^}]*min-width:\s*\d+px/);
		expect(section).toMatch(/\.cp-cal-scroller\s*\{[^}]*overflow:\s*auto/);
		expect(section).toMatch(/\.cp-cal-sticky\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/);
		expect(section).toMatch(/grid-template-columns:[^;]*repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
	});

	it("truncates month titles and keeps a 7-column grid", () => {
		expect(section).toMatch(/\.cp-cal-cell\s*\{[^}]*min-width:\s*0/);
		expect(section).toMatch(/\.cp-cal-entry-text\s*\{[^}]*text-overflow:\s*ellipsis/);
	});

	it("below 1200 px the drawers start under the header and the unscheduled one yields to the details", () => {
		const start = section.indexOf("@container cp-app (max-width: 1200px)");
		expect(start).toBeGreaterThan(-1);
		const q = section.slice(start, section.indexOf("@container cp-app (max-width: 800px)"));
		expect(q).toMatch(/\.cp-cal-unscheduled\s*\{[^}]*position:\s*absolute[^}]*top:\s*var\(--cp-cal-drawer-top/);
		expect(q).toMatch(/\.cp-calendar \.cp-details-pane\s*\{[^}]*top:\s*var\(--cp-cal-drawer-top/);
		expect(q).toMatch(/\.cp-calendar\.has-details \.cp-cal-unscheduled\s*\{[^}]*display:\s*none/);
	});

	it("timed blocks keep a minimum height so 5 to 15 minute blocks stay clickable", () => {
		expect(section).toMatch(/\.cp-cal-daycol > \.cp-cal-entry\.is-block\s*\{[^}]*min-height:\s*20px/);
	});

	it("styles the states the design calls for", () => {
		for (const sel of [".cp-cal-entry.is-noduration", ".cp-cal-entry.is-deadline", ".cp-cal-entry.is-past", ".cp-cal-entry.is-missed", ".cp-cal-entry.is-completed", ".cp-cal-skipped", ".cp-cal-repeated", ".cp-cal-now"]) {
			expect(section, sel).toContain(sel);
		}
		expect(section).toMatch(/\.cp-cal-entry\.is-noduration\s*\{[^}]*dashed/);
		expect(section).toMatch(/\.cp-cal-entry\.is-completed\s*\{[^}]*line-through/);
		expect(section).toMatch(/\.cp-cal-skipped\s*\{[^}]*repeating-linear-gradient/);
	});
});

describe("initial scroll (D6)", () => {
	it("is 07:00 or one hour before now, whichever is later, only when today is visible", () => {
		expect(initialScrollTop(5 * 60, true)).toBe(7 * HOUR_PX - LABEL_PEEK_PX);
		expect(initialScrollTop(12 * 60, true)).toBe(11 * HOUR_PX - LABEL_PEEK_PX);
		expect(initialScrollTop(9 * 60 + 30, true)).toBe(8 * HOUR_PX - LABEL_PEEK_PX); // 08:30 snaps to 08:00
		expect(initialScrollTop(13 * 60 + 5, true)).toBe(12 * HOUR_PX - LABEL_PEEK_PX);
		expect(initialScrollTop(23 * 60, false)).toBe(7 * HOUR_PX - LABEL_PEEK_PX);
	});

	it("leaves room above the hour line for half its label, so the first visible label is not cut", () => {
		// The label is centred on its line by `top: -0.55em` at 11 px; half of it is about 6 px.
		expect(section).toMatch(/\.cp-cal-hour-label\s*\{[^}]*top:\s*-0\.55em/);
		expect(section).toMatch(/\.cp-cal-hour-label\s*\{[^}]*font-size:\s*11px/);
		expect(LABEL_PEEK_PX).toBeGreaterThanOrEqual(Math.ceil(11 * 0.55));
		expect(LABEL_PEEK_PX).toBeLessThan(HOUR_PX / 2);
	});

	it("never goes below zero", () => {
		expect(initialScrollTop(0, false)).toBeGreaterThanOrEqual(0);
	});

	it("keeps the 00:00 label inside the body at scroll 0 (it sits below its line, not above)", () => {
		const m = /\.cp-cal-hour-label:first-child\s*\{[^}]*top:\s*(\d+)px/.exec(section);
		expect(Number(m?.[1])).toBeGreaterThanOrEqual(0);
	});
});

describe("all-day overflow and short blocks (stylesheet)", () => {
	it("styles the +k more and Show less controls like the month's, with a focus ring", () => {
		expect(section).toMatch(/\.cp-cal-allday-more,\s*\.checkpoint-view \.cp-cal-allday-less\s*\{/);
		expect(section).toMatch(/\.cp-cal-allday-more:focus-visible/);
		expect(section).toMatch(/\.cp-cal-allday-less:focus-visible/);
	});

	it("keeps a short block to one line: a fixed one-line body, hidden overflow, ellipsized title", () => {
		const rule = /\.cp-cal-entry\.is-short \.cp-cal-entry-body\s*\{([^}]*)\}/.exec(section);
		expect(rule, "short block body rule").not.toBeNull();
		expect(rule![1]).toMatch(/height:\s*1\.25em/);
		expect(rule![1]).toMatch(/overflow:\s*hidden/);
		expect(rule![1]).toMatch(/align-content:\s*flex-start/);
		expect(section).toMatch(/\.cp-cal-entry-text\s*\{[^}]*text-overflow:\s*ellipsis/);
		// The time wraps out of the one-line box (hidden) instead of being cut mid-glyph.
		expect(rule![1]).toMatch(/flex-wrap:\s*wrap/);
	});

	it("keeps the hover feedback on a short block, whose body is only one line tall", () => {
		expect(section).toMatch(/\.cp-cal-entry\.is-short:hover\s*\{/);
		expect(section).toMatch(/\.cp-cal-entry\.is-short:hover \.cp-cal-entry-body\s*\{[^}]*background:\s*none/);
	});
});

describe("status bar room", () => {
	// Outside the calendar section: Obsidian's fixed status bar overlaps the bottom right of every section.
	const before = css.slice(0, css.indexOf(MARK)).replace(/\/\*[\s\S]*?\*\//g, "");

	it("keeps the room inside each column, not on the body, so backgrounds reach the bottom edge", () => {
		expect(before).not.toMatch(/\.checkpoint-view \.cp-body\s*\{[^}]*padding-bottom/);
		expect(before).toMatch(/\.checkpoint-view \.cp-app\s*\{[^}]*--cp-status-bar-room:\s*calc\(/);
		const all = css.replace(/\/\*[\s\S]*?\*\//g, "");
		for (const sel of ["cp-rail", "cp-sidebar-pane", "cp-main", "cp-details-pane", "cp-cal-main", "cp-cal-unscheduled", "cp-matrix-main"]) {
			const m = new RegExp(`\\.checkpoint-view \\.${sel}\\s*\\{([^}]*)\\}`).exec(all);
			expect(m?.[1], sel).toMatch(/padding:[^;]*var\(--cp-status-bar-room\)/);
		}
	});

	it("uses theme variables only (Obsidian exposes no status bar height) and not the mobile app, which has none", () => {
		const m = /--cp-status-bar-room:\s*([^;]+);/.exec(before);
		expect(m?.[1]).toContain("var(--");
		expect(before).toMatch(/body\.is-mobile \.checkpoint-view \.cp-app\s*\{[^}]*--cp-status-bar-room:\s*0px/);
	});

	it("does not touch the container-query setup of .cp-app", () => {
		expect(before).toMatch(/\.checkpoint-view \.cp-app\s*\{[^}]*container-type:\s*inline-size/);
		expect(before).toMatch(/\.checkpoint-view \.cp-app\s*\{[^}]*container-name:\s*cp-app/);
		expect(before).not.toMatch(/\.cp-app\s*\{[^}]*padding/);
	});
});
