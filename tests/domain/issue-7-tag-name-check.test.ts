import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import {
	TAG_LENGTH_MESSAGE,
	TAG_NAME_MAX,
	TAG_REPEAT_MESSAGE,
	TagNames,
	newTagProblem,
	requireUniqueTagName,
	tagNameRefusal,
	tagNameTextProblem,
} from "../../src/domain/tags";
import type { Tag } from "../../src/domain/types";

// The one name check of the New tag and Edit tag dialogs (Lists, sections and tags rules 21, 22, 23b, 24):
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
