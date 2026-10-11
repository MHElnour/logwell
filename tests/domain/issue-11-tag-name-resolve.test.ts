import { describe, expect, it } from "vitest";
import { TagNames, resolveTagName, tagLabel, tagNamesOf } from "../../src/domain/tags";
import type { Tag } from "../../src/domain/types";

// A tag typed by its own name finds the tag (#11), and a tag is shown by its own name.

const tag = (key: string, displayName: string, createdAt = "2026-10-01T10:00:00Z"): Tag => ({ key, displayName, color: null, createdAt, modifiedAt: createdAt });
const map = (...tags: Tag[]) => new Map(tags.map((t) => [t.key, t]));
const namesOf = (...tags: Tag[]) => TagNames.of(tags);

describe("resolveTagName", () => {
	const names = namesOf(tag("home", "Home"), tag("home/calls", "Home/Calls"), tag("errands", "Errands"));

	it("an exact key resolves to itself", () => {
		expect(resolveTagName(names, "home/calls")).toBe("home/calls");
		expect(resolveTagName(names, "errands")).toBe("errands");
	});

	it("a parent resolves to itself; a parent with no record does not resolve", () => {
		expect(resolveTagName(names, "home")).toBe("home");
		expect(resolveTagName(namesOf(tag("home/calls", "Home/Calls")), "home")).toBeNull();
	});

	it("a name alone finds the child tag", () => {
		expect(resolveTagName(names, "calls")).toBe("home/calls");
	});

	it("ignores case, a leading @ and spaces around, and normalizes to NFC", () => {
		expect(resolveTagName(names, "@CALLS")).toBe("home/calls");
		expect(resolveTagName(names, "  Home/CALLS ")).toBe("home/calls");
		const accented = namesOf(tag("home/café", "Home/Café"));
		expect(resolveTagName(accented, "café")).toBe("home/café");
	});

	it("the oldest tag owns a name that older files use twice", () => {
		const dup = namesOf(tag("work/calls", "Work/Calls", "2026-10-05T10:00:00Z"), tag("home/calls", "Home/Calls", "2026-10-01T10:00:00Z"));
		expect(resolveTagName(dup, "calls")).toBe("home/calls");
		expect(resolveTagName(dup, "work/calls")).toBe("work/calls");
	});

	it("an exact root tag beats an older child of the same name", () => {
		const dup = namesOf(tag("home/calls", "Home/Calls", "2026-10-01T10:00:00Z"), tag("calls", "Calls", "2026-10-09T10:00:00Z"));
		expect(resolveTagName(dup, "calls")).toBe("calls");
	});

	it("a path that is not a tag does not resolve by its last name", () => {
		expect(resolveTagName(names, "work/calls")).toBeNull();
		expect(resolveTagName(names, "home/garden")).toBeNull();
	});

	it("an empty, unknown or invalid name does not resolve", () => {
		expect(resolveTagName(names, "")).toBeNull();
		expect(resolveTagName(names, "@")).toBeNull();
		expect(resolveTagName(names, "nope")).toBeNull();
		expect(resolveTagName(names, "a b")).toBeNull();
	});
});

describe("tagLabel", () => {
	it("a child shows its own name in the user's casing", () => {
		const tags = map(tag("home/calls", "Home/Calls"), tag("errands", "Errands"));
		expect(tagLabel(tags, "home/calls")).toBe("Calls");
		expect(tagLabel(tags, "errands")).toBe("Errands");
	});

	it("a parent shows its own name", () => {
		expect(tagLabel(map(tag("home", "Home"), tag("home/calls", "Home/calls")), "home")).toBe("Home");
	});

	it("a name two tags use shows the full path, so each label finds its own tag", () => {
		const tags = map(tag("home/calls", "Home/Calls", "2026-10-01T10:00:00Z"), tag("work/calls", "Work/Calls", "2026-10-05T10:00:00Z"));
		expect(tagLabel(tags, "home/calls")).toBe("Home/Calls");
		expect(tagLabel(tags, "work/calls")).toBe("Work/Calls");
		const names = tagNamesOf(tags);
		for (const k of ["home/calls", "work/calls"]) expect(resolveTagName(names, tagLabel(tags, k))).toBe(k);
	});

	it("a unique label resolves back to its tag", () => {
		const tags = map(tag("home/calls", "Home/Calls"), tag("errands", "Errands"));
		const names = tagNamesOf(tags);
		for (const k of tags.keys()) expect(resolveTagName(names, tagLabel(tags, k))).toBe(k);
	});

	it("deleting the duplicate gives the other tag its own name again", () => {
		const both = map(tag("home/calls", "Home/Calls"), tag("work/calls", "Work/Calls"));
		const rest = new Map(both);
		rest.delete("work/calls");
		expect(tagLabel(both, "home/calls")).toBe("Home/Calls");
		expect(tagLabel(rest, "home/calls")).toBe("Calls");
	});

	it("a key without a record shows its key", () => {
		expect(tagLabel(new Map(), "gone")).toBe("gone");
	});

	it("a key with an empty segment is one flat name", () => {
		expect(tagLabel(map(tag("a//b", "a//b")), "a//b")).toBe("a//b");
	});
});

describe("TagNames.count and tagNamesOf", () => {
	it("count is how many tags use a name", () => {
		const names = namesOf(tag("home", "Home"), tag("home/calls", "Home/Calls"), tag("work/calls", "Work/Calls"));
		expect(names.count("calls")).toBe(2);
		expect(names.count("home")).toBe(1);
		expect(names.count("work")).toBe(0);
		expect(names.count("nope")).toBe(0);
	});

	it("tagNamesOf is memoized per tags map", () => {
		const tags = map(tag("a", "A"));
		expect(tagNamesOf(tags)).toBe(tagNamesOf(tags));
		expect(tagNamesOf(new Map(tags))).not.toBe(tagNamesOf(tags));
	});
});
