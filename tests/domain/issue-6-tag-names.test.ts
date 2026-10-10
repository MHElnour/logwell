import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { TAG_REPEAT_MESSAGE, TagNames, requireUniqueTagName, tagLeaf, tagNameClash, tagNameClashMessage } from "../../src/domain/tags";
import { fieldHashes } from "../../src/domain/ticktick/mapping";
import { isSyncedTag, pullableTagName, syncedTagLeaves, ttTagName, unsyncedTagKeys } from "../../src/domain/ticktick/tags";
import type { Tag } from "../../src/domain/types";

// A tag name (the last segment of its key) is used once, whatever its parent. Existing duplicates
// still load; the later one does not sync with TickTick.

const tag = (key: string, displayName: string, createdAt = "2026-10-01T10:00:00Z"): Tag => ({ key, displayName, color: null, createdAt, modifiedAt: createdAt });
const map = (...tags: Tag[]) => new Map(tags.map((t) => [t.key, t]));

describe("tag names (D29)", () => {
	it("the leaf is the last path segment", () => {
		expect(tagLeaf("home/calls")).toBe("calls");
		expect(tagLeaf("calls")).toBe("calls");
		expect(tagLeaf("a//b")).toBe("a//b");
	});

	it("a new key clashes with a tag of the same name under another parent, or at the root", () => {
		expect(tagNameClash(["home/calls"], "calls")).toBe("home/calls");
		expect(tagNameClash(["home/calls"], "work/calls")).toBe("home/calls");
		expect(tagNameClash(["calls"], "work/calls")).toBe("calls");
	});

	it("an implicit parent is a name too", () => {
		expect(tagNameClash(["home/calls"], "work/home")).toBe("home");
		// The parent itself may become a tag, and may get more children.
		expect(tagNameClash(["home/calls"], "home")).toBeNull();
		expect(tagNameClash(["home/calls"], "home/garden")).toBeNull();
	});

	it("a new parent segment that repeats a name clashes", () => {
		expect(tagNameClash(["work/home"], "home/calls")).toBe("work/home");
	});

	it("the same key, and unrelated names, do not clash", () => {
		expect(tagNameClash(["home/calls"], "home/calls")).toBeNull();
		expect(tagNameClash(["home/calls"], "callsx")).toBeNull();
	});

	it("names compare case-insensitively (keys are lowercase)", () => {
		const tags = map(tag("home/calls", "Home/Calls"));
		expect(() => requireUniqueTagName(tags, "calls")).toThrow(DomainError);
	});

	it("the message names the existing tag and its parent, in its own casing", () => {
		const tags = map(tag("home/calls", "Home/Calls"), tag("errands", "Errands"));
		expect(tagNameClashMessage(tags, "home/calls")).toBe("A tag named Calls already exists under Home.");
		expect(tagNameClashMessage(tags, "errands")).toBe("A tag named Errands already exists.");
		expect(tagNameClashMessage(tags, "home")).toBe("A tag named Home already exists.");
		expect(() => requireUniqueTagName(tags, "work/errands")).toThrow("A tag named Errands already exists.");
	});

	it("a tag owns by the older of its own date and its oldest child's, so a parent that gets a record keeps its name", () => {
		const homeCalls = tag("home/calls", "Home/Calls", "2026-01-01T00:00:00Z");
		const workHome = tag("work/home", "Work/Home", "2026-02-01T00:00:00Z");
		// An implicit parent takes its oldest child's date.
		expect(TagNames.of([homeCalls, workHome]).owner("home")).toBe("home");
		// Its record, made later, does not move the name.
		const home = tag("home", "Home", "2026-03-01T00:00:00Z");
		expect(TagNames.of([homeCalls, workHome, home]).owner("home")).toBe("home");
		expect(isSyncedTag(TagNames.of([homeCalls, workHome, home]), "home/calls")).toBe(true);
		// Ties go to the smaller key.
		const a = tag("a/x", "A/X", "2026-01-01T00:00:00Z");
		const b = tag("b/x", "B/X", "2026-01-01T00:00:00Z");
		expect(TagNames.of([b, a]).owner("x")).toBe("a/x");
	});

	it("a tag cannot have its parent's name", () => {
		expect(() => requireUniqueTagName(map(), "calls/calls")).toThrow(TAG_REPEAT_MESSAGE);
		expect(TAG_REPEAT_MESSAGE).toBe("A tag can't have the same name as its parent.");
	});

	it("the owner of a duplicated name is the oldest tag", () => {
		const names = TagNames.of([tag("work/calls", "Work/Calls", "2026-10-02T00:00:00Z"), tag("home/calls", "Home/Calls", "2026-10-01T00:00:00Z")]);
		expect(names.owner("calls")).toBe("home/calls");
		expect(names.owner("home")).toBe("home");
		expect(names.owner("nope")).toBeUndefined();
	});
});

describe("tags and TickTick", () => {
	it("a TickTick name is a lowercase leaf; one Logwell cannot hold is null", () => {
		expect(ttTagName("Calls")).toBe("calls");
		expect(ttTagName("a/b")).toBeNull();
		expect(ttTagName("two words")).toBeNull();
		expect(ttTagName("")).toBeNull();
	});

	it("a later duplicate, a deep key and a child of a duplicated parent are not synced", () => {
		const names = TagNames.of([
			tag("home/calls", "Home/Calls", "2026-10-01T00:00:00Z"),
			tag("work/calls", "Work/Calls", "2026-10-02T00:00:00Z"),
			tag("a/b/c", "A/B/C"),
			tag("x/home", "X/Home", "2026-10-03T00:00:00Z"),
			tag("plain", "Plain"),
		]);
		expect(isSyncedTag(names, "home/calls")).toBe(true);
		expect(isSyncedTag(names, "plain")).toBe(true);
		expect(isSyncedTag(names, "work/calls")).toBe(false);
		expect(isSyncedTag(names, "a/b/c")).toBe(false);
		expect(isSyncedTag(names, "x/home")).toBe(false);
		expect(unsyncedTagKeys(names, ["plain", "work/calls", "home/calls", "a/b/c"])).toEqual(["work/calls", "a/b/c"]);
		expect(syncedTagLeaves(names, ["plain", "work/calls", "home/calls", "plain"])).toEqual(["calls", "plain"]);
	});

	it("a pulled name is pullable when it is new or its owner syncs", () => {
		const names = TagNames.of([tag("a/b/c", "A/B/C"), tag("home/calls", "Home/Calls")]);
		expect(pullableTagName(names, "Calls")).toBe("calls");
		expect(pullableTagName(names, "garden")).toBe("garden");
		// Owned by a tag that cannot sync (too deep): left in TickTick, never pulled.
		expect(pullableTagName(names, "c")).toBeNull();
		expect(pullableTagName(names, "a/b")).toBeNull();
	});

	it("the tags field hashes as an order-insensitive set", () => {
		const base = { title: "x", status: "open" as const, priority: 0 as const, date: null, parent: null, section: null };
		const a = fieldHashes({ ...base, tags: ["b", "a"] });
		const b = fieldHashes({ ...base, tags: ["a", "b", "a"] });
		const c = fieldHashes({ ...base, tags: [] });
		expect(a.tags).toBe(b.tags);
		expect(a.tags).not.toBe(c.tags);
		expect(a.title).toBe(c.title);
	});
});
