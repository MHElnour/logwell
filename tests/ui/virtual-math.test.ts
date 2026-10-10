import { describe, expect, it } from "vitest";
import { covers, itemOffsets, rangeIn, renderIndices, windowPlan } from "../../src/ui/virtual";

// The windowing math behind VirtualRows.

const uniform = (n: number, size: number, gap = 0) => itemOffsets(n, () => size, gap);

describe("itemOffsets", () => {
	it("starts each item after the sizes and gaps before it", () => {
		const o = itemOffsets(3, (i) => [10, 20, 30][i]!, 4);
		expect([...o]).toEqual([0, 14, 38, 72]);
	});

	it("is a single zero for no items", () => {
		expect([...itemOffsets(0, () => 52, 8)]).toEqual([0]);
	});
});

describe("rangeIn", () => {
	const o = uniform(100, 50);

	it("finds the items that intersect the band", () => {
		expect(rangeIn(o, 0, 120)).toEqual({ start: 0, end: 3 });
		expect(rangeIn(o, 125, 260)).toEqual({ start: 2, end: 6 });
		// An item that only touches the band's top edge is outside it.
		expect(rangeIn(o, 100, 150)).toEqual({ start: 2, end: 3 });
	});

	it("clamps a band that reaches past either end", () => {
		expect(rangeIn(o, -500, 75)).toEqual({ start: 0, end: 2 });
		expect(rangeIn(o, 4900, 9000)).toEqual({ start: 98, end: 100 });
		expect(rangeIn(o, -100, 99999)).toEqual({ start: 0, end: 100 });
	});

	it("is empty for a band above or below every item", () => {
		const above = rangeIn(o, -900, -10);
		expect(above.end - above.start).toBe(0);
		const below = rangeIn(o, 6000, 7000);
		expect(below.end - below.start).toBe(0);
		expect(rangeIn(uniform(0, 50), 0, 100)).toEqual({ start: 0, end: 0 });
	});
});

describe("renderIndices", () => {
	it("adds pinned items outside the range, sorted and without duplicates", () => {
		expect(renderIndices({ start: 10, end: 13 }, [40, 11, 2, 40, -1, 99], 50)).toEqual([2, 10, 11, 12, 40]);
	});

	it("is only the pins for an empty range", () => {
		expect(renderIndices({ start: 5, end: 5 }, [7], 10)).toEqual([7]);
		expect(renderIndices({ start: 5, end: 5 }, [], 10)).toEqual([]);
	});
});

describe("windowPlan", () => {
	it("puts a spacer before, between and after the drawn items, so every item keeps its offset", () => {
		const o = uniform(10, 50);
		expect(windowPlan(o, 0, [3, 4, 8])).toEqual([
			{ kind: "spacer", after: 0, height: 150 },
			{ kind: "item", index: 3 },
			{ kind: "item", index: 4 },
			{ kind: "spacer", after: 5, height: 150 },
			{ kind: "item", index: 8 },
			{ kind: "spacer", after: 9, height: 50 },
		]);
	});

	it("needs no spacer when every item is drawn", () => {
		expect(windowPlan(uniform(3, 50), 0, [0, 1, 2])).toEqual([0, 1, 2].map((index) => ({ kind: "item", index })));
	});

	it("is one spacer of the full height when nothing is drawn", () => {
		expect(windowPlan(uniform(4, 50, 8), 8, [])).toEqual([{ kind: "spacer", after: 0, height: 4 * 50 + 3 * 8 }]);
	});

	it("subtracts the flex gaps a spacer adds around itself", () => {
		// Items of 40 with 8 px gaps: item 2 starts at 96. A spacer, its gap and item 2 must land there.
		const o = uniform(5, 40, 8);
		const plan = windowPlan(o, 8, [2]);
		expect(plan).toEqual([
			{ kind: "spacer", after: 0, height: 88 },
			{ kind: "item", index: 2 },
			{ kind: "spacer", after: 3, height: 88 },
		]);
		// Flow: spacer 88 + gap 8 = 96 (item 2's top); item 2 ends at 136, + gap 8 + spacer 88 = 232 = the full height.
		expect(88 + 8).toBe(o[2]);
		expect(o[3]! - 8 + 8 + 88).toBe(o[5]! - 8);
	});

	it("an empty list has no parts", () => {
		expect(windowPlan(uniform(0, 50), 0, [])).toEqual([]);
	});
});

describe("covers", () => {
	it("is true when the needed range lies inside the drawn one", () => {
		expect(covers({ start: 0, end: 30 }, { start: 5, end: 20 })).toBe(true);
		expect(covers({ start: 5, end: 30 }, { start: 4, end: 20 })).toBe(false);
		expect(covers({ start: 5, end: 30 }, { start: 6, end: 31 })).toBe(false);
	});

	it("an empty need is always covered; a need is never covered by an empty range", () => {
		expect(covers({ start: 3, end: 3 }, { start: 9, end: 9 })).toBe(true);
		expect(covers({ start: 3, end: 3 }, { start: 3, end: 4 })).toBe(false);
	});
});
