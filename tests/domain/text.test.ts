import { describe, expect, it } from "vitest";
import { capitalize, clamp, collapseWhitespace, normalizedText, plural, unixLineEnds } from "../../src/domain/text";

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

	it("normalizedText is NFC with the ends trimmed; unixLineEnds turns every line ending into \\n", () => {
		expect(normalizedText("  Café \n")).toBe("Café");
		expect(unixLineEnds("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
	});

	it("capitalize upper-cases the first letter only", () => {
		expect(capitalize("high")).toBe("High");
		expect(capitalize("")).toBe("");
	});

	it.each([
		["a value inside the range stays", 5, 0, 10, 5],
		["below the range is the low end", -3, 0, 10, 0],
		["above the range is the high end", 12, 0, 10, 10],
		["an empty range (high below low) is the low end", 4, 0, -1, 0],
	])("clamp: %s", (_name, n, lo, hi, out) => {
		expect(clamp(n, lo, hi)).toBe(out);
	});
});
