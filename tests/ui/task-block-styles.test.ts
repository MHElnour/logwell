import { describe, expect, it } from "vitest";
import { cssBlock, cssSection, uncommented } from "./styles-helpers";

// The stylesheet section of the dashboard block; the visual pass (dark and light, Live Preview and reading view) is
// done in real Obsidian. Its scoping and hygiene are checked with the other sections in layout-styles.test.ts.

const bare = uncommented(cssSection("#4 dashboard block"));
const rule = (selector: string): string => cssBlock(`${selector} {`, bare);

describe("dashboard block stylesheet section", () => {
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
