import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors";
import { TAG_DEPTH_MESSAGE, hasAllowedTagDepth, requireTagDepth } from "../../src/domain/tags";

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
