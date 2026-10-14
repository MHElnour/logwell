import { describe, expect, it } from "vitest";
import { rebaseDecisions, tokenAtCursor } from "../../src/parsing";
import type { SpanDecision } from "../../src/parsing/types";
import { CATEGORIES, parse } from "./helpers";

const lit = (input: string, word: string, nth = 0): SpanDecision => {
	let from = -1;
	for (let i = 0; i <= nth; i++) from = input.indexOf(word, from + 1);
	return { span: { start: from, end: from + word.length }, text: word, kind: "literal" };
};

// The plain decisions (a literal, a literal next to a time, text that no longer matches, accepting a manual-field
// replacement) are rows of golden.test.ts.
describe("decisions apply while the text matches", () => {
	it("a decision with a span outside the input is ignored", () => {
		const d: SpanDecision = { span: { start: 40, end: 48 }, text: "tomorrow", kind: "literal" };
		expect(() => parse("tomorrow", { decisions: [d] })).not.toThrow();
		expect(parse("tomorrow", { decisions: [d] }).chips).toHaveLength(1);
	});

	it("a literal on part of a chrono span splits it", () => {
		const input = "x tomorrow at 7pm";
		const r = parse(input, { decisions: [{ span: { start: 11, end: 13 }, text: "at", kind: "literal" }] });
		// "at" stays plain text; chrono now sees "tomorrow" and "7pm" as two separate results.
		expect(r.chips.map((c) => c.text)).toEqual(["tomorrow", "7pm"]);
		expect(r.chips.map((c) => c.status)).toEqual(["superseded", "applied"]);
		expect(r.title).toBe("x tomorrow at");
	});

	it("a literal inside a token span blocks the token", () => {
		const input = "x #Study";
		const r = parse(input, { decisions: [{ span: { start: 3, end: 5 }, text: "St", kind: "literal" }] });
		expect(r.chips.map((c) => c.kind)).not.toContain("category");
		expect(r.fields.categoryId).toBeUndefined();
	});

	it("a literal on a note link keeps its text from chrono", () => {
		const input = "x [[Big]] tomorrow";
		const r = parse(input, { decisions: [lit(input, "[[Big]]")] });
		expect(r.chips.map((c) => c.text)).toEqual(["tomorrow"]);
		expect(r.fields.notePath).toBeUndefined();
	});

	it("a literal span of a suggestion removes its chip", () => {
		const input = "Sun cream";
		expect(parse(input, { decisions: [lit(input, "Sun")] }).chips).toEqual([]);
	});

	it("a bound category decision defines a token span that contains a space", () => {
		const input = "Read #Deep work now";
		const d: SpanDecision = { span: { start: 5, end: 15 }, text: "#Deep work", kind: "category", categoryId: CATEGORIES[2]?.id ?? "" };
		const r = parse(input, { decisions: [d] });
		expect(r.fields.categoryId).toBe("cat-deepwork-0003");
		expect(r.chips.map((c) => c.text)).toEqual(["#Deep work", "now"]);
		expect(r.chips[1]?.status).toBe("suggestion");
		expect(r.title).toBe("Read now");
	});

	it("a bound tag and note decision apply to their span", () => {
		const input = "x @my tag [[some note]]";
		const r = parse(input, {
		decisions: [
			{ span: { start: 2, end: 9 }, text: "@my tag", kind: "tag", key: "learning" },
			{ span: { start: 10, end: 23 }, text: "[[some note]]", kind: "note", path: "Notes/Some note.md" },
		],
		});
		expect(r.fields.tagKeys).toEqual(["learning"]);
		expect(r.fields.notePath).toBe("Notes/Some note.md");
		expect(r.title).toBe("x");
	});

	it("a bound decision beats natural detection, and the later of two on one span wins", () => {
		const input = "x #Foo";
		const d1: SpanDecision = { span: { start: 2, end: 6 }, text: "#Foo", kind: "category", categoryId: "cat-study-0002" };
		const d2: SpanDecision = { span: { start: 2, end: 6 }, text: "#Foo", kind: "category", categoryId: "cat-health-0004" };
		expect(parse(input, { decisions: [d1, d2] }).fields.categoryId).toBe("cat-health-0004");
	});

	it("a literal overrides a bound decision that overlaps it", () => {
		const input = "x #Foo";
		const bound: SpanDecision = { span: { start: 2, end: 6 }, text: "#Foo", kind: "category", categoryId: "cat-study-0002" };
		const r = parse(input, { decisions: [bound, lit(input, "#Foo")] });
		expect(r.chips).toEqual([]);
	});

	it("an accept decision on a chip that needs no acceptance changes nothing", () => {
		const input = "Call friday";
		const d: SpanDecision = { span: { start: 5, end: 11 }, text: "friday", kind: "accept" };
		expect(parse(input, { decisions: [d] }).chips[0]?.status).toBe("applied");
	});

	it("an invalid date decision value is ignored", () => {
		const input = "Run at 5";
		const d = { span: { start: 4, end: 8 }, text: "at 5", kind: "date", value: { kind: "date", date: "nope" } } as SpanDecision;
		expect(parse(input, { decisions: [d] }).chips[0]?.status).toBe("choice");
	});
});

