import { describe, expect, it } from "vitest";
import { QUADRANT_ORDER, quadrantFlags } from "../../src/domain/matrix";
import { QUADRANT_INFO, QUADRANT_LIST, quadrantWords } from "../../src/ui/matrix/quadrants";

// Issue 26: one name per quadrant, one table, one way to join the quadrant words.

describe("quadrant names", () => {
	it("are the same in the matrix headings, menus and filter chips", () => {
		expect(QUADRANT_ORDER.map((q) => QUADRANT_INFO[q].title)).toEqual([
			"Urgent and important",
			"Important, not urgent",
			"Urgent, not important",
			"Neither",
		]);
		expect(QUADRANT_LIST.map((q) => q.id)).toEqual([...QUADRANT_ORDER]);
	});

	it("carry the flags the domain gives each quadrant", () => {
		for (const q of QUADRANT_LIST) expect({ urgent: q.urgent, important: q.important }).toEqual(quadrantFlags(q.id));
	});
});

describe("quadrantWords", () => {
	it("joins the set flags with a dot", () => {
		expect(quadrantWords(true, true)).toBe("Urgent · Important");
		expect(quadrantWords(true, false)).toBe("Urgent");
		expect(quadrantWords(false, true)).toBe("Important");
		expect(quadrantWords(false, false)).toBe("");
	});
});
