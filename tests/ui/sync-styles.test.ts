import { describe, expect, it } from "vitest";
import { cssSection } from "./styles-helpers";

// The stylesheet section of the TickTick sync UI. Its scoping and hygiene are checked with the other sections in
// layout-styles.test.ts.

const section = cssSection("Issue #6 TickTick sync");

describe("TickTick sync stylesheet section", () => {
	it("gives the dialog's list rows a visible keyboard focus", () => {
		expect(section).toMatch(/\.cp-tt-option:focus-visible/);
		expect(section).toMatch(/\.cp-tt-titles:focus-visible/);
	});
});
