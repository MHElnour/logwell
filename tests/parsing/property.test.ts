import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeRepeatRule, repeatRuleProblem } from "../../src/domain/recurrence";
import { parseQuickAdd, rebaseDecisions, tokenAtCursor } from "../../src/parsing";
import { parseUnguarded } from "../../src/parsing/parse";
import type { ParseContext, ParseResult, ParsedField, SpanDecision } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, makeCtx } from "./helpers";

// Property tests (applied to the parser). The unguarded entry
// point is called directly so the top-level guard cannot hide a bug.

const FRAGMENTS = [
	"tomorrow", "friday", "Fri", "next fri", "today", "tonight", "at 5", "at 7pm", "at noon", "19:00", "by", "by Friday",
	"Oct 5", "10/5", "2026-10-05", "may", "sun", "march", "now", "in 3 days", "next week", "for 45m", "for 1h30m",
	"for 90 min", "for 0m", "for", "every", "every monday", "every mon, wed", "every 2 days", "every other week",
	"every month on the 15th", "every last friday at 9", "every day at 7pm", "every last day of the month", "every 3 months", "#Study", "#Deep work",
	"#", "@", "@home", "@new", "a@b.com", "[[Plan]]", "[[Big|x]]", "[[", "]]", "[[]]", "|", " ", "  ", "\n", "\t",
	"😀", "Café", "Cafe\u0301", "明日", "\u200b", "\u0000", "\uFFFC", "Mar 8 2:30am", "Nov 1 1:30am", "noon", "midnight",
	"!1", "!2", "!3", "!high", "!Medium", "!LOW", "!", "!!1", "!4", "Wow!", "!1x", "1h", "5", "12", "-", "_", "/", ",", ".", "at", "on", "the", "and",
];

const arbFragmentText = fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 14 }).map((a) => a.join(""));
const arbSpaced = fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 14 }).map((a) => a.join(" "));
const arbText = fc.oneof(
	{ weight: 4, arbitrary: arbFragmentText },
	{ weight: 4, arbitrary: arbSpaced },
	{ weight: 2, arbitrary: fc.string({ unit: "grapheme", maxLength: 60 }) },
	{ weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 60 }) },
);

const arbZone = fc.constantFrom(NY, BERLIN, TOKYO);
const arbNow = fc
	.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2028, 0, 1) })
	.map((ms) => new Date(ms));
const arbManual = fc.subarray<ParsedField>(["scheduled", "deadline", "duration", "category", "tags", "note", "priority", "recurrence"]);

function literalsFor(input: string, picks: readonly (readonly [number, number])[]): SpanDecision[] {
	const out: SpanDecision[] = [];
	for (const [a, b] of picks) {
		if (input.length === 0) break;
		const start = a % input.length;
		const end = Math.min(input.length, start + 1 + (b % 12));
		out.push({ span: { start, end }, text: input.slice(start, end), kind: "literal" });
	}
	return out;
}

const arbPicks = fc.array(fc.tuple(fc.nat(10000), fc.nat(10000)), { maxLength: 3 });

function ctxFrom(zone: string, now: Date, locale: "en" | "en-GB", manual: ParsedField[], decisions: SpanDecision[]): ParseContext {
	return makeCtx({ zone, now, locale, manual, decisions });
}

function applied(r: ParseResult) {
	return r.chips.filter((c) => c.status === "applied");
}

/** The title the parser owes: the segments between applied spans, a lone "," or ";" next to a removed span dropped. */
function titleSegments(input: string, r: ParseResult): string[] {
	const parts: string[] = [];
	let at0 = 0;
	for (const c of applied(r)) {
		parts.push(input.slice(at0, c.span.start));
		at0 = c.span.end;
	}
	parts.push(input.slice(at0));
	for (let i = 0; i + 1 < parts.length; i++) {
		parts[i] = parts[i]!.replace(/[,;]\s*$/u, "");
		parts[i + 1] = parts[i + 1]!.replace(/^\s*[,;]/u, "");
	}
	return parts;
}

function expectedTitle(input: string, r: ParseResult): string {
	const parts = titleSegments(input, r);
	const last = applied(r).at(-1);
	// A sentence's last punctuation after a repeat that leaves the title goes with it.
	if (parts.length > 1 && (last?.kind === "recurrence" || last?.kind === "repeatEnd") && /^[.,;:!?]+\s*$/u.test(parts.at(-1)!) && /\s$/u.test(parts.at(-2)!)) parts[parts.length - 1] = "";
	const collapsed = parts.join("").replace(/\s+/g, " ").trim();
	return collapsed === "" ? input : collapsed;
}

