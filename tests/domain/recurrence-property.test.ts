import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { completionPlan, currentOccurrence, occurrencesBetween } from "../../src/domain/recurrence";
import type { MonthlyOn, OccurrenceRecord, RepeatRule, WeekStart, Weekday } from "../../src/domain/types";
import { WEEKDAYS, WEEK_STARTS } from "../../src/domain/types";
import { done, repeating, rule, series, skipped } from "./recurrence-fixtures";

// Property tests: generation is strictly increasing; monthly is anchor + n months
// (never chained); versions partition time; catch-up leaves exactly one done and the rest auto-skipped;
// a count end stops exactly at N; weekly with interval k leaves k weeks between its weeks.

const DAY = 86_400_000;
const dayNum = (d: string): number => Date.parse(`${d}T00:00:00Z`) / DAY;
const dateOf = (n: number): string => new Date(n * DAY).toISOString().slice(0, 10);
const plusDays = (d: string, k: number): string => dateOf(dayNum(d) + k);
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** A date between 2024-01-01 and 2027-12-31. */
const dateArb = fc.integer({ min: dayNum("2024-01-01"), max: dayNum("2027-12-31") }).map(dateOf);
const weekdaysArb = fc.subarray<Weekday>([...WEEKDAYS], { minLength: 1 });
const weekStartArb = fc.constantFrom<WeekStart>(...WEEK_STARTS);
const monthlyArb: fc.Arbitrary<MonthlyOn | null> = fc.oneof(
	fc.constant(null),
	fc.integer({ min: 1, max: 31 }).map((day) => ({ kind: "day" as const, day })),
	fc.constant({ kind: "lastDay" as const }),
	fc.record({ n: fc.constantFrom<1 | 2 | 3 | 4 | -1>(1, 2, 3, 4, -1), weekday: fc.constantFrom(...WEEKDAYS) }).map((x) => ({ kind: "nth" as const, ...x })),
);
/** Any valid fixed-schedule rule. */
const fixedRuleArb: fc.Arbitrary<RepeatRule> = fc.oneof(
	fc.integer({ min: 1, max: 9 }).map((interval) => rule({ interval })),
	fc.record({ interval: fc.integer({ min: 1, max: 4 }), weekdays: fc.option(weekdaysArb, { nil: null }) }).map((r) => rule({ freq: "weekly", ...r })),
	fc.record({ interval: fc.integer({ min: 1, max: 4 }), monthly: monthlyArb }).map((r) => rule({ freq: "monthly", ...r })),
);

