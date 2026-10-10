import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The Habits stylesheet section. happy-dom has no layout, so the rules are checked as text; the visual pass
// (dark and light, 1400 / 980 / 560 px) is done in real Obsidian.

const css = readFileSync("styles.css", "utf8");
const MARK = "/* == M6 habits == */";
const END = "/* == end M6 habits == */";
const section = css.slice(css.indexOf(MARK), css.indexOf(END) + END.length);
const bare = section.replace(/\/\*[\s\S]*?\*\//g, "");

function selectors(text: string): string[] {
	const out: string[] = [];
	const re = /([^{}]+)\{/g;
	for (let m = re.exec(text); m !== null; m = re.exec(text)) {
		const prelude = m[1]!.trim();
		if (prelude.startsWith("@")) continue;
		// A comma inside :is(...) does not start another selector.
		for (const s of prelude.replace(/\([^)]*\)/g, (g) => g.replace(/,/g, "|")).split(",")) out.push(s.trim());
	}
	return out;
}

describe("M6 habits stylesheet section", () => {
	it("is present once and closed", () => {
		expect(css.split(MARK)).toHaveLength(2);
		expect(css.split(END)).toHaveLength(2);
		expect(css.indexOf(MARK)).toBeLessThan(css.indexOf(END));
	});

	it("scopes every rule to the view or to the habit dialog", () => {
		const bad = selectors(bare).filter((s) => !s.startsWith(".checkpoint-view") && !s.startsWith(".checkpoint-habit-dialog"));
		expect(bad).toEqual([]);
	});

	it("uses no !important, no :has, no lookbehind and no hex or rgb colors", () => {
		expect(bare).not.toMatch(/!important/);
		expect(bare).not.toMatch(/:has\(/);
		expect(bare).not.toMatch(/\(\?<[=!]/);
		expect(bare).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(bare).not.toMatch(/\brgba?\(/);
	});

	it("outlines every control of the page, the Today block, the column and the dialog on :focus-visible", () => {
		for (const scope of [".checkpoint-view .cp-habits", ".checkpoint-view .cp-today-habits", ".checkpoint-view .cp-board-habits", ".checkpoint-habit-dialog"]) {
			expect(section, scope).toMatch(new RegExp(`${scope.replace(/\./g, "\\.")} :is\\(button, input, select\\):focus-visible`));
		}
		expect(section).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--cp-accent\)/);
	});

	it("makes the page a size container with the detail under the list at 980 px and the controls under the name at 560 px", () => {
		expect(section).toMatch(/\.cp-habits \{[^}]*container-type: inline-size/);
		expect(section).toMatch(/container-name: cp-habits/);
		expect(section).toContain("@container cp-habits (max-width: 980px)");
		expect(section).toContain("@container cp-habits (max-width: 560px)");
		expect(section).toContain("grid-template-columns: minmax(0, 1fr) 380px");
	});

	it("shows the check-in log actions on hover and on keyboard focus", () => {
		expect(section).toMatch(/\.cp-habit-entry:focus-within \.cp-habit-entry-actions/);
	});

	it("honors the hidden attribute in the dialog with a rule stronger than, and after, every display rule", () => {
		const rule = ".checkpoint-habit-dialog .cp-habit-form [hidden]";
		expect(bare).toMatch(/\.checkpoint-habit-dialog \.cp-habit-form \[hidden\]\s*\{\s*display: none/);
		// The old two-class selector lost the tie to the later display rules.
		expect(bare).not.toMatch(/\.checkpoint-habit-dialog \[hidden\]/);
		const at = bare.indexOf(rule);
		for (const sel of [".checkpoint-habit-dialog .cp-habit-field {", ".checkpoint-habit-dialog .cp-habit-chips {", ".checkpoint-habit-dialog .cp-habit-select {", ".checkpoint-habit-dialog .cp-habit-goal-line {"]) {
			const i = bare.indexOf(sel);
			expect(i, sel).toBeGreaterThan(-1);
			expect(at, sel).toBeGreaterThan(i);
		}
		// Two classes and the attribute (0,3,0) against the two-class display rules (0,2,0).
		expect(rule.match(/\.|\[/gu)).toHaveLength(3);
	});
});