describe("parser properties", () => {
	it("the unguarded parser never throws", () => {
		fc.assert(
			fc.property(arbText, arbZone, arbNow, fc.constantFrom("en" as const, "en-GB" as const), arbManual, arbPicks, (input, zone, now, locale, manual, picks) => {
				const ctx = ctxFrom(zone, now, locale, manual, literalsFor(input, picks));
				expect(() => parseUnguarded(input, ctx)).not.toThrow();
			}),
			{ numRuns: 600 },
		);
	});

	it("a recurrence chip's rule is always storable (valid, normal form, the parse zone for a time)", () => {
		fc.assert(
			fc.property(arbText, arbZone, arbNow, (input, zone, now) => {
				const r = parseUnguarded(input, ctxFrom(zone, now, "en", [], []));
				for (const c of r.chips) {
					if (c.kind !== "recurrence") continue;
					if (c.status === "unsupported") expect(c.rule).toBeUndefined();
					else if (c.status === "choice") {
						// A bare hour: no rule yet, two storable readings.
						expect(c.rule).toBeUndefined();
						expect(c.alternatives).toHaveLength(2);
						for (const a of c.alternatives!) {
							expect(repeatRuleProblem(a.rule!)).toBeNull();
							expect(normalizeRepeatRule(a.rule!)).toEqual(a.rule);
							expect(a.rule!.tz).toBe(zone);
						}
					} else {
						expect(["applied", "suggestion", "superseded"]).toContain(c.status);
						expect(repeatRuleProblem(c.rule!)).toBeNull();
						expect(normalizeRepeatRule(c.rule!)).toEqual(c.rule);
						expect(c.rule!.tz).toBe(c.rule!.time === null ? null : zone);
					}
				}
			}),
			{ numRuns: 600 },
		);
	});

	it("never throws on arbitrary strings through the public entry point either", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary", maxLength: 80 }), (input) => {
				expect(() => parseQuickAdd(input, makeCtx())).not.toThrow();
			}),
			{ numRuns: 300 },
		);
	});

	it("chips are sorted, never overlap, stay in bounds and quote the input exactly", () => {
		fc.assert(
			fc.property(arbText, arbZone, arbNow, fc.constantFrom("en" as const, "en-GB" as const), arbManual, (input, zone, now, locale, manual) => {
				const r = parseUnguarded(input, ctxFrom(zone, now, locale, manual, []));
				let prevEnd = 0;
				for (const c of r.chips) {
					expect(c.span.start).toBeGreaterThanOrEqual(prevEnd);
					expect(c.span.end).toBeGreaterThan(c.span.start);
					expect(c.span.end).toBeLessThanOrEqual(input.length);
					expect(c.text).toBe(input.slice(c.span.start, c.span.end));
					expect(c.id).toBe(`${c.kind}:${c.span.start}:${c.span.end}`);
					prevEnd = c.span.end;
				}
				expect(r.input).toBe(input);
			}),
			{ numRuns: 600 },
		);
	});

	it("the title is the input without applied spans, whitespace collapsed, or the input when that is empty", () => {
		fc.assert(
			fc.property(arbText, arbZone, arbNow, arbManual, (input, zone, now, manual) => {
				const r = parseUnguarded(input, ctxFrom(zone, now, "en", manual, []));
				expect(r.title).toBe(expectedTitle(input, r));
				expect(r.titleFallback).toBe(applied(r).length > 0 && expectedTitleIsEmpty(input, r));
			}),
			{ numRuns: 600 },
		);
	});

	it("fields mirror the applied chips and blocking lists exactly the unresolved ones", () => {
		fc.assert(
			fc.property(arbText, arbZone, arbNow, arbManual, (input, zone, now, manual) => {
				const r = parseUnguarded(input, ctxFrom(zone, now, "en", manual, []));
				const a = applied(r);
				const last = (kind: string) => a.filter((c) => c.kind === kind).at(-1);
				expect(r.fields.scheduled).toEqual(last("scheduled")?.date);
				expect(r.fields.deadline).toEqual(last("deadline")?.date);
				expect(r.fields.plannedDurationMin).toBe(last("duration")?.durationMin);
				expect(r.fields.categoryId).toBe(last("category")?.categoryId);
				expect(r.fields.notePath).toBe(last("note")?.notePath);
				expect(r.fields.priority).toBe(last("priority")?.priority);
				expect(r.fields.recurrence).toBe(last("recurrence")?.rule);
				expect(new Set(r.fields.tagKeys).size).toBe(r.fields.tagKeys.length);
				expect(new Set(r.fields.newTags).size).toBe(r.fields.newTags.length);
				expect(r.blocking).toEqual(r.chips.filter((c) => c.status === "unresolved").map((c) => c.id));
				// Per field at most one applied chip.
				for (const k of ["scheduled", "deadline", "duration", "category", "note", "priority", "recurrence"]) {
					expect(a.filter((c) => c.kind === k).length).toBeLessThanOrEqual(1);
				}
				// Only applied chips may carry values into the fields; suggestions and choices never do.
				for (const c of r.chips) {
					if (c.status === "choice") expect(c.alternatives).toHaveLength(2);
					if (c.status === "superseded") expect(c.notice).toBe("Replaced by a later value");
				}
			}),
			{ numRuns: 600 },
		);
	});

	it("random literal decisions are honored: no chip overlaps a literal span", () => {
		fc.assert(
			fc.property(arbText, arbPicks, arbZone, (input, picks, zone) => {
				const decisions = literalsFor(input, picks);
				const r = parseUnguarded(input, ctxFrom(zone, at(zone, "2026-10-01T06:00"), "en", [], decisions));
				for (const d of decisions) {
					for (const c of r.chips) {
						const overlap = c.span.start < d.span.end && c.span.end > d.span.start;
						expect(overlap, `${c.id} overlaps literal ${d.span.start}-${d.span.end}`).toBe(false);
					}
				}
			}),
			{ numRuns: 800 },
		);
	});

	it("a literal span's text always survives in the title", () => {
		fc.assert(
			fc.property(arbText, arbPicks, (input, picks) => {
				const decisions = literalsFor(input, picks);
				const r = parseUnguarded(input, ctxFrom(NY, at(NY, "2026-10-01T06:00"), "en", [], decisions));
				const squash = (s: string) => s.replace(/\s+/g, "");
				for (const d of decisions) {
					const idx = squash(r.title).indexOf(squash(d.text));
					expect(idx, `literal ${JSON.stringify(d.text)} missing from ${JSON.stringify(r.title)}`).toBeGreaterThanOrEqual(0);
				}
			}),
			{ numRuns: 500 },
		);
	});

	it("is deterministic", () => {
		fc.assert(
			fc.property(arbText, arbZone, (input, zone) => {
				const ctx = ctxFrom(zone, at(zone, "2026-10-01T06:00"), "en", [], []);
				expect(parseUnguarded(input, ctx)).toEqual(parseUnguarded(input, ctx));
			}),
			{ numRuns: 200 },
		);
	});

	it("inserting a plugin token never changes the chips of unrelated words", () => {
		fc.assert(
			fc.property(fc.constantFrom("Buy milk", "Call mom", "Gym", "Café ☕"), fc.constantFrom("#Study", "@home", "[[Big]]"), (title, token) => {
				const plain = parseUnguarded(`${title} tomorrow`, makeCtx());
				const withToken = parseUnguarded(`${title} ${token} tomorrow`, makeCtx());
				expect(withToken.fields.scheduled).toEqual(plain.fields.scheduled);
				expect(withToken.title).toBe(plain.title);
			}),
		);
	});
});

