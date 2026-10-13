import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import { makeCtx } from "./helpers";

type TagFixture = { key: string; displayName: string; createdAt?: string };

/** Quick Add with these tags, or with the default test vault's. */
const parseWith = (input: string, tags?: readonly TagFixture[]) => {
	const ctx = makeCtx();
	return parseQuickAdd(input, tags === undefined ? ctx : { ...ctx, tags });
};

describe("Quick Add unique tag names", () => {
	// Quick Add makes no new-tag chip for a name that another tag already uses under another parent.
	// A name alone finds the existing tag (#11); a path under another parent, like a key that is too deep, stays in the title.

	const parse = (input: string) => parseWith(input, [{ key: "home/calls", displayName: "Home/Calls" }]);

	it("@work/calls makes no chip either", () => {
		expect(parse("x @work/calls").chips).toEqual([]);
	});

	it("two new tags of one name in one input: the second stays in the title", () => {
		const r = parseWith("Ring mum @home/calls @work/calls", []);
		expect(r.chips).toHaveLength(1);
		expect(r.chips[0]).toMatchObject({ kind: "tag", tagKey: "home/calls", newTag: true });
		expect(r.fields.newTags).toEqual(["home/calls"]);
		expect(r.title).toBe("Ring mum @work/calls");
	});

	it("a new child's parent name is taken in the same input: another tag of that name stays in the title (#9)", () => {
		const r = parseWith("Ring mum @home/calls @work/home", []);
		expect(r.fields.newTags).toEqual(["home/calls"]);
		expect(r.title).toBe("Ring mum @work/home");
		// The parent itself is no clash: it is the same tag.
		expect(parseWith("Ring mum @home/calls @home", []).fields.newTags).toEqual(["home/calls", "home"]);
	});

	it("a digits-only name is a tag once a tag of that name exists, like a parent made with its child (#9)", () => {
		const tags = [
			{ key: "2024", displayName: "2024" },
			{ key: "2024/taxes", displayName: "2024/Taxes" },
		];
		const r = parseWith("File the forms @2024", tags);
		expect(r.chips[0]).toMatchObject({ kind: "tag", tagKey: "2024" });
		expect(r.title).toBe("File the forms");
		// With no such tag, it stays in the title.
		expect(parseWith("File the forms @2024", []).title).toBe("File the forms @2024");
	});

	it("a tag named like its parent makes no chip", () => {
		expect(parse("x @Garden/garden").chips).toEqual([]);
	});

	it("the existing tag still resolves, and a new unique name is still a new tag", () => {
		expect(parse("x @Home/Calls").chips[0]).toMatchObject({ kind: "tag", tagKey: "home/calls" });
		expect(parse("x @home/garden").chips[0]).toMatchObject({ kind: "tag", tagKey: "home/garden", newTag: true });
		expect(parse("x @home").chips[0]).toMatchObject({ kind: "tag", tagKey: "home", newTag: true });
	});
});

describe("Quick Add tag name length", () => {
	// A new tag name has at most 64 characters (Lists, sections and tags rule 21). Quick Add leaves a longer new `@name` in
	// the title, like any refused name; an existing longer tag still resolves.

	const name64 = "a".repeat(64);
	const name65 = "a".repeat(65);

	it("#7: a new name of 64 characters makes a new-tag chip", () => {
		const r = parseWith(`x @${name64}`);
		expect(r.chips[0]).toMatchObject({ kind: "tag", newTag: true, tagKey: name64 });
		expect(r.fields.newTags).toEqual([name64]);
	});

	it("#7: a new name of 65 characters makes no chip and stays in the title", () => {
		const r = parseWith(`x @${name65}`);
		expect(r.chips).toEqual([]);
		expect(r.fields.newTags ?? []).toEqual([]);
		expect(r.title).toBe(`x @${name65}`);
	});

	it("#7: a long new child under an existing parent is refused too", () => {
		const r = parseWith(`x @home/${name65}`, [{ key: "home", displayName: "Home" }]);
		expect(r.chips).toEqual([]);
	});

	it("#7: an existing tag longer than 64 characters still resolves", () => {
		const r = parseWith(`x @${name65}`, [{ key: name65, displayName: name65 }]);
		expect(r.chips[0]).toMatchObject({ kind: "tag", tagKey: name65 });
		expect(r.chips[0]?.newTag).toBeUndefined();
	});
});

