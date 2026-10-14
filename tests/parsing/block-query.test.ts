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
			"Unknown due value “soon”. Use today, overdue, this week, next 7 days, a date like 20-10-2026, or a range like 01-10-2026 to 15-10-2026.",
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
		expect(r.errors).toEqual(["Unknown due value “tomorrow”. Use today, overdue, this week, next 7 days, a date like 20-10-2026, or a range like 01-10-2026 to 15-10-2026."]);
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

describe("scheduled and tag lists", () => {
	// Task block filters: `due:` and `scheduled:` take the same values, `tag:` takes a comma list (#52).

	const VALUES: [string, string][] = [
		["today", "today"],
		["Overdue", "overdue"],
		["this week", "this-week"],
		["THIS   WEEK", "this-week"],
		["next 7 days", "next-7-days"],
		["Next 7  Days", "next-7-days"],
	];

	describe("block query parser: scheduled", () => {
		for (const [value, scheduled] of VALUES) {
			it(`“${value}” is ${scheduled}`, () => {
				expect(parseBlockQuery(`scheduled: ${value}`)).toEqual({ filters: { scheduled }, errors: [] });
			});
		}

		it("the key is case-insensitive", () => {
			expect(parseBlockQuery("SCHEDULED: today")).toEqual({ filters: { scheduled: "today" }, errors: [] });
		});

		it("a bad value names the key and the allowed values", () => {
			const r = parseBlockQuery("scheduled: tomorrow");
			expect(r.errors).toEqual(["Unknown scheduled value “tomorrow”. Use today, overdue, this week, next 7 days, a date like 20-10-2026, or a range like 01-10-2026 to 15-10-2026."]);
			expect(r.filters).toEqual({});
		});

		it("a due value error names due", () => {
			expect(parseBlockQuery("due: soon").errors).toEqual(["Unknown due value “soon”. Use today, overdue, this week, next 7 days, a date like 20-10-2026, or a range like 01-10-2026 to 15-10-2026."]);
		});

		it("does not take a comma list", () => {
			expect(parseBlockQuery("scheduled: today, overdue").errors).toHaveLength(1);
		});

		it("a second scheduled line is a duplicate", () => {
			expect(parseBlockQuery("scheduled: today\nscheduled: overdue")).toEqual({ filters: { scheduled: "today" }, errors: ["Duplicate filter “scheduled”."] });
		});

		it("due and scheduled together are two filters", () => {
			expect(parseBlockQuery("due: overdue\nscheduled: this week")).toEqual({ filters: { due: "overdue", scheduled: "this-week" }, errors: [] });
		});
	});

	describe("block query parser: tag list", () => {
		it("one tag is a list of one", () => {
			expect(parseBlockQuery("tag: Calls")).toEqual({ filters: { tags: ["Calls"] }, errors: [] });
		});

		it("splits on commas, trims and strips each @", () => {
			expect(parseBlockQuery("tag: @home ,  work,@errands").filters.tags).toEqual(["home", "work", "errands"]);
		});

		it("keeps a path in the list", () => {
			expect(parseBlockQuery("tag: home/calls, work").filters.tags).toEqual(["home/calls", "work"]);
		});

		it("drops a repeat ignoring case and keeps the first typing and the order", () => {
			expect(parseBlockQuery("tag: Home, work, HOME, @home").filters.tags).toEqual(["Home", "work"]);
		});

		it("#190: a repeat is found by the tag key, so a name typed composed and decomposed is one tag", () => {
			expect(parseBlockQuery("tag: Café, CAFÉ, work").filters.tags).toEqual(["Café", "work"]);
		});

		it("an empty item is one error for the line and the line is left out", () => {
			for (const value of ["home,", ",home", "home,,work", "home, @", ","]) {
				const r = parseBlockQuery(`tag: ${value}`);
				expect(r.errors, value).toEqual([`A tag name is missing in “${value}”.`]);
				expect(r.filters, value).toEqual({});
			}
		});

		it("an empty value keeps its own message", () => {
			expect(parseBlockQuery("tag:").errors).toEqual(["The “tag” filter needs a value."]);
			expect(parseBlockQuery("tag: @").errors).toEqual(["The “tag” filter needs a value."]);
		});

		it("a bad tag line does not stop the others", () => {
			const r = parseBlockQuery("list: Work\ntag: home,\ndue: today");
			expect(r.filters).toEqual({ list: "Work", due: "today" });
			expect(r.errors).toHaveLength(1);
		});
	});

	describe("block query parser: chips for the new keys", () => {
		it("tags, due and scheduled in a fixed order", () => {
			const { filters } = parseBlockQuery("scheduled: THIS WEEK\ndue: overdue\ntag: @Home ,work\nlist: Work");
			expect(describeBlockFilters(filters)).toEqual(["list: Work", "tag: Home, work", "due: overdue", "scheduled: this week"]);
		});

		it("re-parsing the chips gives the same filters", () => {
			const { filters } = parseBlockQuery("list: Work\ntag: Home, work\ndue: next 7 days\nscheduled: today\npriority: high");
			expect(parseBlockQuery(describeBlockFilters(filters).join("\n"))).toEqual({ filters, errors: [] });
		});

		it("each scheduled value reads like its source", () => {
			for (const [value] of VALUES) {
				const text = value.toLowerCase().replace(/\s+/g, " ");
				expect(describeBlockFilters(parseBlockQuery(`scheduled: ${value}`).filters)).toEqual([`scheduled: ${text}`]);
			}
		});
	});
});

