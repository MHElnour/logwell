import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import { readingOf } from "../../src/parsing/text";
import { makeCtx } from "../parsing/helpers";
import { perfLog, timeBoth } from "./measure";

// #12: the run of repeat words after each `every` or `each` is read once, so a long run of
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

// #69: quotes, backslashes and opening parentheses are each looked at once, so a long run of them parses in time that
// grows with the text; so do escaped phrases (each read only up to the next backslash) and the text the readers see for
// clock times after `@` and `at` (each rewritten once). A long run of times read as dates costs what the date reader
// costs for `at 4pm`.
describe("Quick Add on long runs of quotes, backslashes, parentheses and clock times (#69)", () => {
	it.each(["@4pm ", "at 0900 ", "at 0900-1000 "])("the readers' text of %j at 20,000 characters takes well under 16 times as long as at 5,000", (unit) => {
		const short = long(unit, 5000);
		const longer = long(unit, 20000);
		const free = (): boolean => true;
		const { small, large } = timeBoth(() => readingOf(short, free).toInput(5000), () => readingOf(longer, free).toInput(20000));
		const report = `${small.toFixed(2)} ms -> ${large.toFixed(2)} ms`;
		perfLog(`readers' text ${JSON.stringify(unit)} 5,000 -> 20,000 characters: ${report}`);
		expect(large, report).toBeLessThan(small * GROWTH + NOISE_MS);
	});

	it.each(['"', "\\", "(", '"a" ', "\\a ", "(#a) ", "((#a)) ", "#a) ", "\\by friday "])("%j at 20,000 characters takes well under 16 times as long as at 5,000", (unit) => {
		const ctx = makeCtx();
		const short = long(unit, 5000);
		const longer = long(unit, 20000);
		const { small, large } = timeBoth(() => parseQuickAdd(short, ctx), () => parseQuickAdd(longer, ctx));
		const report = `${small.toFixed(2)} ms -> ${large.toFixed(2)} ms`;
		perfLog(`quick add ${JSON.stringify(unit)} 5,000 -> 20,000 characters: ${report}`);
		expect(large, report).toBeLessThan(small * GROWTH + NOISE_MS);
	});
});

// #6: the readers' own date parsers look back over a few words only, a time beside a date is checked against its
// neighbours only, and each choice is checked once, so a long run of deadline words, weekdays with a day number, ends of
// a period, dates after them, closing brackets, dates and ranges parses in time that grows with the text.
describe("Quick Add on long runs of the dates' own phrases (#6)", () => {
	it.each(["due ", "due due due Friday ", "Fri 15th ", "Friday 15th ", "next Fri 16th ", "Fri 15 at 7 ", "end of week ", "EOD Friday ", "(Friday) ", "Friday) ", "Oct 20 ", "Oct 20 to Oct 25 ", "Friday until midnight "])("%j at 20,000 characters takes well under 16 times as long as at 5,000", (unit) => {
		const ctx = makeCtx();
		const short = long(unit, 5000);
		const longer = long(unit, 20000);
		const { small, large } = timeBoth(() => parseQuickAdd(short, ctx), () => parseQuickAdd(longer, ctx));
		const report = `${small.toFixed(2)} ms -> ${large.toFixed(2)} ms`;
		perfLog(`quick add ${JSON.stringify(unit)} 5,000 -> 20,000 characters: ${report}`);
		expect(large, report).toBeLessThan(small * GROWTH + NOISE_MS);
	});
});
