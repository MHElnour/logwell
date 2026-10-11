import { describe, expect, it } from "vitest";
import { isUnderTag, tagDisplayPath, tagPath, tagTree } from "../../src/domain/tags";
import type { Tag } from "../../src/domain/types";

// Parent tags. Keys are lowercase and may contain "/".

const tag = (displayName: string, color: Tag["color"] = "blue"): Tag => ({
	key: displayName.toLowerCase(),
	displayName,
	color,
	createdAt: "2026-10-01T10:00:00Z",
	modifiedAt: "2026-10-01T10:00:00Z",
});

describe("tagPath and isUnderTag", () => {
	it("splits a key at the slashes", () => {
		expect(tagPath("programming/go")).toEqual(["programming", "go"]);
		expect(tagPath("plain")).toEqual(["plain"]);
	});

	it("keeps a key with an empty segment as one flat path", () => {
		expect(tagPath("a//b")).toEqual(["a//b"]);
		expect(tagPath("/a")).toEqual(["/a"]);
		expect(tagPath("a/")).toEqual(["a/"]);
	});

	it("a descendant is under its parent, the tag itself counts, a longer name or a sibling does not", () => {
		expect(isUnderTag("programming/go", "programming")).toBe(true);
		expect(isUnderTag("programming/go/tools", "programming")).toBe(true);
		expect(isUnderTag("programming", "programming")).toBe(true);
		expect(isUnderTag("programmingx", "programming")).toBe(false);
		expect(isUnderTag("programmingx/go", "programming")).toBe(false);
		expect(isUnderTag("programming", "programming/go")).toBe(false);
		expect(isUnderTag("programming/python", "programming/go")).toBe(false);
	});

	it("compares path segments, so keys with empty segments agree with the tree (no parent for them)", () => {
		expect(isUnderTag("a//b", "a")).toBe(false);
		expect(isUnderTag("a/", "a")).toBe(false);
		expect(isUnderTag("/a", "")).toBe(false);
		expect(isUnderTag("a//b", "a//b")).toBe(true);
		expect(isUnderTag("a//b/c", "a")).toBe(false);
		expect(isUnderTag("a/b", "a/")).toBe(false);
	});
});

describe("tagTree", () => {
	it("nests children under their parent tag, shown by their last segment", () => {
		const tree = tagTree([tag("Programming/Python"), tag("Programming/Go"), tag("Programming")], new Map());
		expect(tree).toHaveLength(1);
		const parent = tree[0]!;
		expect(parent).toMatchObject({ key: "programming", name: "Programming", tag: { key: "programming" } });
		expect(parent.children.map((c) => [c.key, c.name, c.tag.key])).toEqual([
			["programming/go", "Go", "programming/go"],
			["programming/python", "Python", "programming/python"],
		]);
	});

	it("a prefix that is also a tag record is a real parent with its color", () => {
		const tree = tagTree([tag("Programming", "red"), tag("Programming/Go")], new Map());
		expect(tree[0]!.tag.color).toBe("red");
		expect(tree[0]!.children.map((c) => c.key)).toEqual(["programming/go"]);
	});

	it("nests a deeper path from an older file under each level's tag", () => {
		const tree = tagTree([tag("A/B/C"), tag("A"), tag("A/B")], new Map());
		expect(tree.map((n) => n.key)).toEqual(["a"]);
		expect(tree[0]!.children.map((n) => n.key)).toEqual(["a/b"]);
		expect(tree[0]!.children[0]!.children.map((n) => [n.key, n.name])).toEqual([["a/b/c", "C"]]);
	});

	it("sorts siblings by display name, ignoring case, and keeps plain tags flat", () => {
		const tree = tagTree([tag("zeta"), tag("Alpha"), tag("beta"), tag("beta/x")], new Map());
		expect(tree.map((n) => n.name)).toEqual(["Alpha", "beta", "zeta"]);
		expect(tree[0]!.children).toEqual([]);
	});

	it("takes each node's count from the counts map, 0 when absent", () => {
		const counts = new Map([["programming", 3], ["programming/go", 2]]);
		const tree = tagTree([tag("Programming"), tag("Programming/Go"), tag("Programming/Python")], counts);
		expect(tree[0]!.count).toBe(3);
		expect(tree[0]!.children.map((c) => c.count)).toEqual([2, 0]);
	});

	it("does not confuse programmingx with a child of programming", () => {
		const tree = tagTree([tag("Programming"), tag("Programming/Go"), tag("programmingx")], new Map());
		expect(tree.map((n) => [n.key, n.name])).toEqual([["programming", "Programming"], ["programmingx", "programmingx"]]);
		expect(tree[1]!.children).toEqual([]);
	});
});

describe("tagDisplayPath", () => {
	it("is the record's display name, or the key without a record", () => {
		const tags = new Map([["programming/go", tag("Programming/Go")]]);
		expect(tagDisplayPath(tags, "programming/go")).toBe("Programming/Go");
		expect(tagDisplayPath(tags, "programming")).toBe("programming");
		expect(tagDisplayPath(tags, "unknown")).toBe("unknown");
	});
});
