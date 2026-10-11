import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import { makeCtx } from "./helpers";

// A new tag name has at most 64 characters (Lists, sections and tags rule 21). Quick Add leaves a longer new `@name` in
// the title, like any refused name; an existing longer tag still resolves.

const parse = (input: string, tags?: { key: string; displayName: string }[]) => {
	const ctx = makeCtx();
	return parseQuickAdd(input, tags === undefined ? ctx : { ...ctx, tags });
};

const name64 = "a".repeat(64);
const name65 = "a".repeat(65);

describe("Quick Add tag name length", () => {
	it("a new name of 64 characters makes a new-tag chip", () => {
		const r = parse(`x @${name64}`);
		expect(r.chips[0]).toMatchObject({ kind: "tag", newTag: true, tagKey: name64 });
		expect(r.fields.newTags).toEqual([name64]);
	});

	it("a new name of 65 characters makes no chip and stays in the title", () => {
		const r = parse(`x @${name65}`);
		expect(r.chips).toEqual([]);
		expect(r.fields.newTags ?? []).toEqual([]);
		expect(r.title).toBe(`x @${name65}`);
	});

	it("a long new child under an existing parent is refused too", () => {
		const r = parse(`x @home/${name65}`, [{ key: "home", displayName: "Home" }]);
		expect(r.chips).toEqual([]);
	});

	it("an existing tag longer than 64 characters still resolves", () => {
		const r = parse(`x @${name65}`, [{ key: name65, displayName: name65 }]);
		expect(r.chips[0]).toMatchObject({ kind: "tag", tagKey: name65 });
		expect(r.chips[0]?.newTag).toBeUndefined();
	});
});
