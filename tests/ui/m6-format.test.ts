import { describe, expect, it } from "vitest";
import { parseAmount, plusLabel } from "../../src/ui/habits/format";

// What a person may type as an amount, and the "+1" button's name.

describe("parseAmount", () => {
	it("takes digits with a point or a decimal comma and at most 6 decimals", () => {
		expect(parseAmount("10")).toBe(10);
		expect(parseAmount(" 1.5 ")).toBe(1.5);
		expect(parseAmount("1,5")).toBe(1.5);
		expect(parseAmount("2,25")).toBe(2.25);
		expect(parseAmount("0,000001")).toBe(0.000001);
		expect(parseAmount("007")).toBe(7);
		expect(parseAmount("30")).toBe(30);
		expect(parseAmount("2.5")).toBe(2.5);
		expect(parseAmount("0.5")).toBe(0.5);
		expect(parseAmount("2,5")).toBe(2.5);
		expect(parseAmount("0.25")).toBe(0.25);
	});

	it("refuses a thousands separator, exponents, prefixes, signs, zero, empty and words", () => {
		for (const bad of ["10,000", "10.000", "1,000", "1.000", "0.001", "1e3", "1E3", "0x10", "", "  ", "abc", "0", "0,0", "-3", "+3", "1.", ".5", "1,5,5", "1.5.5", "1 000", "Infinity", "NaN", "1,0000001"]) {
			expect(parseAmount(bad), JSON.stringify(bad)).toBeNull();
		}
	});

	it("a separator followed by other than exactly three digits is a decimal", () => {
		expect(parseAmount("1,50")).toBe(1.5);
		expect(parseAmount("1,5000")).toBe(1.5);
		expect(parseAmount("1.5000")).toBe(1.5);
	});
});

describe("plusLabel", () => {
	it("names the habit, whatever its unit", () => {
		expect(plusLabel("Drink water")).toBe("Add one to Drink water");
		expect(plusLabel("Push-ups")).toBe("Add one to Push-ups");
	});
});
