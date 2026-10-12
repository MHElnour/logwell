import { describe, expect, it } from "vitest";
import { scanFor } from "../../src/parsing/text";

const readWord = (s: string) => (at: number) => {
	const m = /^for (\w+)/u.exec(s.slice(at));
	return m ? { start: at, end: at + m[0].length, word: m[1]! } : null;
};
const scan = (s: string, from = 0, taken: (a: number, b: number) => boolean = () => false) =>
	scanFor(s, from, readWord(s), (f) => f, taken).map((f) => f.word);

describe("scanFor", () => {
	it("reads every for at a word start, left to right", () => {
		expect(scan("for a, for b then for c")).toEqual(["a", "b", "c"]);
	});

	it("skips a for inside a word and one the reader rejects", () => {
		expect(scan("before x, for, forx for y")).toEqual(["y"]);
	});

	it("starts at `from` and skips a result that is taken", () => {
		expect(scan("for a for b", 3)).toEqual(["b"]);
		expect(scan("for a for b", 0, (start) => start === 0)).toEqual(["b"]);
	});

	it("resumes after a kept result, so it never reads inside it", () => {
		expect(scan("for for for x")).toEqual(["for", "x"]);
	});
});
