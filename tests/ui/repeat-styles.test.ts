import { describe, expect, it } from "vitest";
import { cssSection, selectors, uncommented } from "./styles-helpers";

// The repeat stylesheet section (marked "M7 recurrence" in styles.css); the visual pass (dark and light, wide and
// narrow) is done in real Obsidian. Its scoping, hygiene and place as the last block are checked with the other
// sections in layout-styles.test.ts.

const section = cssSection("M7 recurrence");
const bare = uncommented(section);

describe("the repeat stylesheet section", () => {
	it("gives the picker's own controls a visible focus outline", () => {
		for (const part of [".cp-repeat-button", ".cp-repeat-opt", ".cp-repeat-day", ".cp-repeat-seg button", ".cp-repeat-custom select", ".cp-repeat-custom input"]) {
			expect(section, part).toMatch(new RegExp(`${part.replace(/[.]/g, "\\.")}:focus-visible`));
		}
		expect(section).toMatch(/:focus-visible,?[^{}]*\{[^}]*outline:\s*2px solid var\(--cp-accent\)/);
	});

	it("#218: a calendar entry's title sits beside its repeat icon, leaving the icon and the gap its room", () => {
		// The body wraps (a tall block puts the time on the next line): a title as wide as the body would drop below the
		// icon, out of a one-line short block.
		const icon = /\.cp-cal-repeat svg\s*\{[^}]*width:\s*(\d+)px/.exec(bare);
		const rule = /\.cp-cal-repeat \+ \.cp-cal-entry-text\s*\{([^}]*)\}/.exec(bare);
		expect(rule, "title after the repeat icon").not.toBeNull();
		const room = /max-width:\s*calc\(100% - (\d+)px\)/.exec(rule![1]!);
		// The icon, plus the body's 6 px gap.
		expect(Number(room?.[1])).toBe(Number(icon?.[1]) + 6);
	});

	it("styles every part of the picker, the chip and the calendar states of the mockup", () => {
		for (const cls of [
			".cp-repeat-opts",
			".cp-repeat-opt.is-on",
			".cp-repeat-opt-hint",
			".cp-repeat-grid",
			".cp-repeat-lbl",
			".cp-repeat-days",
			".cp-repeat-day[aria-pressed=\"true\"]",
			".cp-repeat-radio",
			".cp-repeat-check.is-off",
			".cp-repeat-seg button[aria-pressed=\"true\"]",
			".cp-repeat-summary",
			".cp-repeat-summary.is-problem",
			".cp-meta-repeat",
			".cp-cal-entry.is-future",
			".cp-cal-repeat",
		]) {
			expect(bare, cls).toContain(cls);
		}
		// The aligned grid: a labels column, then the controls.
		expect(section).toMatch(/\.cp-repeat-grid[^{}]*\{[^}]*grid-template-columns:\s*52px minmax\(0, 1fr\)/);
		// Future occurrences: faded, with a dashed edge.
		expect(section).toMatch(/\.cp-cal-entry\.is-future\s*\{[^}]*opacity:[^}]*border-left-style:\s*dashed/);
	});

	it("colors the repeat chip and the typed and picked repeat pills purple, from the theme variables", () => {
		expect(section).toMatch(/\.cp-meta-repeat\s*\{[^}]*background:\s*var\(--cp-purple-soft\)[^}]*color:\s*var\(--cp-purple-text\)/);
		expect(section).toMatch(/\.cp-qa-manual\[data-kind="recurrence"\]\s*\{[^}]*var\(--cp-purple-soft\)/);
	});

	it("restyles the popover's buttons with selectors one class stronger than its reset", () => {
		// `.checkpoint-view .cp-pop button` is (0,2,1); the picker's buttons are `.checkpoint-view .cp-pop .cp-repeat-x` (0,3,0).
		for (const sel of selectors(bare).filter((s) => /\.cp-repeat-(opt|day)(?![\w-])/.test(s) && s.startsWith(".checkpoint-view"))) {
			expect(sel, sel).toMatch(/^\.checkpoint-view \.cp-pop /);
		}
	});
});
