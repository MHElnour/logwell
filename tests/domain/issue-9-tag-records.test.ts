import { describe, expect, it } from "vitest";
import { TagNames, tagDisplayPath, tagLabel, tagTree } from "../../src/domain/tags";
import type { Tag } from "../../src/domain/types";

// Every tag the tree shows is a tag record (Lists, sections and tags rule 25); a name is owned by the oldest record
// that uses it (rule 22).

const tag = (key: string, displayName: string, createdAt = "2026-01-01T00:00:00.000Z"): Tag => ({ key, displayName, color: null, createdAt, modifiedAt: createdAt });
const map = (...tags: Tag[]) => new Map(tags.map((t) => [t.key, t]));

describe("tagTree from records", () => {
	it("nests a child under its parent record; every node carries its record", () => {
		const home = tag("home", "Home");
		const calls = tag("home/calls", "Home/Calls");
		const tree = tagTree([calls, home], new Map([["home", 2]]));
		expect(tree).toHaveLength(1);
		expect(tree[0]).toMatchObject({ key: "home", name: "Home", tag: home, count: 2 });
		expect(tree[0]!.children).toEqual([{ key: "home/calls", name: "Calls", tag: calls, count: 0, children: [] }]);
	});

	it("a child whose parent record is missing is shown at the top, never dropped", () => {
		const calls = tag("home/calls", "Home/Calls");
		const tree = tagTree([calls], new Map());
		expect(tree.map((n) => [n.key, n.name, n.tag])).toEqual([["home/calls", "Calls", calls]]);
	});
});

describe("tag names from records", () => {
	it("a name is the record's own: a parent's name exists only with its record", () => {
		const names = TagNames.of([tag("home/calls", "Home/Calls")]);
		expect(names.has("home/calls")).toBe(true);
		expect(names.has("home")).toBe(false);
		expect(names.owner("home")).toBeUndefined();
		expect(names.owner("calls")).toBe("home/calls");
	});

	it("a node owns its name by its own record's createdAt, not its children's", () => {
		const names = TagNames.of([
			tag("work/home", "Work/Home", "2026-02-01T00:00:00.000Z"),
			tag("work", "Work", "2026-02-01T00:00:00.000Z"),
			tag("home", "Home", "2026-03-01T00:00:00.000Z"),
			tag("home/calls", "Home/Calls", "2026-01-01T00:00:00.000Z"),
		]);
		expect(names.owner("home")).toBe("work/home");
	});

	it("a new key's parent name is checked too", () => {
		const names = TagNames.of([tag("work", "Work"), tag("work/home", "Work/Home")]);
		expect(names.clash("home/calls")).toBe("work/home");
	});
});

describe("tagDisplayPath", () => {
	it("is the record's display name, or the key when there is no record", () => {
		const tags = map(tag("home", "Home"), tag("home/calls", "Home/Calls"));
		expect(tagDisplayPath(tags, "home/calls")).toBe("Home/Calls");
		expect(tagDisplayPath(map(tag("home/calls", "Home/Calls")), "home")).toBe("home");
		expect(tagLabel(tags, "home/calls")).toBe("Calls");
	});
});