describe("rebaseDecisions", () => {
	const d = (start: number, end: number, text: string): SpanDecision => ({ span: { start, end }, text, kind: "literal" });

	it("keeps decisions entirely before the edit", () => {
		const out = rebaseDecisions("tomorrow xyz", "tomorrow xyzw", [d(0, 8, "tomorrow")]);
		expect(out).toEqual([d(0, 8, "tomorrow")]);
	});

	it("shifts decisions entirely after the edit by the length delta", () => {
		const prev = "Buy milk tomorrow";
		const next = "Please buy milk tomorrow";
		const out = rebaseDecisions(prev, next, [d(9, 17, "tomorrow")]);
		expect(out).toEqual([d(16, 24, "tomorrow")]);
		expect(next.slice(16, 24)).toBe("tomorrow");
	});

	it("shifts left after a deletion", () => {
		const out = rebaseDecisions("Please buy milk tomorrow", "Buy milk tomorrow", [d(16, 24, "tomorrow")]);
		expect(out).toEqual([d(9, 17, "tomorrow")]);
	});

	it.each([
		["the edit is inside of", "tomorrow", "tomxorrow", 0],
		["the edit overlaps at its start", "ab tomorrow", "abXY omorrow", 3],
		["the edit overlaps at its end", "tomorrow ab", "tomorroXY ab", 0],
		["the edit removes", "a tomorrow b", "a  b", 2],
		["the edit replaces", "a tomorrow b", "a today b", 2],
		["a letter is typed directly after", "tomorrow", "tomorrowx", 0],
		["a letter is typed directly before", "tomorrow", "xtomorrow", 0],
	])("drops a decision %s", (_name, before, after, start) => {
		expect(rebaseDecisions(before, after, [d(start, start + 8, "tomorrow")])).toEqual([]);
	});

	it("keeps a literal when a space is typed after it so the dismissal survives further typing", () => {
		expect(rebaseDecisions("tomorrow", "tomorrow ", [d(0, 8, "tomorrow")])).toEqual([d(0, 8, "tomorrow")]);
	});

	it("keeps a literal when a space is typed before it", () => {
		expect(rebaseDecisions("tomorrow", " tomorrow", [d(0, 8, "tomorrow")])).toEqual([d(1, 9, "tomorrow")]);
	});

	it("handles several decisions around one edit", () => {
		const prev = "aaa tomorrow bbb friday";
		const next = "aaa tomorrow BBBB friday";
		const out = rebaseDecisions(prev, next, [d(4, 12, "tomorrow"), d(13, 16, "bbb"), d(17, 23, "friday")]);
		expect(out).toEqual([d(4, 12, "tomorrow"), d(18, 24, "friday")]);
	});

	it("keeps the decision payload and does not mutate its input", () => {
		const cat: SpanDecision = { span: { start: 9, end: 13 }, text: "#Foo", kind: "category", categoryId: "c1" };
		const out = rebaseDecisions("Buy milk #Foo", "Please buy milk #Foo", [cat]);
		expect(out).toEqual([{ span: { start: 16, end: 20 }, text: "#Foo", kind: "category", categoryId: "c1" }]);
		expect(cat.span).toEqual({ start: 9, end: 13 });
	});

	it("works with surrogate pairs in the edit", () => {
		const out = rebaseDecisions("a tomorrow", "😀 a tomorrow", [d(2, 10, "tomorrow")]);
		expect(out).toEqual([d(5, 13, "tomorrow")]);
	});
});

