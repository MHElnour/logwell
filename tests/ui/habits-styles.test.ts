import { describe, expect, it } from "vitest";
import { cssSection, uncommented } from "./styles-helpers";

// The Habits stylesheet section; the visual pass (dark and light, 1400 / 980 / 560 px) is done in real Obsidian.
// Its scoping and hygiene are checked with the other sections in layout-styles.test.ts.

const section = cssSection("M6 habits");
const bare = uncommented(section);

describe("habits stylesheet section", () => {
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