describe("Quick Add: a tag by its own name", () => {
	// A child tag typed by its own name finds the tag in Quick Add (#11). Which tag owns a name that two tags use is
	// tag-tree.test.ts's to check; one case here shows that Quick Add follows it.

	const OWN: TagFixture[] = [{ key: "home/calls", displayName: "Home/Calls", createdAt: "2026-10-01T10:00:00Z" }];
	const parse = (input: string, tags: readonly TagFixture[] = OWN) => parseWith(input, tags);

	it("#11: @calls applies the child tag, makes no new tag and leaves the title clean", () => {
		const r = parse("Ring mum @calls");
		expect(r.chips).toHaveLength(1);
		expect(r.chips[0]).toMatchObject({ kind: "tag", status: "applied", tagKey: "home/calls" });
		expect(r.chips[0]?.newTag).toBeUndefined();
		expect(r.fields.tagKeys).toEqual(["home/calls"]);
		expect(r.fields.newTags).toEqual([]);
		expect(r.title).toBe("Ring mum");
	});

	it("#11: ignores case", () => {
		expect(parse("x @CaLLs").fields.tagKeys).toEqual(["home/calls"]);
	});

	it("#11: the full path still works", () => {
		expect(parse("x @home/calls").fields.tagKeys).toEqual(["home/calls"]);
	});

	it("#11: another parent's path stays in the title", () => {
		const r = parse("x @work/calls");
		expect(r.chips).toEqual([]);
		expect(r.title).toBe("x @work/calls");
	});

	it("#11: @home still makes a new tag: it is only the parent of a tag, not a tag", () => {
		expect(parse("x @home").chips[0]).toMatchObject({ kind: "tag", tagKey: "home", newTag: true });
	});

	it("#11: the oldest tag owns a name that two tags use", () => {
		const r = parse("x @calls", [
			{ key: "work/calls", displayName: "Work/Calls", createdAt: "2026-10-05T10:00:00Z" },
			{ key: "home/calls", displayName: "Home/Calls", createdAt: "2026-10-01T10:00:00Z" },
		]);
		expect(r.fields.tagKeys).toEqual(["home/calls"]);
	});

	it("#11: the same tag twice is one tag", () => {
		expect(parse("x @calls @home/calls").fields.tagKeys).toEqual(["home/calls"]);
	});

	it("#11: works without createdAt on the context tags", () => {
		expect(parse("x @calls", [{ key: "home/calls", displayName: "Home/Calls" }]).fields.tagKeys).toEqual(["home/calls"]);
	});
});

describe("Quick Add tag depth", () => {
	// Quick Add makes no new-tag chip for a key with more than one "/". Like any invalid key, the
	// token is not a token: it stays in the title as text.

	it("@a/b still makes a new-tag chip", () => {
		const r = parseWith("x @a/b");
		expect(r.chips[0]).toMatchObject({ kind: "tag", newTag: true, tagKey: "a/b" });
		expect(r.fields.newTags).toEqual(["a/b"]);
	});

	it("@a/b/c makes no chip, creates no tag and stays in the title", () => {
		const r = parseWith("x @a/b/c");
		expect(r.chips).toEqual([]);
		expect(r.fields.newTags ?? []).toEqual([]);
		expect(r.title).toBe("x @a/b/c");
	});

	it("an empty segment counts: @a//b is not a new tag", () => {
		expect(parseWith("x @a//b").chips).toEqual([]);
	});

	it("an existing deeper tag still resolves, with no newTag", () => {
		const r = parseWith("x @A/B/C", [{ key: "a/b/c", displayName: "A/B/C" }]);
		expect(r.chips[0]).toMatchObject({ kind: "tag", tagKey: "a/b/c" });
		expect(r.chips[0]?.newTag).toBeUndefined();
		expect(r.fields.newTags ?? []).toEqual([]);
	});
});
