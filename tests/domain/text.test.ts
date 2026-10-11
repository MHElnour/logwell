import { describe, expect, it } from "vitest";
import { collapseWhitespace, plural } from "../../src/domain/text";

describe("text helpers", () => {
	it("plural writes the count and the word, singular only for 1", () => {
		expect(plural(0, "task")).toBe("0 tasks");
		expect(plural(1, "task")).toBe("1 task");
		expect(plural(2, "task")).toBe("2 tasks");
		expect(plural(1, "check-in")).toBe("1 check-in");
		expect(plural(1, "entry", "entries")).toBe("1 entry");
		expect(plural(3, "entry", "entries")).toBe("3 entries");
	});

	it("collapseWhitespace joins runs of whitespace and trims", () => {
		expect(collapseWhitespace("  a \t b\n\nc  ")).toBe("a b c");
		expect(collapseWhitespace("   ")).toBe("");
	});
});
