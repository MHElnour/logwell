import { describe, expect, it } from "vitest";
import { type GroupViewKind, defaultGroupBy, effectiveGroupBy, groupByOptions } from "../../src/domain/groupBy";

// Group by: the options and defaults per view.

describe("group by options", () => {
	it("matches the spec §7 table", () => {
		expect(groupByOptions("inbox")).toEqual(["none", "section", "date", "priority", "tag"]);
		expect(groupByOptions("category")).toEqual(groupByOptions("inbox"));
		expect(groupByOptions("today")).toEqual(["date", "list", "priority", "tag", "none"]);
		expect(groupByOptions("upcoming")).toEqual(groupByOptions("today"));
		expect(groupByOptions("tag")).toEqual(["none", "date", "list", "priority"]);
		expect(groupByOptions("completed")).toEqual([]);
		expect(groupByOptions("trash")).toEqual([]);
	});

	it("defaults to date in Today and Upcoming and to none elsewhere", () => {
		const kinds: GroupViewKind[] = ["today", "upcoming", "inbox", "category", "tag", "completed", "trash"];
		expect(kinds.map(defaultGroupBy)).toEqual(["date", "date", "none", "none", "none", "none", "none"]);
	});

	it("uses a stored choice only when the view offers it", () => {
		expect(effectiveGroupBy("inbox", "section")).toBe("section");
		expect(effectiveGroupBy("inbox", undefined)).toBe("none");
		expect(effectiveGroupBy("today", "section")).toBe("date");
		expect(effectiveGroupBy("tag", "tag")).toBe("none");
		expect(effectiveGroupBy("inbox", "list")).toBe("none");
		expect(effectiveGroupBy("completed", "date")).toBe("none");
	});
});
