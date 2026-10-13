import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import { makeCtx } from "../parsing/helpers";
import { perfLog, timeBoth } from "./measure";

// Repeating tasks rule 19 (#12): the run of repeat words after each `every` or `each` is read once, so a long run of
// lead words (`every every …`, `every other …`) parses in time that grows with the text, not with its square; so does a
// long run of repeat phrases (`on mondays …`), each checked once against the ones found before it.
//
// Four times the text takes about four times as long; with the square it would take sixteen times as long.
const GROWTH = 8;
// A flat allowance for timer noise on a fast short run.
const NOISE_MS = 2;

const long = (unit: string, n: number): string => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

describe("Quick Add on long runs of repeat lead words (#12)", () => {
	it.each(["every every ", "every other ", "each each ", "each other ", "every day and every every ", "on mondays ", "the 15th of each month "])(
		"%j at 20,000 characters takes well under 16 times as long as at 5,000",
		(unit) => {
			const ctx = makeCtx();
			const short = long(unit, 5000);
			const longer = long(unit, 20000);
			const { small, large } = timeBoth(() => parseQuickAdd(short, ctx), () => parseQuickAdd(longer, ctx));
			const report = `${small.toFixed(2)} ms -> ${large.toFixed(2)} ms`;
			perfLog(`quick add ${JSON.stringify(unit)} 5,000 -> 20,000 characters: ${report}`);
			expect(large, report).toBeLessThan(small * GROWTH + NOISE_MS);
		},
	);
});
