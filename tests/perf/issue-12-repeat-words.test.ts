import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import { makeCtx } from "../parsing/helpers";

// Repeating tasks rule 19 (#12): the run of repeat words after each `every` or `each` is read once, so a long run of
// lead words (`every every …`, `every other …`) parses in time that grows with the text, not with its square.

// Same allowance as the other perf tests: CI runners are two to three times slower.
const CI_SLACK = process.env.CI ? 4 : 1;
const BUDGET_MS = 25 * CI_SLACK;

const long = (unit: string, n: number): string => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

function median(input: string): number {
	const ctx = makeCtx();
	parseQuickAdd(input, ctx);
	const times: number[] = [];
	for (let i = 0; i < 5; i++) {
		const started = performance.now();
		parseQuickAdd(input, ctx);
		times.push(performance.now() - started);
	}
	return times.sort((a, b) => a - b)[2]!;
}

describe("Quick Add on long runs of repeat lead words (#12)", () => {
	it.each(["every every ", "every other ", "each each ", "each other ", "every day and every every "])("%j at 5,000 and 20,000 characters", (unit) => {
		for (const n of [5000, 20000]) expect(median(long(unit, n)), `${n}`).toBeLessThan(BUDGET_MS);
	});
});
