import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Keyboard focus is visible on the Focus page's small controls and on the status-bar item.
// happy-dom has no layout, so the rules are checked as text.

const css = readFileSync("styles.css", "utf8");
const MARK = "/* == M5 focus == */";
const END = "/* == end M5 focus == */";
const section = css.slice(css.indexOf(MARK), css.indexOf(END) + END.length);

describe("M5 focus stylesheet section", () => {
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

	it("uses no !important, no :has and no hex colors", () => {
		const bare = section.replace(/\/\*[\s\S]*?\*\//g, "");
		expect(bare).not.toMatch(/!important/);
		expect(bare).not.toMatch(/:has\(/);
		expect(bare).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
	});

	it("P2: the tree line, the four dots and the keyboard outlines are styled with theme variables", () => {
		const rule = (sel: string): string => {
			const at = section.indexOf(`${sel} {`);
			expect(at, sel).toBeGreaterThan(-1);
			return section.slice(at, section.indexOf("}", at));
		};
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
