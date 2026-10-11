import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import { makeCtx } from "./helpers";

// A child tag typed by its own name finds the tag in Quick Add (#11).

const TAGS = [{ key: "home/calls", displayName: "Home/Calls", createdAt: "2026-10-01T10:00:00Z" }];
const parse = (input: string, tags: readonly { key: string; displayName: string; createdAt?: string }[] = TAGS) => parseQuickAdd(input, { ...makeCtx(), tags });

describe("Quick Add: a tag by its own name", () => {
	it("@calls applies the child tag, makes no new tag and leaves the title clean", () => {
		const r = parse("Ring mum @calls");
		expect(r.chips).toHaveLength(1);
		expect(r.chips[0]).toMatchObject({ kind: "tag", status: "applied", tagKey: "home/calls" });
		expect(r.chips[0]?.newTag).toBeUndefined();
		expect(r.fields.tagKeys).toEqual(["home/calls"]);
		expect(r.fields.newTags).toEqual([]);
		expect(r.title).toBe("Ring mum");
	});

	it("ignores case", () => {
		expect(parse("x @CaLLs").fields.tagKeys).toEqual(["home/calls"]);
	});

	it("the full path still works", () => {
		expect(parse("x @home/calls").fields.tagKeys).toEqual(["home/calls"]);
	});

	it("another parent's path stays in the title", () => {
		const r = parse("x @work/calls");
		expect(r.chips).toEqual([]);
		expect(r.title).toBe("x @work/calls");
	});

	it("@home still makes a new tag: it is only the parent of a tag, not a tag", () => {
		expect(parse("x @home").chips[0]).toMatchObject({ kind: "tag", tagKey: "home", newTag: true });
	});

	it("the oldest tag owns a name that two tags use", () => {
		const r = parse("x @calls", [
			{ key: "work/calls", displayName: "Work/Calls", createdAt: "2026-10-05T10:00:00Z" },
			{ key: "home/calls", displayName: "Home/Calls", createdAt: "2026-10-01T10:00:00Z" },
		]);
		expect(r.fields.tagKeys).toEqual(["home/calls"]);
	});

	it("an exact root tag beats an older child of the same name", () => {
		const r = parse("x @calls", [
			{ key: "home/calls", displayName: "Home/Calls", createdAt: "2026-10-01T10:00:00Z" },
			{ key: "calls", displayName: "Calls", createdAt: "2026-10-09T10:00:00Z" },
		]);
		expect(r.fields.tagKeys).toEqual(["calls"]);
	});

	it("the same tag twice is one tag", () => {
		expect(parse("x @calls @home/calls").fields.tagKeys).toEqual(["home/calls"]);
	});

	it("works without createdAt on the context tags", () => {
		expect(parse("x @calls", [{ key: "home/calls", displayName: "Home/Calls" }]).fields.tagKeys).toEqual(["home/calls"]);
	});
});
