import { describe, expect, it } from "vitest";
import { stepFor } from "../../src/ui/focus/Controls";

// Issue 23: stepping the focus minutes down from a value that is not a multiple of 5 lands on the multiple of 5 below.

/** The value one click gives, within 1..120. */
const down = (value: number) => Math.max(1, value - stepFor(value, -1, true));
const up = (value: number) => Math.min(120, value + stepFor(value, 1, true));

describe("focus minutes stepper", () => {
	it("steps down from an odd value to the multiple of 5 below, then by 1 at or below 5", () => {
		expect(down(7)).toBe(5);
		expect(down(6)).toBe(5);
		expect(down(9)).toBe(5);
		expect(down(11)).toBe(10);
		expect(down(5)).toBe(4);
		expect(down(4)).toBe(3);
		expect(down(1)).toBe(1);
	});

	it("steps down by 5 from a multiple of 5", () => {
		expect(down(25)).toBe(20);
		expect(down(10)).toBe(5);
	});

	it("steps up as before: by 1 below 5, then by 5", () => {
		expect(up(3)).toBe(4);
		expect(up(4)).toBe(5);
		expect(up(5)).toBe(10);
		expect(up(7)).toBe(12);
	});

	it("steps by 1 on a field that is not coarse", () => {
		expect(stepFor(6, -1, false)).toBe(1);
		expect(stepFor(6, 1, false)).toBe(1);
	});
});
