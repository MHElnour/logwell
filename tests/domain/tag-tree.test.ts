import { describe, expect, it } from "vitest";
import { hasAllowedTagDepth, isUnderTag, newTagProblem, requireTagDepth, requireUniqueTagName, resolveTagName, TAG_DEPTH_MESSAGE, TAG_LENGTH_MESSAGE, TAG_NAME_MAX, TAG_REPEAT_MESSAGE, tagDisplayPath, tagLabel, tagLeaf, tagNameClashMessage, tagNameRefusal, TagNames, tagNamesOf, tagNameTextProblem, tagPath, tagTree } from "../../src/domain/tags";
import type { Tag } from "../../src/domain/types";
import { DomainError } from "../../src/domain/errors";
import { fieldHashes } from "../../src/domain/ticktick/mapping";
import { isSyncedTag, pullableTagName, syncedTagLeaves, ttTagName } from "../../src/domain/ticktick/tags";

describe("parent tags", () => {
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

		it("every node carries its own record and its count", () => {
			const home = tag("Home");
			const calls = tag("Home/Calls");
			const tree = tagTree([calls, home], new Map([["home", 2]]));
			expect(tree).toHaveLength(1);
			expect(tree[0]).toMatchObject({ key: "home", name: "Home", tag: home, count: 2 });
			expect(tree[0]!.children).toEqual([{ key: "home/calls", name: "Calls", tag: calls, count: 0, children: [] }]);
		});

		it("a child whose parent record is missing is shown at the top, never dropped", () => {
			const calls = tag("Home/Calls");
			expect(tagTree([calls], new Map()).map((n) => [n.key, n.name, n.tag])).toEqual([["home/calls", "Calls", calls]]);
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
});

describe("a tag by its own name", () => {
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
});

// A new tag key has at most one "/", so a tag has at most one parent level.

describe("hasAllowedTagDepth", () => {
	it("allows keys with no slash or one slash", () => {
		expect(hasAllowedTagDepth("work")).toBe(true);
		expect(hasAllowedTagDepth("work/calls")).toBe(true);
	});

	it("refuses keys with two or more slashes", () => {
		expect(hasAllowedTagDepth("a/b/c")).toBe(false);
		expect(hasAllowedTagDepth("a/b/c/d")).toBe(false);
	});

	it("counts slash characters, so empty segments count too", () => {
		expect(hasAllowedTagDepth("a//b")).toBe(false);
		expect(hasAllowedTagDepth("//")).toBe(false);
		expect(hasAllowedTagDepth("/a/")).toBe(false);
		expect(hasAllowedTagDepth("/a")).toBe(true);
		expect(hasAllowedTagDepth("a/")).toBe(true);
	});
});

describe("requireTagDepth", () => {
	it("passes an allowed key and throws InvalidTag with the user message for a deeper one", () => {
		expect(() => requireTagDepth("a/b")).not.toThrow();
		let caught: unknown;
		try {
			requireTagDepth("a/b/c");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(DomainError);
		expect((caught as DomainError).code).toBe("InvalidTag");
		expect((caught as DomainError).message).toBe(TAG_DEPTH_MESSAGE);
		expect(TAG_DEPTH_MESSAGE).toBe("Tags can be nested one level deep, like work/calls.");
	});
});

describe("unique tag names", () => {
	// A tag name (the last segment of its key) is used once, whatever its parent. Existing duplicates
	// still load; the later one does not sync with TickTick.

	const tag = (key: string, displayName: string, createdAt = "2026-10-01T10:00:00Z"): Tag => ({ key, displayName, color: null, createdAt, modifiedAt: createdAt });
	const map = (...tags: Tag[]) => new Map(tags.map((t) => [t.key, t]));
	/** The existing tag whose name a new key would repeat, among tags with these keys. */
	const clash = (keys: string[], key: string) => TagNames.of(keys.map((k) => ({ key: k }))).clash(key);

	describe("tag names", () => {
		it("the leaf is the last path segment", () => {
			expect(tagLeaf("home/calls")).toBe("calls");
			expect(tagLeaf("calls")).toBe("calls");
			expect(tagLeaf("a//b")).toBe("a//b");
		});

		it("a new key clashes with a tag of the same name under another parent, or at the root", () => {
			expect(clash(["home/calls"], "calls")).toBe("home/calls");
			expect(clash(["home/calls"], "work/calls")).toBe("home/calls");
			expect(clash(["calls"], "work/calls")).toBe("calls");
		});

		it("a parent tag is a name too", () => {
			expect(clash(["home", "home/calls"], "work/home")).toBe("home");
			// The parent itself is no clash, and may get more children.
			expect(clash(["home", "home/calls"], "home")).toBeNull();
			expect(clash(["home", "home/calls"], "home/garden")).toBeNull();
		});

		it("a name is the record's own: a parent's name exists only with its record", () => {
			const names = TagNames.of([tag("home/calls", "Home/Calls")]);
			expect(names.has("home/calls")).toBe(true);
			expect(names.has("home")).toBe(false);
			expect(names.owner("home")).toBeUndefined();
			expect(names.owner("calls")).toBe("home/calls");
		});

		it("a new parent segment that repeats a name clashes", () => {
			expect(clash(["work/home"], "home/calls")).toBe("work/home");
		});

		it("the same key, and unrelated names, do not clash", () => {
			expect(clash(["home/calls"], "home/calls")).toBeNull();
			expect(clash(["home/calls"], "callsx")).toBeNull();
		});

		it("names compare case-insensitively (keys are lowercase)", () => {
			const tags = map(tag("home/calls", "Home/Calls"));
			expect(() => requireUniqueTagName(tags, "calls")).toThrow(DomainError);
		});

		it("the message names the existing tag by its own name, in its own casing", () => {
			const tags = map(tag("home", "Home"), tag("home/calls", "Home/Calls"), tag("errands", "Errands"));
			expect(tagNameClashMessage(tags, "home/calls")).toBe('The name "Calls" is already used by another tag.');
			expect(tagNameClashMessage(tags, "errands")).toBe('The name "Errands" is already used by another tag.');
			expect(tagNameClashMessage(tags, "home")).toBe('The name "Home" is already used by another tag.');
			// No record: the key's last segment.
			expect(tagNameClashMessage(tags, "gone/phone")).toBe('The name "phone" is already used by another tag.');
			expect(() => requireUniqueTagName(tags, "work/errands")).toThrow('The name "Errands" is already used by another tag.');
		});

		it("a name two older tags share is quoted as the name, not as a path", () => {
			const tags = map(tag("home/calls", "Home/Calls"), tag("work/calls", "Work/Calls"));
			expect(tagNameClashMessage(tags, "home/calls")).toBe('The name "Calls" is already used by another tag.');
		});

		it("building the message leaves no stale names for a map that is changed afterwards (a write in progress)", () => {
			const working = map(tag("home/calls", "Home/Calls"));
			tagNameClashMessage(working, "home/calls");
			// The working map of a write gets more tags after a refused create; a label read from it afterwards must see them.
			working.set("work/calls", tag("work/calls", "Work/Calls"));
			expect(tagLabel(working, "home/calls")).toBe("Home/Calls");
		});

		it("a tag owns its name by its own record's date, not its children's", () => {
			const homeCalls = tag("home/calls", "Home/Calls", "2026-01-01T00:00:00Z");
			const workHome = tag("work/home", "Work/Home", "2026-02-01T00:00:00Z");
			// A parent with no record is no name.
			expect(TagNames.of([homeCalls, workHome]).owner("home")).toBe("work/home");
			// A parent record made later than a duplicate does not own the name, so its children do not sync.
			const home = tag("home", "Home", "2026-03-01T00:00:00Z");
			expect(TagNames.of([homeCalls, workHome, home]).owner("home")).toBe("work/home");
			expect(isSyncedTag(TagNames.of([homeCalls, workHome, home]), "home/calls")).toBe(false);
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
			expect(names.owner("home")).toBeUndefined();
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
				tag("home", "Home", "2026-10-01T00:00:00Z"),
				tag("work", "Work", "2026-10-01T00:00:00Z"),
				tag("x", "X", "2026-10-01T00:00:00Z"),
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
			expect(syncedTagLeaves(names, ["plain", "work/calls", "home/calls", "plain"])).toEqual(["calls", "plain"]);
		});

		it("a pulled name is pullable when it is new or its owner syncs", () => {
			const names = TagNames.of([tag("a", "A"), tag("a/b", "A/B"), tag("a/b/c", "A/B/C"), tag("home", "Home"), tag("home/calls", "Home/Calls")]);
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
});

describe("the tag name check", () => {
	// The one name check of the New tag and Edit tag dialogs:
	// the typed text first, in a fixed order, then a name already in use. Edit allows the tag's own name.

	const tag = (key: string, displayName: string, createdAt = "2026-10-01T10:00:00Z"): Tag => ({ key, displayName, color: null, createdAt, modifiedAt: createdAt });
	const map = (...tags: Tag[]) => new Map(tags.map((t) => [t.key, t]));

	const SPACES = "Use one word: spaces are not allowed. Try a hyphen, like phone-calls.";
	const SLASH = 'Pick a parent below instead of typing "/".';
	const AT = 'Leave out the "@"; it is added for you.';
	const CHARS = "Only letters, digits, hyphens (-) and underscores (_) are allowed.";

	describe("tagNameTextProblem", () => {
		it("checks in order: empty, spaces, slash, @, characters, length", () => {
			expect(tagNameTextProblem("")).toBe("Enter a name.");
			expect(tagNameTextProblem("   ")).toBe("Enter a name.");
			expect(tagNameTextProblem("phone calls")).toBe(SPACES);
			expect(tagNameTextProblem("a b/c")).toBe(SPACES);
			expect(tagNameTextProblem("home/calls")).toBe(SLASH);
			expect(tagNameTextProblem("@calls")).toBe(AT);
			expect(tagNameTextProblem("@a/b")).toBe(SLASH);
			expect(tagNameTextProblem("a$b")).toBe(CHARS);
			expect(tagNameTextProblem("x".repeat(TAG_NAME_MAX + 1))).toBe(TAG_LENGTH_MESSAGE);
		});

		it("accepts letters, digits, - and _, trimmed, up to 64 characters", () => {
			expect(TAG_NAME_MAX).toBe(64);
			expect(TAG_LENGTH_MESSAGE).toBe("Use at most 64 characters.");
			expect(tagNameTextProblem("  Phone-calls_2  ")).toBeNull();
			expect(tagNameTextProblem("Überweisung")).toBeNull();
			expect(tagNameTextProblem("x".repeat(TAG_NAME_MAX))).toBeNull();
		});

		it("with a path allowed, a slash is fine and each segment is held to 64", () => {
			expect(tagNameTextProblem("home/calls", true)).toBeNull();
			expect(tagNameTextProblem(`home/${"x".repeat(65)}`, true)).toBe(TAG_LENGTH_MESSAGE);
			expect(tagNameTextProblem(`${"x".repeat(64)}/${"y".repeat(64)}`, true)).toBeNull();
			expect(tagNameTextProblem("a$b", true)).toBe(CHARS);
		});
	});

	describe("TagNames.tooLong and tagNameRefusal", () => {
		const long = "x".repeat(65);

		it("a new segment over 64 characters is too long; an existing tag keeps any length", () => {
			const names = TagNames.of([{ key: long }, { key: `${long}/calls` }]);
			expect(names.tooLong(long)).toBe(false);
			expect(names.tooLong(`${long}/home`)).toBe(false);
			expect(names.tooLong(`home/${long}`)).toBe(true);
			expect(names.tooLong("y".repeat(65))).toBe(true);
			expect(names.tooLong("y".repeat(64))).toBe(false);
		});

		it("refusal order: repeated name, then length, then a name in use", () => {
			const tags = map(tag("calls", "Calls"));
			expect(tagNameRefusal(tags, "calls/calls")).toBe(TAG_REPEAT_MESSAGE);
			expect(tagNameRefusal(tags, long)).toBe(TAG_LENGTH_MESSAGE);
			expect(tagNameRefusal(tags, "work/calls")).toBe('The name "Calls" is already used by another tag.');
			expect(() => requireUniqueTagName(tags, `work/${long}`)).toThrow(DomainError);
		});
	});

	describe("newTagProblem: New tag", () => {
		const tags = map(tag("home", "Home"), tag("home/calls", "Home/Calls"), tag("errands", "Errands"));

		it("text problems come first", () => {
			expect(newTagProblem(tags, "", null)).toBe("Enter a name.");
			expect(newTagProblem(tags, "a b", "home")).toBe(SPACES);
			expect(newTagProblem(tags, "a/b", null)).toBe(SLASH);
		});

		it("an existing tag at the key is a name in use", () => {
			expect(newTagProblem(tags, "errands", null)).toBe('The name "Errands" is already used by another tag.');
			expect(newTagProblem(tags, "ERRANDS", null)).toBe('The name "Errands" is already used by another tag.');
			expect(newTagProblem(tags, "home", null)).toBe('The name "Home" is already used by another tag.');
			expect(newTagProblem(tags, "calls", "home")).toBe('The name "Calls" is already used by another tag.');
		});

		it("a name used under another parent, or the parent's own name, is refused", () => {
			expect(newTagProblem(tags, "Calls", null)).toBe('The name "Calls" is already used by another tag.');
			expect(newTagProblem(tags, "calls", "errands")).toBe('The name "Calls" is already used by another tag.');
			expect(newTagProblem(tags, "home", "home")).toBe(TAG_REPEAT_MESSAGE);
		});

		it("a free name is fine at the top or under a top-level tag", () => {
			expect(newTagProblem(tags, "Garden", null)).toBeNull();
			expect(newTagProblem(tags, "Garden", "home")).toBeNull();
			expect(newTagProblem(tags, "Shop", "errands")).toBeNull();
		});
	});

	describe("newTagProblem: Edit tag (the tag and its children are left out)", () => {
		const tags = map(
			tag("home", "Home"),
			tag("home/calls", "Home/Calls"),
			tag("home/garden", "Home/Garden"),
			tag("errands", "Errands"),
			tag("work", "Work"),
			tag("work/desk", "Work/Desk"),
		);

		it("the tag's own name is allowed, in any casing", () => {
			expect(newTagProblem(tags, "home", null, "home")).toBeNull();
			expect(newTagProblem(tags, "HOME", null, "home")).toBeNull();
			expect(newTagProblem(tags, "Calls", "home", "home/calls")).toBeNull();
		});

		it("a child moved to the top or under another parent keeps its own name", () => {
			expect(newTagProblem(tags, "Calls", null, "home/calls")).toBeNull();
			expect(newTagProblem(tags, "Calls", "errands", "home/calls")).toBeNull();
			expect(newTagProblem(tags, "Calls", "work", "home/calls")).toBeNull();
		});

		it("another tag's name, a parent's name, or a child's name is refused", () => {
			expect(newTagProblem(tags, "Errands", null, "home")).toBe('The name "Errands" is already used by another tag.');
			expect(newTagProblem(tags, "work", null, "errands")).toBe('The name "Work" is already used by another tag.');
			expect(newTagProblem(tags, "desk", null, "errands")).toBe('The name "Desk" is already used by another tag.');
			// Renaming the parent to a child's name would put two "calls" in the tree.
			expect(newTagProblem(tags, "Calls", null, "home")).toBe('The name "Calls" is already used by another tag.');
			expect(newTagProblem(tags, "garden", null, "home/calls")).toBe('The name "Garden" is already used by another tag.');
		});

		it("text rules apply to a changed name; an unchanged stored name is never refused", () => {
			expect(newTagProblem(tags, "", null, "home")).toBe("Enter a name.");
			expect(newTagProblem(tags, "a b", null, "home")).toBe(SPACES);
			const long = "x".repeat(70);
			const legacy = map(tag(long, long.toUpperCase()), tag("a//b", "A//B"));
			expect(newTagProblem(legacy, long.toUpperCase(), null, long)).toBeNull();
			expect(newTagProblem(legacy, `${long}y`, null, long)).toBe(TAG_LENGTH_MESSAGE);
			expect(newTagProblem(legacy, "A//B", null, "a//b")).toBeNull();
		});

		it("an older duplicate keeps its name and place, but cannot move to a name the other one has", () => {
			const dup = map(tag("home/calls", "Home/Calls", "2026-01-01T00:00:00Z"), tag("work/calls", "Work/Calls", "2026-02-01T00:00:00Z"));
			expect(newTagProblem(dup, "CALLS", "work", "work/calls")).toBeNull();
			expect(newTagProblem(dup, "calls", null, "work/calls")).toBe('The name "Calls" is already used by another tag.');
		});

		it("a name repeating its new parent's is refused", () => {
			expect(newTagProblem(tags, "errands", "errands", "home/calls")).toBe(TAG_REPEAT_MESSAGE);
		});
	});
});