function expectedTitleIsEmpty(input: string, r: ParseResult): boolean {
	return expectedTitle(input, r) === input && applied(r).length > 0 && titleSegments(input, r).join("").trim() === "";
}

describe("rebaseDecisions properties", () => {
	it("every kept decision still matches its text in the new input", () => {
		fc.assert(
			fc.property(
				fc.string({ unit: "grapheme", maxLength: 40 }),
				fc.nat(60),
				fc.nat(10),
				fc.string({ unit: "grapheme", maxLength: 6 }),
				fc.array(fc.tuple(fc.nat(60), fc.nat(8)), { maxLength: 4 }),
				(prev, at0, del, ins, picks) => {
					const start = Math.min(at0, prev.length);
					const next = prev.slice(0, start) + ins + prev.slice(Math.min(prev.length, start + del));
					const decisions: SpanDecision[] = [];
					for (const [a, len] of picks) {
						if (prev.length === 0) break;
						const s = a % prev.length;
						const e = Math.min(prev.length, s + 1 + len);
						decisions.push({ span: { start: s, end: e }, text: prev.slice(s, e), kind: "literal" });
					}
					const out = rebaseDecisions(prev, next, decisions);
					expect(out.length).toBeLessThanOrEqual(decisions.length);
					for (const d of out) {
						expect(next.slice(d.span.start, d.span.end)).toBe(d.text);
					}
				},
			),
			{ numRuns: 1000 },
		);
	});

	it("an edit identical to the previous text keeps everything unchanged", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 30 }), (s) => {
				const d: SpanDecision[] = s.length ? [{ span: { start: 0, end: s.length }, text: s, kind: "literal" }] : [];
				expect(rebaseDecisions(s, s, d)).toEqual(d);
			}),
		);
	});
});

describe("tokenAtCursor properties", () => {
	it("never throws and returns a span that contains the cursor", () => {
		fc.assert(
			fc.property(arbText, fc.integer({ min: -3, max: 200 }), (input, cursor) => {
				const t = tokenAtCursor(input, cursor);
				if (t === null) return;
				const c = Math.min(Math.max(cursor, 0), input.length);
				expect(t.span.start).toBeLessThan(t.span.end);
				expect(t.span.start).toBeLessThanOrEqual(c);
				expect(t.span.end).toBeGreaterThanOrEqual(c);
				expect(t.span.end).toBeLessThanOrEqual(input.length);
			}),
			{ numRuns: 600 },
		);
	});
});
