import { describe, expect, it } from "vitest";
import { describeBlockFilters, parseBlockQuery } from "../../src/parsing/blockQuery";

// The source of a `logwell` block.

describe("block query parser: shape", () => {
	it("an empty source has no filters and no errors", () => {
		expect(parseBlockQuery("")).toEqual({ filters: {}, errors: [] });
		expect(parseBlockQuery("\n  \n\t\n")).toEqual({ filters: {}, errors: [] });
	});

	it("reads one filter per line and ignores blank lines", () => {
		const r = parseBlockQuery("list: Work\n\nsection: Planning\n   \ntag: Calls");
		expect(r.errors).toEqual([]);
		expect(r.filters).toEqual({ list: "Work", section: "Planning", tags: ["Calls"] });
	});

	it("accepts CRLF line endings", () => {
		const r = parseBlockQuery("list: Work\r\ndue: today\r\n");
		expect(r).toEqual({ filters: { list: "Work", due: "today" }, errors: [] });
	});

	it("keys are case-insensitive and padded keys and values are trimmed", () => {
		const r = parseBlockQuery("  LIST :   Work  \nDue: TODAY");
		expect(r).toEqual({ filters: { list: "Work", due: "today" }, errors: [] });
	});

	it("keeps colons after the first in the value", () => {
		expect(parseBlockQuery("list: Work: Q4").filters.list).toBe("Work: Q4");
	});

	it("keeps the typed casing of names", () => {
		expect(parseBlockQuery("list: My PROJECT").filters.list).toBe("My PROJECT");
	});

	it("does not split a list name on commas", () => {
		expect(parseBlockQuery("list: Home, garden").filters.list).toBe("Home, garden");
	});

	it("the full example parses", () => {
		const r = parseBlockQuery(
			"list: Work\nsection: Planning\ntag: Calls\ndue: this week\npriority: high, medium\nquadrant: 1\nlinked: this note",
		);
		expect(r.errors).toEqual([]);
		expect(r.filters).toEqual({
			list: "Work",
			section: "Planning",
			tags: ["Calls"],
			due: "this-week",
			priorities: [1, 2],
			quadrants: ["urgent-important"],
			linked: true,
		});
	});
});

describe("block query parser: errors in the lines", () => {
	it("an unknown key", () => {
		const r = parseBlockQuery("colour: red");
		expect(r.errors).toEqual(["Unknown filter “colour”."]);
		expect(r.filters).toEqual({});
	});

	it("an unknown key keeps the other lines", () => {
		const r = parseBlockQuery("list: Work\nstatus: done\ndue: today");
		expect(r.errors).toEqual(["Unknown filter “status”."]);
		expect(r.filters).toEqual({ list: "Work", due: "today" });
	});

	it("a duplicate key (any casing) is an error and the first one wins", () => {
		const r = parseBlockQuery("list: Work\nLIST: Home");
		expect(r.errors).toEqual(["Duplicate filter “list”."]);
		expect(r.filters).toEqual({ list: "Work" });
	});

	it("a line without a colon", () => {
		const r = parseBlockQuery("list Work");
		expect(r.errors).toEqual(["Expected “key: value”, got “list Work”."]);
	});

	it("an empty value", () => {
		for (const key of ["list", "tag", "due", "scheduled", "priority", "quadrant", "linked"]) {
			const r = parseBlockQuery(`${key}:`);
			expect(r.errors, key).toEqual([`The “${key}” filter needs a value.`]);
			expect(r.filters, key).toEqual({});
		}
	});

	it("section without a list", () => {
		const r = parseBlockQuery("section: Planning");
		expect(r.errors).toEqual(["section needs a list filter."]);
		expect(r.filters).toEqual({});
	});

	it("section is fine when the list line comes after it", () => {
		const r = parseBlockQuery("section: Planning\nlist: Work");
		expect(r.errors).toEqual([]);
		expect(r.filters).toEqual({ list: "Work", section: "Planning" });
	});

	it("reports every problem in source order", () => {
		const r = parseBlockQuery("nope: 1\ndue: soon\nsection: X");
		expect(r.errors).toEqual([
			"Unknown filter “nope”.",
			"Unknown due value “soon”. Use today, overdue, this week or next 7 days.",
			"section needs a list filter.",
		]);
	});
});

describe("block query parser: tag", () => {
	it("with or without a leading @", () => {
		expect(parseBlockQuery("tag: @Calls").filters.tags).toEqual(["Calls"]);
		expect(parseBlockQuery("tag: Calls").filters.tags).toEqual(["Calls"]);
	});

	it("a lone @ is an empty value", () => {
		expect(parseBlockQuery("tag: @").errors).toEqual(["The “tag” filter needs a value."]);
	});

	it("keeps a path", () => {
		expect(parseBlockQuery("tag: @programming/go").filters.tags).toEqual(["programming/go"]);
	});
});

describe("block query parser: due", () => {
	const ok: [string, string][] = [
		["today", "today"],
		["Overdue", "overdue"],
		["this week", "this-week"],
		["THIS   WEEK", "this-week"],
		["next 7 days", "next-7-days"],
		["Next 7  Days", "next-7-days"],
	];
	for (const [value, due] of ok) {
		it(`“${value}” is ${due}`, () => {
			expect(parseBlockQuery(`due: ${value}`)).toEqual({ filters: { due }, errors: [] });
		});
	}

	it("a bad value names the value and the allowed ones", () => {
		const r = parseBlockQuery("due: tomorrow");
		expect(r.errors).toEqual(["Unknown due value “tomorrow”. Use today, overdue, this week or next 7 days."]);
		expect(r.filters).toEqual({});
	});

	it("does not take a comma list", () => {
		expect(parseBlockQuery("due: today, overdue").errors).toHaveLength(1);
	});
});

