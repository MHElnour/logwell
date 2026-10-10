import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The stylesheet section of the dashboard block. happy-dom has no layout, so the rules are checked as
// text; the visual pass (dark and light, Live Preview and reading view) is done in real Obsidian.

const css = readFileSync("styles.css", "utf8");
const MARK = "/* == #4 dashboard block == */";
const END = "/* == end #4 dashboard block == */";
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

function rule(selector: string): string {
	const i = bare.indexOf(`${selector} {`);
	if (i < 0) throw new Error(`no rule ${selector}`);
	return bare.slice(i, bare.indexOf("}", i));
}

describe("dashboard block stylesheet section", () => {
	it("is present once and closed, before the last section of the file", () => {
		expect(css.split(MARK)).toHaveLength(2);
		expect(css.split(END)).toHaveLength(2);
		expect(css.indexOf(MARK)).toBeLessThan(css.indexOf(END));
		expect(css.indexOf(END)).toBeLessThan(css.indexOf("/* == M7 recurrence == */"));
	});

	it("scopes every rule to the block", () => {
		const bad = selectors(bare).filter((s) => !/^\.checkpoint-view\.cp-block\b/.test(s) && !/^\.checkpoint-view \.cp-block\b/.test(s) && !/^\.cm-embed-block \.cp-block\b/.test(s));
		expect(bad).toEqual([]);
	});

	it("uses no !important, no :has, no lookbehind and no hex, rgb or named colors", () => {
		expect(bare).not.toMatch(/!important/);
		expect(bare).not.toMatch(/:has\(/);
		expect(bare).not.toMatch(/\(\?<[=!]/);
		expect(bare).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(bare).not.toMatch(/rgba?\(|hsla?\(/);
	});

	it("keeps a fixed maximum height and scrolls inside the block, as the list column of the app does", () => {
		const body = rule(".checkpoint-view .cp-block-body");
		expect(body).toMatch(/max-height:\s*var\(--cp-block-max-h/);
		expect(body).toMatch(/overflow-y:\s*auto/);
		expect(body).toMatch(/container-name:\s*cp-list/);
		expect(body).toMatch(/container-type:\s*inline-size/);
	});

	it("reserves a minimum height so the block does not jump while it is empty or hidden", () => {
		expect(rule(".checkpoint-view.cp-block")).toMatch(/min-height:/);
	});

	it("colors only with theme variables", () => {
		const colors = [...bare.matchAll(/(?:color|background|border-color|border|outline)[a-z-]*:\s*([^;]+);/g)].map((m) => m[1]!);
		for (const value of colors) expect(value).toMatch(/var\(--|transparent|none|inherit|currentColor|^0$/);
	});

	it("keeps the open button clear of the editor's edit-block button in Live Preview", () => {
		expect(bare).toMatch(/\.cm-embed-block \.cp-block .*cp-block-head/);
	});
});