describe("block query parser: specific dates", () => {
	const RANGE = "Use today, overdue, this week, next 7 days, a date like 20-10-2026, or a range like 01-10-2026 to 15-10-2026.";
	const one = (date: string) => ({ from: date, to: date });

	it.each([
		["a day in the past", "02-10-2026", one("2026-10-02")],
		["a day in the future", "20-10-2026", one("2026-10-20")],
		["the last day of a leap year", "31-12-2028", one("2028-12-31")],
		["a leap day", "29-02-2028", one("2028-02-29")],
		["a range", "01-10-2026 to 15-10-2026", { from: "2026-10-01", to: "2026-10-15" }],
		["a range of one day", "05-10-2026 to 05-10-2026", one("2026-10-05")],
		["a range over a year end", "28-12-2026 to 03-01-2027", { from: "2026-12-28", to: "2027-01-03" }],
		["spacing and case around to", "  01-10-2026   TO   15-10-2026  ", { from: "2026-10-01", to: "2026-10-15" }],
		["a mixed case to", "01-10-2026 To 15-10-2026", { from: "2026-10-01", to: "2026-10-15" }],
	])("%s is read for due and scheduled: %s", (_name, value, range) => {
		expect(parseBlockQuery(`due: ${value}`)).toEqual({ filters: { due: range }, errors: [] });
		expect(parseBlockQuery(`scheduled: ${value}`)).toEqual({ filters: { scheduled: range }, errors: [] });
	});

	it.each([
		["a month name", "Oct 20"],
		["a relative word", "tomorrow"],
		["a weekday", "Friday"],
		["slashes", "02/10/2026"],
		["year first", "2026-10-02"],
		["a one-digit day", "2-10-2026"],
		["a one-digit month", "02-1-2026"],
		["a two-digit year", "02-10-26"],
		["a day that does not exist", "30-02-2026"],
		["a month that does not exist", "10-13-2026"],
		["a leap day in a common year", "29-02-2027"],
		["a range that ends before it starts", "15-10-2026 to 01-10-2026"],
		["a range ending in words", "01-10-2026 to Oct 15"],
		["a range starting in words", "Oct 1 to 15-10-2026"],
		["a range ending in a year-first date", "01-10-2026 to 2026-10-15"],
		["a dash instead of to", "01-10-2026 - 15-10-2026"],
		["a range with no end", "01-10-2026 to"],
		["a range with a second to", "01-10-2026 to 05-10-2026 to 15-10-2026"],
		["to with no space", "01-10-2026to15-10-2026"],
		["a date with trailing text", "02-10-2026 at 9am"],
		["a date list", "01-10-2026, 02-10-2026"],
		["a date with a time", "02-10-2026 14:00"],
	])("%s is an error for due and scheduled: %s", (_name, value) => {
		expect(parseBlockQuery(`due: ${value}`)).toEqual({ filters: {}, errors: [`Unknown due value \u201c${value}\u201d. ${RANGE}`] });
		expect(parseBlockQuery(`scheduled: ${value}`)).toEqual({ filters: {}, errors: [`Unknown scheduled value \u201c${value}\u201d. ${RANGE}`] });
	});

	it("the error shows the value as typed, without the surrounding spaces", () => {
		expect(parseBlockQuery("due:   30-02-2026   ").errors).toEqual([`Unknown due value \u201c30-02-2026\u201d. ${RANGE}`]);
	});

	it.each([
		["a day", "due: 02-10-2026", ["due: 02-10-2026"]],
		["a range", "due: 01-10-2026 to 15-10-2026", ["due: 01-10-2026 to 15-10-2026"]],
		["a range with spacing and case", "scheduled:  01-10-2026   TO  15-10-2026", ["scheduled: 01-10-2026 to 15-10-2026"]],
		["a range of one day reads as the day", "due: 05-10-2026 to 05-10-2026", ["due: 05-10-2026"]],
		["both keys in the fixed order", "scheduled: 20-10-2026 to 25-10-2026\ndue: 02-10-2026", ["due: 02-10-2026", "scheduled: 20-10-2026 to 25-10-2026"]],
	])("the summary line shows %s", (_name, source, chips) => {
		const { filters } = parseBlockQuery(source);
		expect(describeBlockFilters(filters)).toEqual(chips);
		expect(parseBlockQuery(chips.join("\n"))).toEqual({ filters, errors: [] });
	});
});