describe("block query parser: priority", () => {
	it("each value", () => {
		expect(parseBlockQuery("priority: high").filters.priorities).toEqual([1]);
		expect(parseBlockQuery("priority: medium").filters.priorities).toEqual([2]);
		expect(parseBlockQuery("priority: low").filters.priorities).toEqual([3]);
		expect(parseBlockQuery("priority: none").filters.priorities).toEqual([0]);
	});

	it("a comma list is OR, case-insensitive, padded, in typed order, without duplicates", () => {
		expect(parseBlockQuery("priority: High , LOW,none,high").filters.priorities).toEqual([1, 3, 0]);
	});

	it("a bad value names it and the allowed values", () => {
		const r = parseBlockQuery("priority: high, urgent");
		expect(r.errors).toEqual(["Unknown priority “urgent”. Use high, medium, low or none."]);
		expect(r.filters).toEqual({});
	});

	it("one error per bad value", () => {
		expect(parseBlockQuery("priority: a, b").errors).toEqual([
			"Unknown priority “a”. Use high, medium, low or none.",
			"Unknown priority “b”. Use high, medium, low or none.",
		]);
	});

	it("an empty item in the list is an error", () => {
		const r = parseBlockQuery("priority: high,");
		expect(r.errors).toHaveLength(1);
		expect(r.filters).toEqual({});
	});
});

describe("block query parser: quadrant", () => {
	it("numbers follow the matrix order", () => {
		expect(parseBlockQuery("quadrant: 1").filters.quadrants).toEqual(["urgent-important"]);
		expect(parseBlockQuery("quadrant: 2").filters.quadrants).toEqual(["important"]);
		expect(parseBlockQuery("quadrant: 3").filters.quadrants).toEqual(["urgent"]);
		expect(parseBlockQuery("quadrant: 4").filters.quadrants).toEqual(["neither"]);
	});

	it("names", () => {
		expect(parseBlockQuery("quadrant: urgent and important").filters.quadrants).toEqual(["urgent-important"]);
		expect(parseBlockQuery("quadrant: Important not urgent").filters.quadrants).toEqual(["important"]);
		expect(parseBlockQuery("quadrant: urgent  NOT important").filters.quadrants).toEqual(["urgent"]);
		expect(parseBlockQuery("quadrant: neither").filters.quadrants).toEqual(["neither"]);
	});

	it("a comma list is OR and drops duplicates", () => {
		expect(parseBlockQuery("quadrant: 1, important not urgent, 1").filters.quadrants).toEqual(["urgent-important", "important"]);
	});

	it("a bad value names it and the allowed values", () => {
		const r = parseBlockQuery("quadrant: 5");
		expect(r.errors).toEqual([
			"Unknown quadrant “5”. Use 1 to 4, urgent and important, important not urgent, urgent not important or neither.",
		]);
		expect(r.filters).toEqual({});
	});
});

describe("block query parser: linked", () => {
	it("this note, in any casing", () => {
		expect(parseBlockQuery("linked: this note")).toEqual({ filters: { linked: true }, errors: [] });
		expect(parseBlockQuery("Linked: This  Note").filters.linked).toBe(true);
	});

	it("nothing else", () => {
		const r = parseBlockQuery("linked: Plan");
		expect(r.errors).toEqual(["Unknown linked value “Plan”. Use this note."]);
		expect(r.filters).toEqual({});
	});
});

describe("describeBlockFilters (header chips)", () => {
	it("no filters, no chips", () => {
		expect(describeBlockFilters({})).toEqual([]);
	});

	it("one chip per filter, normalized, in a fixed order", () => {
		const { filters } = parseBlockQuery(
			"LINKED: This  Note\nquadrant: 1, neither\npriority: HIGH,medium\ndue: THIS WEEK\ntag: @Calls\nsection: Planning\nlist:  Work ",
		);
		expect(describeBlockFilters(filters)).toEqual([
			"list: Work",
			"section: Planning",
			"tag: Calls",
			"due: this week",
			"priority: high, medium",
			"quadrant: urgent and important, neither",
			"linked: this note",
		]);
	});

	it("each due value reads like its source", () => {
		for (const due of ["today", "overdue", "this week", "next 7 days"]) {
			expect(describeBlockFilters(parseBlockQuery(`due: ${due}`).filters)).toEqual([`due: ${due}`]);
		}
	});

	it("each priority and quadrant has a name", () => {
		expect(describeBlockFilters(parseBlockQuery("priority: high, medium, low, none").filters)).toEqual(["priority: high, medium, low, none"]);
		expect(describeBlockFilters(parseBlockQuery("quadrant: 1, 2, 3, 4").filters)).toEqual([
			"quadrant: urgent and important, important not urgent, urgent not important, neither",
		]);
	});

	it("describes only what parsed: a rejected line gives no chip", () => {
		expect(describeBlockFilters(parseBlockQuery("due: soon\nlist: Work").filters)).toEqual(["list: Work"]);
	});

	it("re-parsing the chips gives the same filters", () => {
		const { filters } = parseBlockQuery("list: Work\nsection: Planning\ntag: Calls\ndue: next 7 days\npriority: low, high\nquadrant: 3\nlinked: this note");
		expect(parseBlockQuery(describeBlockFilters(filters).join("\n"))).toEqual({ filters, errors: [] });
	});
});