describe("tokenAtCursor", () => {
	it("finds a category token ending at the cursor", () => {
		expect(tokenAtCursor("#Stu", 4)).toEqual({ kind: "category", span: { start: 0, end: 4 }, query: "Stu" });
	});

	it("finds a tag token", () => {
		expect(tokenAtCursor("Read @lea more", 9)).toEqual({ kind: "tag", span: { start: 5, end: 9 }, query: "lea" });
	});

	it("covers the whole token when the cursor is inside it, with the query up to the cursor", () => {
		expect(tokenAtCursor("#Study", 3)).toEqual({ kind: "category", span: { start: 0, end: 6 }, query: "St" });
	});

	it("#69: an opening parenthesis before the trigger starts a token", () => {
		expect(tokenAtCursor("Read (#Wo", 9)).toEqual({ kind: "category", span: { start: 6, end: 9 }, query: "Wo" });
		expect(tokenAtCursor("Read (@ho", 9)).toEqual({ kind: "tag", span: { start: 6, end: 9 }, query: "ho" });
	});

	it("gives an empty query right after the trigger", () => {
		expect(tokenAtCursor("x #", 3)).toEqual({ kind: "category", span: { start: 2, end: 3 }, query: "" });
		expect(tokenAtCursor("x @", 3)).toEqual({ kind: "tag", span: { start: 2, end: 3 }, query: "" });
	});

	it("finds an unclosed note link", () => {
		expect(tokenAtCursor("[[Pla", 5)).toEqual({ kind: "note", span: { start: 0, end: 5 }, query: "Pla" });
		expect(tokenAtCursor("x [[", 4)).toEqual({ kind: "note", span: { start: 2, end: 4 }, query: "" });
	});

	it("keeps spaces and # in a note query", () => {
		expect(tokenAtCursor("[[My note #1", 12)).toEqual({ kind: "note", span: { start: 0, end: 12 }, query: "My note #1" });
	});

	it("finds a closed note link while the cursor is inside it (before its closing brackets end)", () => {
		expect(tokenAtCursor("[[Plan]] x", 4)).toEqual({ kind: "note", span: { start: 0, end: 8 }, query: "Pl" });
		expect(tokenAtCursor("[[Plan]] x", 6)).toEqual({ kind: "note", span: { start: 0, end: 8 }, query: "Plan" });
		expect(tokenAtCursor("[[Plan]] x", 7)).toEqual({ kind: "note", span: { start: 0, end: 8 }, query: "Plan" });
	});

	it("no token when the cursor is at or after the end of a closed note link", () => {
		expect(tokenAtCursor("Draft [[Roadmap]]", 17)).toBeNull();
		expect(tokenAtCursor("[[Plan]] x", 8)).toBeNull();
		expect(tokenAtCursor("[[Plan]] x", 9)).toBeNull();
	});

	it("returns null away from any token", () => {
		expect(tokenAtCursor("hello world", 5)).toBeNull();
		expect(tokenAtCursor("#Study now", 8)).toBeNull();
		expect(tokenAtCursor("[[Plan]] x", 10)).toBeNull();
		expect(tokenAtCursor("[[a", 1)).toBeNull();
		expect(tokenAtCursor("", 0)).toBeNull();
	});

	it("returns null for a trigger that is not at a boundary", () => {
		expect(tokenAtCursor("a@b.com", 7)).toBeNull();
		expect(tokenAtCursor("a@b", 3)).toBeNull();
		expect(tokenAtCursor("C#", 2)).toBeNull();
	});

	it("returns null when the cursor is before the trigger", () => {
		expect(tokenAtCursor("x #Study", 2)).toBeNull();
	});

	it("handles the second of two note links", () => {
		expect(tokenAtCursor("[[a]] [[b", 9)).toEqual({ kind: "note", span: { start: 6, end: 9 }, query: "b" });
	});

	it("handles non-latin letters", () => {
		expect(tokenAtCursor("#学习", 3)).toEqual({ kind: "category", span: { start: 0, end: 3 }, query: "学习" });
	});

	it("clamps an out-of-range cursor", () => {
		expect(tokenAtCursor("#ab", 99)).toEqual({ kind: "category", span: { start: 0, end: 3 }, query: "ab" });
		expect(tokenAtCursor("#ab", -4)).toBeNull();
	});
});

describe("bound tag decisions and unresolved categories", () => {
	it("a bound tag decision whose tag no longer exists is dropped; the span is re-recognized as a new tag", () => {
		const input = "x @Gone";
		const d: SpanDecision = { span: { start: 2, end: 7 }, text: "@Gone", kind: "tag", key: "gone" };
		const r = parse(input, { decisions: [d] });
		expect(r.chips).toHaveLength(1);
		expect(r.chips[0]).toMatchObject({ kind: "tag", status: "applied", newTag: true, tagKey: "gone" });
		expect(r.fields.tagKeys).toEqual([]);
		expect(r.fields.newTags).toEqual(["Gone"]);
	});

	it("a bound tag decision whose key exists (any casing) still applies", () => {
		const input = "x @my tag";
		const d: SpanDecision = { span: { start: 2, end: 9 }, text: "@my tag", kind: "tag", key: "Learning" };
		expect(parse(input, { decisions: [d] }).fields.tagKeys).toEqual(["Learning"]);
	});

	it("an unresolved category followed by a later applied category is superseded and does not block", () => {
		const r = parse("Read #Hobbies #Study", { decisions: [] });
		expect(r.chips.map((c) => c.status)).toEqual(["superseded", "applied"]);
		expect(r.chips[0]!.notice).toBe("Replaced by a later value");
		expect(r.blocking).toEqual([]);
		expect(r.fields.categoryId).toBe("cat-study-0002");
		expect(r.title).toBe("Read #Hobbies");
	});

	it("an unresolved category after an applied one still blocks", () => {
		const r = parse("Read #Study #Hobbies", { decisions: [] });
		expect(r.chips.map((c) => c.status)).toEqual(["applied", "unresolved"]);
		expect(r.blocking).toHaveLength(1);
	});
});
