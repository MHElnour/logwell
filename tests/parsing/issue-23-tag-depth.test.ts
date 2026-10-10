import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import { makeCtx } from "./helpers";

// Quick Add makes no new-tag chip for a key with more than one "/". Like any invalid key, the
// token is not a token: it stays in the title as text.

const parse = (input: string, tags?: { key: string; displayName: string }[]) => {
	const ctx = makeCtx();
	return parseQuickAdd(input, tags === undefined ? ctx : { ...ctx, tags });
};

describe("Quick Add tag depth", () => {
	it("@a/b still makes a new-tag chip", () => {
		const r = parse("x @a/b");
		expect(r.chips[0]).toMatchObject({ kind: "tag", newTag: true, tagKey: "a/b" });
		expect(r.fields.newTags).toEqual(["a/b"]);
	});

	it("@a/b/c makes no chip, creates no tag and stays in the title", () => {
		const r = parse("x @a/b/c");
		expect(r.chips).toEqual([]);
		expect(r.fields.newTags ?? []).toEqual([]);
		expect(r.title).toBe("x @a/b/c");
	});

	it("an empty segment counts: @a//b is not a new tag", () => {
		expect(parse("x @a//b").chips).toEqual([]);
	});

	it("an existing deeper tag still resolves, with no newTag", () => {
		const r = parse("x @A/B/C", [{ key: "a/b/c", displayName: "A/B/C" }]);
		expect(r.chips[0]).toMatchObject({ kind: "tag", tagKey: "a/b/c" });
		expect(r.chips[0]?.newTag).toBeUndefined();
		expect(r.fields.newTags ?? []).toEqual([]);
	});
});
