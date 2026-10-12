import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The stylesheet section of the TickTick sync UI, read as text (happy-dom has no layout).

const css = readFileSync("styles.css", "utf8");
const MARK = "/* == Issue #6 TickTick sync == */";
const END = "/* == end Issue #6 TickTick sync == */";
const section = css.slice(css.indexOf(MARK), css.indexOf(END) + END.length);
const selectors = (text: string): string[] =>
	[...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1]!.split(",").map((s) => s.trim())).filter((s) => !s.startsWith("@"));

describe("TickTick sync stylesheet section", () => {
	it("is present once and closed", () => {
		expect(css.split(MARK)).toHaveLength(2);
		expect(css.split(END)).toHaveLength(2);
		expect(css.indexOf(MARK)).toBeLessThan(css.indexOf(END));
	});

	it("scopes every rule to the view or to the sync dialogs", () => {
		const bad = selectors(section).filter((s) => !s.startsWith(".checkpoint-view") && !s.startsWith(".checkpoint-tt-dialog"));
		expect(bad).toEqual([]);
	});

	it("uses no !important, no :has, no hard-coded colors", () => {
		expect(section).not.toMatch(/!important/);
		expect(section).not.toMatch(/:has\(/);
		expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
	});

	it("gives the dialog's list rows a visible keyboard focus", () => {
		expect(section).toMatch(/\.cp-tt-option:focus-visible/);
		expect(section).toMatch(/\.cp-tt-titles:focus-visible/);
	});
});
