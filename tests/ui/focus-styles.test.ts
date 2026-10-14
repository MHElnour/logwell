import { describe, expect, it } from "vitest";
import { cssBlock, cssSection } from "./styles-helpers";

// Keyboard focus is visible on the Focus page's small controls and on the status-bar item. The section's scoping and
// hygiene are checked with the other sections in layout-styles.test.ts.

const section = cssSection("M5 focus");

describe("focus stylesheet section", () => {
	it("outlines the gap buttons, the show-more button and the status-bar item on :focus-visible with variables", () => {
		for (const sel of [
			".checkpoint-view .cp-focus-gap button:focus-visible",
			".checkpoint-view .cp-focus-more:focus-visible",
			".status-bar-item.cp-focus-status:focus-visible",
		]) {
			expect(section).toContain(sel);
		}
		expect(section).toMatch(/:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--/);
	});

	it("the tree line, the four dots and the keyboard outlines are styled with theme variables", () => {
		const rule = (sel: string): string => cssBlock(`${sel} {`, section);
		expect(rule(".checkpoint-view .cp-focus-rec::before")).toMatch(/background:\s*var\(--background-modifier-border\)/);
		expect(rule(".checkpoint-view .cp-focus-rec:only-child::before")).toContain("display: none");
		expect(rule(".checkpoint-view .cp-focus-rec:first-child::before")).toContain("top: var(--cp-dot-y)");
		expect(rule(".checkpoint-view .cp-focus-rec:last-child::before")).toContain("height: var(--cp-dot-y)");
		expect(rule(".checkpoint-view .cp-focus-status-dot.is-recovered")).toContain("var(--color-yellow)");
		expect(rule(".checkpoint-view .cp-focus-status-dot.is-early")).toContain("var(--cp-accent)");
		expect(rule(".checkpoint-view .cp-focus-status-dot.is-stopped")).toContain("var(--text-faint)");
		expect(section).toContain("grid-template-columns: minmax(0, 1fr) 430px");
		expect(section).toContain(".checkpoint-view .cp-focus-set-head:focus-visible");
		expect(section).toContain(".checkpoint-view .cp-focus-round-more:focus-visible");
	});
});
