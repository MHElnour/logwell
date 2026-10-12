import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MERGE_MARKER, diffLines, mergeLines, mergeText, textLines } from "../../src/domain/textMerge";

// The three-way merge of a sync-created description note against the last-synced text.

const L = (s: string) => (s === "" ? [] : s.split("|"));

function apply(a: string[], b: string[]): string[] {
	const out: string[] = [];
	let pos = 0;
	for (const h of diffLines(a, b)) {
		out.push(...a.slice(pos, h.aStart), ...b.slice(h.bStart, h.bEnd));
		pos = h.aEnd;
	}
	return [...out, ...a.slice(pos)];
}

describe("diffLines", () => {
	it("finds no hunk for equal texts", () => {
		expect(diffLines(L("a|b"), L("a|b"))).toEqual([]);
	});

	it("finds a changed, an added and a removed line", () => {
		expect(diffLines(L("a|b|c"), L("a|B|c"))).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]);
		expect(diffLines(L("a|c"), L("a|b|c"))).toEqual([{ aStart: 1, aEnd: 1, bStart: 1, bEnd: 2 }]);
		expect(diffLines(L("a|b|c"), L("a|c"))).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 }]);
	});

	it("turns any text into any other (property)", () => {
		const text = fc.array(fc.constantFrom("a", "b", "c", "", "d"), { maxLength: 12 });
		fc.assert(fc.property(text, text, (a, b) => {
			expect(apply(a, b)).toEqual(b);
		}));
	});
});

describe("mergeLines (D30)", () => {
	it("one side changed: that side wins", () => {
		expect(mergeLines(L("a|b"), L("a|b"), L("a|B"))).toEqual(L("a|B"));
		expect(mergeLines(L("a|b"), L("a|X"), L("a|b"))).toEqual(L("a|X"));
	});

	it("both sides made the same change: taken once", () => {
		expect(mergeLines(L("a|b"), L("a|B|c"), L("a|B|c"))).toEqual(L("a|B|c"));
	});

	it("changes to different lines both apply", () => {
		expect(mergeLines(L("a|b|c|d"), L("A|b|c|d"), L("a|b|c|D"))).toEqual(L("A|b|c|D"));
		// Next to each other is not overlapping.
		expect(mergeLines(L("a|b|c"), L("a|B|c"), L("a|b|C"))).toEqual(L("a|B|C"));
		// An insertion on one side and a change on the other.
		expect(mergeLines(L("a|b|c"), L("a|x|b|c"), L("a|b|C"))).toEqual(L("a|x|b|C"));
	});

	it("an overlapping change keeps Logwell's lines, then the marker, then TickTick's", () => {
		expect(mergeLines(L("a|b|c"), L("a|mine|c"), L("a|theirs|c"))).toEqual(["a", "mine", MERGE_MARKER, "theirs", "c"]);
		expect(MERGE_MARKER).toBe("From TickTick:");
	});

	it("both sides insert at the same place: an overlap", () => {
		expect(mergeLines(L("a|c"), L("a|x|c"), L("a|y|c"))).toEqual(["a", "x", MERGE_MARKER, "y", "c"]);
	});

	it("a deletion on one side and a change on the other keeps the change after the marker", () => {
		expect(mergeLines(L("a|b|c"), L("a|c"), L("a|B|c"))).toEqual(["a", MERGE_MARKER, "B", "c"]);
	});

	it("an empty base: both texts, Logwell's first", () => {
		expect(mergeLines([], L("mine"), L("theirs"))).toEqual(["mine", MERGE_MARKER, "theirs"]);
		expect(mergeLines([], [], L("theirs"))).toEqual(L("theirs"));
	});

	it("merging again over a merge whose base was not saved does not mark twice", () => {
		const base = L("a|b|c");
		const theirs = L("a|theirs|c");
		const once = mergeLines(base, L("a|mine|c"), theirs);
		expect(mergeLines(base, once, theirs)).toEqual(once);
	});

	it("an insertion that extends the other side's is taken whole, not marked (L4)", () => {
		expect(mergeLines(L("A"), L("A|B"), L("A|B|C"))).toEqual(L("A|B|C"));
		expect(mergeLines(L("A"), L("A|B|C"), L("A|B"))).toEqual(L("A|B|C"));
		// Only the differing middle is marked.
		expect(mergeLines(L("A"), L("A|B|x|D"), L("A|B|y|D"))).toEqual(["A", "B", "x", MERGE_MARKER, "y", "D"]);
	});

	it("merging again over any earlier merge whose base was not saved gives the same text (reviewer probe)", () => {
		const cases: [string, string, string][] = [
			["A\nB\nC\nD\nE", "A\nB1\nC\nD1\nE", "A\nB2\nC\nD2\nE"],
			["A\nB\nC", "A\nX\nY", "A\nP\nC"],
			["A", "A\nB", "A\nB\nC"],
			["", "mine", "theirs"],
		];
		for (const [base, ours, theirs] of cases) {
			const once = mergeText(base, ours, theirs);
			expect(mergeText(base, once, theirs)).toBe(once);
			expect(mergeText(base, mergeText(base, once, theirs), theirs)).toBe(once);
		}
	});

	it("never loses a line of either side (property)", () => {
		const text = fc.array(fc.constantFrom("a", "b", "c", "d", ""), { maxLength: 8 });
		fc.assert(
			fc.property(text, text, text, (base, ours, theirs) => {
				const merged = mergeLines(base, ours, theirs);
				const count = (xs: string[], x: string) => xs.filter((y) => y === x).length;
				// Each line one side added (beyond the base's count) is still there.
				for (const side of [ours, theirs]) {
					for (const x of new Set(side)) expect(count(merged, x)).toBeGreaterThanOrEqual(count(side, x) - count(base, x));
				}
			}),
		);
	});
});

describe("mergeText", () => {
	it("merges with a trailing newline", () => {
		expect(mergeText("a\nb\n", "a\nB\n", "a\nb\nc\n")).toBe("a\nB\nc\n");
	});

	it("reads CRLF and writes LF", () => {
		expect(mergeText("a\r\nb", "a\r\nB", "A\nb")).toBe("A\nB");
		expect(textLines("x\r\ny\rz")).toEqual(["x", "y", "z"]);
	});

	it("identical sides give that text", () => {
		expect(mergeText("old", "new", "new")).toBe("new");
	});
});
