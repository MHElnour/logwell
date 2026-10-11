import { describe, expect, it } from "vitest";
import { describeBlockFilters, parseBlockQuery } from "../../src/parsing/blockQuery";

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
		expect(r.errors).toEqual(["Unknown scheduled value “tomorrow”. Use today, overdue, this week or next 7 days."]);
		expect(r.filters).toEqual({});
	});

	it("a due value error names due", () => {
		expect(parseBlockQuery("due: soon").errors).toEqual(["Unknown due value “soon”. Use today, overdue, this week or next 7 days."]);
	});

	it("does not take a comma list", () => {
		expect(parseBlockQuery("scheduled: today, overdue").errors).toHaveLength(1);
	});

	it("an empty value", () => {
		expect(parseBlockQuery("scheduled:").errors).toEqual(["The “scheduled” filter needs a value."]);
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
