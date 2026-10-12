import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The repeat stylesheet section (marked "M7 recurrence" in styles.css). happy-dom has no layout, so the rules are
// checked as text; the visual pass (dark and light, wide and narrow) is done in real Obsidian.

const css = readFileSync("styles.css", "utf8");
const MARK = "/* == M7 recurrence == */";
const END = "/* == end M7 recurrence == */";
const section = css.slice(css.indexOf(MARK), css.indexOf(END) + END.length);
const bare = section.replace(/\/\*[\s\S]*?\*\//g, "");

function selectors(text: string): string[] {
	const out: string[] = [];
	const re = /([^{}]+)\{/g;
	for (let m = re.exec(text); m !== null; m = re.exec(text)) {
		const prelude = m[1]!.trim();
		if (prelude.startsWith("@")) continue;
		for (const s of prelude.replace(/\([^)]*\)/g, (g) => g.replace(/,/g, "|")).split(",")) out.push(s.trim());
	}
	return out;
}

describe("the repeat stylesheet section", () => {
	it("is present once, closed, and the last block of the file", () => {
		expect(css.split(MARK)).toHaveLength(2);
		expect(css.split(END)).toHaveLength(2);
		expect(css.indexOf(MARK)).toBeLessThan(css.indexOf(END));
		expect(css.indexOf("/* == end M6 habits == */")).toBeLessThan(css.indexOf(MARK));
		expect(css.trimEnd().endsWith(END)).toBe(true);
	});

	it("scopes every rule to the view or the Quick Add modal", () => {
		const bad = selectors(bare).filter((s) => !s.startsWith(".checkpoint-view ") && !s.startsWith(".checkpoint-quick-add-modal "));
		expect(bad).toEqual([]);
	});

	it("uses no !important, no :has, no lookbehind and no hex or rgb colors", () => {
		expect(bare).not.toMatch(/!important/);
		expect(bare).not.toMatch(/:has\(/);
		expect(bare).not.toMatch(/\(\?<[=!]/);
		expect(bare).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(bare).not.toMatch(/\brgba?\(/);
	});

	it("gives the picker's own controls a visible focus outline", () => {
		for (const part of [".cp-repeat-button", ".cp-repeat-opt", ".cp-repeat-day", ".cp-repeat-seg button", ".cp-repeat-custom select", ".cp-repeat-custom input"]) {
			expect(section, part).toMatch(new RegExp(`${part.replace(/[.]/g, "\\.")}:focus-visible`));
		}
		expect(section).toMatch(/:focus-visible,?[^{}]*\{[^}]*outline:\s*2px solid var\(--cp-accent\)/);
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
