import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import { makeCtx } from "./helpers";

// Quick Add makes no new-tag chip for a name that another tag already uses under another parent.
// A name alone finds the existing tag (#11); a path under another parent, like a key that is too deep, stays in the title.

const TAGS = [{ key: "home/calls", displayName: "Home/Calls" }];
const parse = (input: string) => {
	const ctx = makeCtx();
	return parseQuickAdd(input, { ...ctx, tags: TAGS });
};

describe("Quick Add unique tag names", () => {
	it("@calls finds the tag under another parent and makes no new tag", () => {
		const r = parse("Ring mum @Calls");
		expect(r.chips).toHaveLength(1);
		expect(r.chips[0]).toMatchObject({ kind: "tag", tagKey: "home/calls" });
		expect(r.fields.newTags).toEqual([]);
		expect(r.title).toBe("Ring mum");
	});

	it("@work/calls makes no chip either", () => {
		expect(parse("x @work/calls").chips).toEqual([]);
	});

	it("two new tags of one name in one input: the second stays in the title", () => {
		const ctx = makeCtx();
		const r = parseQuickAdd("Ring mum @home/calls @work/calls", { ...ctx, tags: [] });
		expect(r.chips).toHaveLength(1);
		expect(r.chips[0]).toMatchObject({ kind: "tag", tagKey: "home/calls", newTag: true });
		expect(r.fields.newTags).toEqual(["home/calls"]);
		expect(r.title).toBe("Ring mum @work/calls");
		// The same new tag twice is still one tag.
		expect(parseQuickAdd("x @home/calls y @home/calls", { ...ctx, tags: [] }).fields.newTags).toEqual(["home/calls"]);
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