/** `base` + times·interval units, months clamped to the month's end (from the base, never chained). */
function occurrencesAfter(base: string, r: RepeatRule, times: number): string {
	const k = r.interval * times;
	if (r.freq === "daily") return plusDays(base, k);
	if (r.freq === "weekly") return plusDays(base, 7 * k);
	const y = Number(base.slice(0, 4));
	const m0 = Number(base.slice(5, 7)) - 1 + k;
	const yy = y + Math.floor(m0 / 12);
	const mm = (m0 % 12) + 1;
	const dd = Math.min(Number(base.slice(8, 10)), daysInMonth(yy, mm));
	return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

describe("D12 recurrence properties", () => {
	it("(1) generation is strictly increasing, inside the window and never before the anchor", () => {
		fc.assert(
			fc.property(fixedRuleArb, dateArb, dateArb, fc.integer({ min: 0, max: 400 }), weekStartArb, (r, anchor, from, span, ws) => {
				const to = plusDays(from, span);
				const dates = occurrencesBetween(series(anchor, r), from, to, ws);
				for (let i = 0; i < dates.length; i++) {
					const d = dates[i]!;
					expect(d >= from && d <= to && d >= anchor).toBe(true);
					if (i > 0) expect(d > dates[i - 1]!).toBe(true);
				}
			}),
		);
	});

	it("(2) monthly by day is anchor + n·interval months, clamped to the month's end, never chained", () => {
		fc.assert(
			fc.property(dateArb, fc.integer({ min: 1, max: 31 }), fc.integer({ min: 1, max: 4 }), (anchor, day, interval) => {
				const dates = occurrencesBetween(series(anchor, rule({ freq: "monthly", interval, monthly: { kind: "day", day } })), anchor, plusDays(anchor, 800), "MO");
				const ay = Number(anchor.slice(0, 4));
				const am = Number(anchor.slice(5, 7));
				const expected: string[] = [];
				for (let k = 0; k < 40; k += interval) {
					const y = ay + Math.floor((am - 1 + k) / 12);
					const m = ((am - 1 + k) % 12) + 1;
					const d = `${y}-${String(m).padStart(2, "0")}-${String(Math.min(day, daysInMonth(y, m))).padStart(2, "0")}`;
					if (d >= anchor && d <= plusDays(anchor, 800)) expected.push(d);
				}
				expect(dates).toEqual(expected);
				// Day 29–31 lands on the month's end whenever the month is shorter.
				for (const d of dates) {
					const y = Number(d.slice(0, 4));
					const m = Number(d.slice(5, 7));
					expect(Number(d.slice(8, 10))).toBe(Math.min(day, daysInMonth(y, m)));
				}
			}),
		);
	});

	it("(3) versions partition time: each date belongs to the one version in force and follows its rule", () => {
		fc.assert(
			fc.property(
				dateArb,
				fc.array(fc.tuple(fc.integer({ min: 1, max: 300 }), fixedRuleArb), { minLength: 0, maxLength: 3 }),
				fixedRuleArb,
				weekStartArb,
				(anchor, later, first, ws) => {
					const effs = [...new Set(later.map(([off]) => plusDays(anchor, off)))].sort();
					const versions: [string, RepeatRule][] = [[anchor, first], ...effs.map((e, i): [string, RepeatRule] => [e, later[i]![1]])];
					const rec = series(anchor, versions);
					const to = plusDays(anchor, 420);
					const all = occurrencesBetween(rec, anchor, to, ws);
					const expected: string[] = [];
					versions.forEach(([eff, r], i) => {
						const until = i + 1 < versions.length ? plusDays(versions[i + 1]![0], -1) : to;
						if (until < eff) return;
						expected.push(...occurrencesBetween(series(anchor, r), eff, until, ws));
					});
					expect(all).toEqual(expected);
				},
			),
		);
	});

	it("(4) catch-up leaves exactly one done, the rest auto-skipped before today, and the next on or after today", () => {
		fc.assert(
			fc.property(fixedRuleArb, dateArb, fc.integer({ min: 0, max: 120 }), weekStartArb, (r, anchor, late, ws) => {
				const task = repeating(series(anchor, r));
				const today = plusDays(anchor, late);
				const cur = currentOccurrence(task, [], today, ws)!;
				const plan = completionPlan(task, [], today, ws)!;
				expect(plan.done).toBe(cur);
				const pastUnresolved = occurrencesBetween(task.recurrence!, anchor, plusDays(today, -1), ws).filter((d) => d > cur);
				expect(plan.autoSkipped).toEqual(cur < today ? pastUnresolved : []);
				const after: OccurrenceRecord[] = [done(plan.done, today), ...plan.autoSkipped.map((d) => skipped(d, true))];
				expect(after.filter((x) => x.status === "done")).toHaveLength(1);
				const next = currentOccurrence(task, after, today, ws)!;
				expect(next > plan.done).toBe(true);
				if (cur < today) expect(next >= today).toBe(true);
				expect(occurrencesBetween(task.recurrence!, plusDays(plan.done, 1), plusDays(next, -1), ws).every((d) => plan.autoSkipped.includes(d))).toBe(true);
			}),
		);
	});

	it("(5) a count end stops exactly at N, on time or with catch-ups", () => {
		fc.assert(
			fc.property(fixedRuleArb, dateArb, fc.integer({ min: 1, max: 12 }), fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 30, maxLength: 30 }), (r, anchor, count, lateness) => {
				const task = repeating(series(anchor, r, { kind: "count", count }));
				const records: OccurrenceRecord[] = [];
				for (const late of lateness) {
					const cur = currentOccurrence(task, records, anchor, "MO");
					if (cur === null) break;
					const today = plusDays(cur, late);
					const plan = completionPlan(task, records, today, "MO")!;
					records.push(done(plan.done, today), ...plan.autoSkipped.map((d) => skipped(d, true)));
					expect(records.length).toBeLessThanOrEqual(count);
				}
				if (currentOccurrence(task, records, anchor, "MO") === null) expect(records).toHaveLength(count);
			}),
		);
	});

	it("(7) after completion: each next date is the completion day plus the interval, or the first free multiple", () => {
		fc.assert(
			fc.property(
				fc.constantFrom<"daily" | "weekly" | "monthly">("daily", "weekly", "monthly"),
				fc.integer({ min: 1, max: 4 }),
				dateArb,
				fc.array(fc.integer({ min: -10, max: 10 }), { minLength: 1, maxLength: 12 }),
				(freq, interval, anchor, offsets) => {
					const r = rule({ freq, interval, afterCompletion: true });
					const task = repeating(series(anchor, r));
					const records: OccurrenceRecord[] = [];
					let clock = dayNum(anchor) - 20;
					for (const off of offsets) {
						const cur = currentOccurrence(task, records, anchor, "MO")!;
						expect(records.some((x) => x.occurrenceDate === cur)).toBe(false);
						// Resolutions happen in time order; the completion day is the occurrence date plus the offset.
						clock = Math.max(clock + 1, dayNum(cur) + off);
						const completedOn = dateOf(clock);
						records.push({ ...done(cur, completedOn), resolvedAt: `${completedOn}T09:00:00.000Z` });
						const next = currentOccurrence(task, records, anchor, "MO")!;
						const first = occurrencesAfter(completedOn, r, 1);
						expect(records.some((x) => x.occurrenceDate === next)).toBe(false);
						if (!records.some((x) => x.occurrenceDate === first)) expect(next).toBe(first);
						else {
							expect(records.some((x) => x.occurrenceDate === next)).toBe(false);
							expect([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((k) => occurrencesAfter(completedOn, r, k))).toContain(next);
						}
					}
				},
			),
		);
	});

	it("(6) weekly every k weeks: consecutive weeks with occurrences are exactly k weeks apart", () => {
		fc.assert(
			fc.property(dateArb, fc.integer({ min: 1, max: 5 }), weekdaysArb, weekStartArb, (anchor, k, weekdays, ws) => {
				const dates = occurrencesBetween(series(anchor, rule({ freq: "weekly", interval: k, weekdays })), anchor, plusDays(anchor, 365), ws);
				const startIso = { MO: 1, SU: 7, SA: 6 }[ws];
				const weekOf = (d: string): number => {
					const n = dayNum(d);
					const iso = ((((n + 3) % 7) + 7) % 7) + 1;
					return n - ((iso - startIso + 7) % 7);
				};
				const weeks = [...new Set(dates.map(weekOf))];
				for (let i = 1; i < weeks.length; i++) expect(weeks[i]! - weeks[i - 1]!).toBe(7 * k);
			}),
		);
	});
});
