import type { QueryContext } from "./queries";
import { plural } from "./text";
import { civilOf, dateOf, dateSpecDate, dayNum, dayNumOf, isoWeekdayOfDay as isoWeekday, isValidLocalDate, isValidZone, weekStartOfDay as weekStartNum } from "./time";
import type {
	DateSpec,
	ID,
	LocalDate,
	MonthlyOn,
	OccurrenceRecord,
	Recurrence,
	RepeatEnd,
	RepeatFreq,
	RepeatRule,
	RepeatVersion,
	Task,
	WeekStart,
	Weekday,
} from "./types";
import { MONTH_SHORT, REPEAT_FREQS, WEEKDAYS, WEEKDAY_LONG, WEEKDAY_SHORT, WEEK_STARTS } from "./types";
import { isClockTime } from "./habits";
import { compareSortKeys } from "./sortKey";

// The occurrence engine. Pure: no Obsidian, no clock. Occurrences are
// generated from the anchor per rule version, never chained from the previous one. Dates are day
// numbers internally (days since 1970-01-01, UTC arithmetic on calendar dates), so a view can resolve
// thousands of series without Luxon.
//
// Rules of the engine, in one place:
// - A version is in force from its effectiveFrom until the next version; the first one is in force from
//   the anchor whatever its effectiveFrom. Every version counts its period (weeks, months, years, every N
//   days) from the anchor, so editing a rule never shifts the dates of the versions before it.
// - Yearly is every 12·N months on the anchor's month and day: a Feb 29 anchor falls on Feb 28 in other
//   years, as a monthly day 29 to 31 falls on a shorter month's last day.
// - Fixed mode: the current occurrence is the earliest generated date >= anchor with no record.
// - After completion: the next date is the completion day plus
//   the interval, early or late. The base is the most recently resolved record (greatest resolvedAt, ties
//   by occurrenceDate): its completedOn (done) or its date (skipped). Before any record it is the anchor.
//   When that date already has a record (an early completion followed by another early one), it moves on
//   by whole intervals from the base to the first free date. The anchor is no floor: the first
//   occurrence done 5 days early gives a next date that may lie before the anchor. A series moved to
//   another date (`anchoredAt`) counts only from records resolved after the move; until one exists the
//   next date is the anchor (moved on by whole intervals if taken). A later version applies from its own
//   start only, so there a date before it is raised to it (and used as it is, unless taken).
// - Ends: `endedAt`, a completed task, a count reached (every record counts, or only those resolved
//   after `countFrom` when it is set) or no date left before
//   `end.date`. The count is enforced by the writes, not by generation.

/** The largest interval a rule may have: every 999 days, weeks, months or years. */
export const MAX_INTERVAL = 999;

/** The interval the engine uses: a whole number in 1..MAX_INTERVAL, whatever is stored. */
function intervalOf(r: RepeatRule): number {
	const k = Math.floor(r.interval);
	return Number.isFinite(k) ? Math.min(MAX_INTERVAL, Math.max(1, k)) : MAX_INTERVAL;
}

/** The step in months of a monthly or yearly rule: a year is 12 months on the anchor's day, clamped like a month. */
function monthStep(r: RepeatRule): number {
	return intervalOf(r) * (r.freq === "yearly" ? 12 : 1);
}

/** "Every weekday": Monday to Friday. */
export const EVERY_WEEKDAY: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR"];

/** The stored id of an occurrence record: one per task and date. */
export function occurrenceRecordId(taskId: ID, date: LocalDate): string {
	return `${taskId}:${date}`;
}

// -- day numbers -------------------------------------------------------------------

const WEEKDAY_ISO: Readonly<Record<Weekday, number>> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

/** Months since year 0 (year * 12 + month - 1) and the day of month. */
function monthIndexOf(n: number): { mi: number; day: number } {
	const { y, m, d } = civilOf(n);
	return { mi: y * 12 + m - 1, day: d };
}

function firstOfMonth(mi: number): number {
	return dayNumOf(Math.floor(mi / 12), mi - Math.floor(mi / 12) * 12 + 1, 1);
}

function daysInMonth(mi: number): number {
	return firstOfMonth(mi + 1) - firstOfMonth(mi);
}

// -- compiled series (cached per immutable Recurrence object) ----------------------------

interface Span {
	/** First day in force (inclusive). */
	from: number;
	/** First day of the next version (exclusive); Infinity for the last. */
	to: number;
	v: RepeatVersion;
	/** Weekly: bit n set when ISO weekday n is a repeat day. */
	mask: number;
}

interface Compiled {
	anchor: number;
	/** Day of month of the anchor (monthly without a form). */
	anchorDay: number;
	anchorMonth: number;
	/** Non-empty spans in date order. */
	spans: Span[];
	/** Last allowed day (inclusive); Infinity without a date end. */
	endDay: number;
}

const compiledCache = new WeakMap<Recurrence, Compiled>();

function compile(rec: Recurrence): Compiled {
	let c = compiledCache.get(rec);
	if (c !== undefined) return c;
	const anchor = dayNum(rec.anchor);
	const { mi, day } = monthIndexOf(anchor);
	const spans: Span[] = [];
	const versions = rec.versions;
	for (let i = 0; i < versions.length; i++) {
		const v = versions[i]!;
		const from = i === 0 ? anchor : Math.max(anchor, dayNum(v.effectiveFrom));
		const next = versions[i + 1];
		const to = next === undefined ? Infinity : Math.max(anchor, dayNum(next.effectiveFrom));
		if (to <= from) continue;
		let mask = 0;
		if (v.rule.freq === "weekly") {
			if (v.rule.weekdays === null || v.rule.weekdays.length === 0) mask = 1 << isoWeekday(anchor);
			else for (const w of v.rule.weekdays) mask |= 1 << (WEEKDAY_ISO[w] ?? 0);
			if (mask === 1) mask = 1 << isoWeekday(anchor);
		}
		spans.push({ from, to, v, mask });
	}
	const endDay = rec.end.kind === "date" ? dayNum(rec.end.date) : Infinity;
	c = { anchor, anchorDay: day, anchorMonth: mi, spans, endDay };
	compiledCache.set(rec, c);
	return c;
}

function spanIndexAt(c: Compiled, n: number): number {
	let i = 0;
	while (i + 1 < c.spans.length && c.spans[i + 1]!.from <= n) i++;
	return i;
}

/** The day of a monthly occurrence in month `mi`. */
function monthlyDay(mi: number, monthly: MonthlyOn | null, anchorDay: number): number {
	const first = firstOfMonth(mi);
	const dim = daysInMonth(mi);
	if (monthly === null) return first + Math.min(anchorDay, dim) - 1;
	if (monthly.kind === "day") return first + Math.min(monthly.day, dim) - 1;
	if (monthly.kind === "lastDay") return first + dim - 1;
	const target = WEEKDAY_ISO[monthly.weekday];
	if (monthly.n === -1) {
		const last = first + dim - 1;
		return last - ((isoWeekday(last) - target + 7) % 7);
	}
	return first + ((target - isoWeekday(first) + 7) % 7) + 7 * (monthly.n - 1);
}

/** The first date >= n (n >= anchor) the fixed rule of `span` generates, ignoring the span's bounds. */
function ruleNext(c: Compiled, span: Span, n: number, weekStart: WeekStart): number {
	const r = span.v.rule;
	const k = intervalOf(r);
	if (r.freq === "daily") return c.anchor + Math.ceil((n - c.anchor) / k) * k;
	if (r.freq === "weekly") {
		// A rule carries the week start it was made with; the setting is the fallback.
		const origin = weekStartNum(c.anchor, r.weekStart ?? weekStart);
		let w = Math.floor((n - origin) / 7);
		let start = n;
		if (w % k !== 0) {
			w += k - (w % k);
			start = origin + 7 * w;
		}
		for (;;) {
			const weekEnd = origin + 7 * w + 6;
			for (let d = start; d <= weekEnd; d++) if ((span.mask & (1 << isoWeekday(d))) !== 0) return d;
			w += k;
			start = origin + 7 * w;
		}
	}
	// Monthly and yearly: a yearly rule is every 12·k months with no form (the anchor's month and day).
	const step = monthStep(r);
	const off = monthIndexOf(n).mi - c.anchorMonth;
	let j = Math.max(0, Math.ceil(off / step) * step);
	const form = r.freq === "monthly" ? r.monthly : null;
	for (;;) {
		const d = monthlyDay(c.anchorMonth + j, form, c.anchorDay);
		// Past the representable dates there is no occurrence (never an endless loop).
		if (!Number.isFinite(d)) return Infinity;
		if (d >= n) return d;
		j += step;
	}
}

/**
 * `base` plus `times` intervals (after completion), each computed from the base, never chained; months
 * and years keep the base's day where it exists (else the month's last day: Feb 29 + 1 year is Feb 28).
 */
function plusInterval(base: number, r: RepeatRule, times = 1): number {
	if (r.freq === "daily") return base + intervalOf(r) * times;
	if (r.freq === "weekly") return base + 7 * intervalOf(r) * times;
	const k = monthStep(r) * times;
	const { mi, day } = monthIndexOf(base);
	return firstOfMonth(mi + k) + Math.min(day, daysInMonth(mi + k)) - 1;
}

/**
 * `date` plus `n` periods of `freq` (days, weeks, months or years), with the engine's month-end clamp: Jan 31 plus
 * a month is Feb 28. `n` may be 0 or negative.
 */
export function periodsAfter(date: LocalDate, freq: RepeatFreq, n: number): LocalDate {
	return dateOf(plusInterval(dayNum(date), plainRule(freq), n));
}

/** The rule "every N <freq>" with no weekdays, day of the month, time or zone: the one literal of a plain rule. */
export function plainRule(freq: RepeatFreq, interval = 1): RepeatRule {
	return { freq, interval, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null };
}

/** What after completion counts from: the day of the most recently resolved record, and the taken dates. */
interface AfterBase {
	/** The completion day (done) or the date (skipped) of the base record; null before any record. */
	base: number | null;
	/** Every recorded date of the task: a next date that is taken moves on (see the header). */
	taken: ReadonlySet<number>;
}

/** Whether a record was resolved after `since` (always, without one). */
function counts(r: OccurrenceRecord, since: string | undefined): boolean {
	return since === undefined || r.resolvedAt > since;
}

/**
 * How many records count toward a count end: all, or, for a task made to repeat again (`countFrom`),
 * only those resolved after that. A move (`anchoredAt`) does not restart the count.
 */
function countedRecords(rec: Recurrence, records: readonly OccurrenceRecord[]): number {
	if (rec.countFrom === undefined) return records.length;
	let n = 0;
	for (const r of records) if (counts(r, rec.countFrom)) n++;
	return n;
}

/** The record that wins a resolvedAt tie: done before skipped, then the later date. */
function winsTie(r: OccurrenceRecord, best: OccurrenceRecord): boolean {
	if (r.status !== best.status) return r.status === "done";
	return r.occurrenceDate > best.occurrenceDate;
}

/**
 * The base record: greatest resolvedAt; a tie (one write) prefers a done record, then the later date.
 * After a move of the series (`anchoredAt`), only records resolved after it count.
 */
function baseRecordOf(records: readonly OccurrenceRecord[], anchoredAt: string | undefined): OccurrenceRecord | null {
	let best: OccurrenceRecord | null = null;
	for (const r of records) {
		if (!counts(r, anchoredAt)) continue;
		if (best === null || r.resolvedAt > best.resolvedAt || (r.resolvedAt === best.resolvedAt && winsTie(r, best))) best = r;
	}
	return best;
}

/** The day a record was resolved (`completedOn`, done or manually skipped), else its date (auto-skips). */
function baseDay(r: OccurrenceRecord): number {
	return r.completedOn !== null ? dayNum(r.completedOn) : dayNum(r.occurrenceDate);
}

function afterBaseOf(records: readonly OccurrenceRecord[], anchoredAt: string | undefined): AfterBase {
	const best = baseRecordOf(records, anchoredAt);
	return { base: best === null ? null : baseDay(best), taken: new Set(recordedDays(records)) };
}

/** The smallest `times` with base + times intervals > `d` (arithmetic: no walk over a long gap). */
function timesAfter(base: number, r: RepeatRule, d: number): number {
	let times: number;
	if (r.freq === "monthly" || r.freq === "yearly") times = Math.max(0, Math.floor((monthIndexOf(d).mi - monthIndexOf(base).mi) / monthStep(r)));
	else times = Math.max(0, Math.floor((d - base) / (r.freq === "weekly" ? 7 * intervalOf(r) : intervalOf(r))));
	// The estimate is at most one step short (the month-end clamp); finish exactly.
	while (plusInterval(base, r, times) <= d) times++;
	return times;
}

/** The after-completion next date on or after `floor`, moved on by whole intervals past taken dates. */
function afterCompletionNext(c: Compiled, r: RepeatRule, ab: AfterBase, floor: number): number {
	// Without a base the anchor itself is the start, so a taken anchor moves on by whole intervals from it.
	const base = ab.base ?? c.anchor;
	const times = ab.base === null ? 0 : 1;
	let d = Math.max(plusInterval(base, r, times), floor);
	while (ab.taken.has(d)) d = plusInterval(base, r, timesAfter(base, r, d));
	return d;
}

/** Recorded days in ascending order, queried with ascending days (a moving pointer, no set). */
class RecordedDays {
	private p = 0;
	constructor(private readonly days: readonly number[]) {}

	has(n: number): boolean {
		const days = this.days;
		while (this.p < days.length && days[this.p]! < n) this.p++;
		return this.p < days.length && days[this.p] === n;
	}
}

const dayListCache = new WeakMap<readonly OccurrenceRecord[], number[]>();

/** Cached only for frozen lists (the index's), since a caller may push into its own array. */
function recordedDays(records: readonly OccurrenceRecord[]): number[] {
	let days = dayListCache.get(records);
	if (days === undefined) {
		days = records.map((r) => dayNum(r.occurrenceDate)).sort((a, b) => a - b);
		if (Object.isFrozen(records)) dayListCache.set(records, days);
	}
	return days;
}

/**
 * The first unresolved occurrence >= `start`: fixed dates without a record, or an after-completion
 * version's next date. Null when none is left before the end date. O(records + versions).
 */
function walk(c: Compiled, start: number, recorded: RecordedDays, after: AfterBase, weekStart: WeekStart): number | null {
	let n = Math.max(start, c.anchor);
	for (let i = spanIndexAt(c, n); i < c.spans.length; ) {
		const span = c.spans[i]!;
		if (n < span.from) n = span.from;
		if (n > c.endDay) return null;
		if (n >= span.to) {
			i++;
			continue;
		}
		// After completion is checked against `after.taken` (its date may lie before recorded dates); the
		// fixed branch alone moves the ascending RecordedDays pointer, with ascending `n`.
		// The first version has no floor (the anchor is not one for after completion); a later version, or
		// a walk that starts later (the catch-up), keeps its start.
		const floor = i === 0 && n === c.anchor ? -Infinity : n;
		const d = span.v.rule.afterCompletion ? afterCompletionNext(c, span.v.rule, after, floor) : ruleNext(c, span, n, weekStart);
		if (d >= span.to) {
			n = span.to;
			i++;
			continue;
		}
		if (d > c.endDay) return null;
		if (!span.v.rule.afterCompletion && recorded.has(d)) {
			n = d + 1;
			continue;
		}
		return d;
	}
	return null;
}

function ownRecords(taskId: ID, records: readonly OccurrenceRecord[]): readonly OccurrenceRecord[] {
	return records.every((r) => r.taskId === taskId) ? records : records.filter((r) => r.taskId === taskId);
}

function endedByState(rec: Recurrence, records: readonly OccurrenceRecord[]): boolean {
	return rec.endedAt !== null || (rec.end.kind === "count" && countedRecords(rec, records) >= rec.end.count);
}

function nextUnresolved(rec: Recurrence, records: readonly OccurrenceRecord[], weekStart: WeekStart): number | null {
	if (endedByState(rec, records)) return null;
	const c = compile(rec);
	return walk(c, c.anchor, new RecordedDays(recordedDays(records)), afterBaseOf(records, rec.anchoredAt), weekStart);
}

// -- public reads --------------------------------------------------------------------

/** The version in force on `date`: the last with effectiveFrom <= date; the first one before that. */
export function versionAt(rec: Recurrence, date: LocalDate): RepeatVersion {
	let found = rec.versions[0]!;
	for (const v of rec.versions) {
		if (v.effectiveFrom <= date) found = v;
		else break;
	}
	return found;
}

/** The rule in force on `date`. */
export function ruleAt(rec: Recurrence, date: LocalDate): RepeatRule {
	return versionAt(rec, date).rule;
}

function* generate(c: Compiled, from: number, to: number, weekStart: WeekStart): Generator<number> {
	const last = Math.min(to, c.endDay);
	let n = Math.max(from, c.anchor);
	for (let i = spanIndexAt(c, n); i < c.spans.length && n <= last; ) {
		const span = c.spans[i]!;
		if (n < span.from) n = span.from;
		if (span.v.rule.afterCompletion || n >= span.to) {
			n = Math.max(n, span.to);
			i++;
			continue;
		}
		const d = ruleNext(c, span, n, weekStart);
		if (d >= span.to) {
			n = span.to;
			i++;
			continue;
		}
		if (d > last) return;
		yield d;
		n = d + 1;
	}
}

/**
 * Every fixed-schedule occurrence date in [from, to], strictly increasing. Rule-only: records, `end.count`
 * and `endedAt` are not applied (see projectOccurrences); `end.date` caps it. After-completion versions
 * generate nothing here: their single next date depends on the records (currentOccurrence).
 */
export function occurrencesBetween(rec: Recurrence, from: LocalDate, to: LocalDate, weekStart: WeekStart): LocalDate[] {
	if (to < from) return [];
	const out: LocalDate[] = [];
	for (const d of generate(compile(rec), dayNum(from), dayNum(to), weekStart)) out.push(dateOf(d));
	return out;
}

/**
 * The current occurrence of a repeating task, or null when it does not repeat or the series ended
 * (`endedAt`, the task completed, the count reached, or no date left before `end.date`). `records` are
 * this task's records (others are ignored). Fixed mode: the earliest generated date >= anchor without a
 * record. After completion: the anchor before any record, else the most recently resolved record's
 * completedOn (done) or date (skipped) plus the interval, early or late. `today` is not needed by
 * these rules (the result does not move with the clock); it is part of the contract for callers.
 */
export function currentOccurrence(task: Task, records: readonly OccurrenceRecord[], _today: LocalDate, weekStart: WeekStart): LocalDate | null {
	const rec = task.recurrence;
	if (rec === null || task.status === "completed") return null;
	const d = nextUnresolved(rec, ownRecords(task.id, records), weekStart);
	return d === null ? null : dateOf(d);
}

/** The spec of one occurrence: the rule's wall time and zone in force that day, else date-only. */
export function occurrenceSpec(rec: Recurrence, date: LocalDate): DateSpec {
	const r = ruleAt(rec, date);
	return r.time !== null && r.tz !== null ? { kind: "datetime", local: `${date}T${r.time}`, tz: r.tz } : { kind: "date", date };
}

/** When the task is due. `task.scheduled` when it does not repeat; the current occurrence when it does. */
export function effectiveSchedule(task: Task, records: readonly OccurrenceRecord[], ctx: QueryContext): DateSpec | null {
	if (task.recurrence === null) return task.scheduled;
	const date = currentOccurrence(task, records, ctx.today, ctx.weekStart);
	return date === null ? null : occurrenceSpec(task.recurrence, date);
}

/** True when the stored end applies: `endedAt` set, the count reached, or no date left before `end.date`. */
export function isSeriesEnded(rec: Recurrence, records: readonly OccurrenceRecord[], weekStart: WeekStart = "MO"): boolean {
	return nextUnresolved(rec, records, weekStart) === null;
}

/** How many occurrences a count end still allows; null without a count. */
export function remainingCount(rec: Recurrence, records: readonly OccurrenceRecord[]): number | null {
	return rec.end.kind === "count" ? Math.max(0, rec.end.count - countedRecords(rec, records)) : null;
}

// -- descriptions --------------------------------------------------------------------

const NTH: Readonly<Record<number, string>> = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" };

/** "1st", "2nd", "3rd", "11th", "22nd", "31st". */
export function ordinal(n: number): string {
	const tens = n % 100;
	if (tens >= 11 && tens <= 13) return `${n}th`;
	const suffix = n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
	return `${n}${suffix}`;
}

/** "Oct 9": the month and day of a date, always English. */
export function monthDayText(date: LocalDate): string {
	return `${MONTH_SHORT[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
}

/** The weekday of a date. */
export function weekdayOf(date: LocalDate): Weekday {
	return WEEKDAYS[isoWeekday(dayNum(date)) - 1]!;
}

function describeVersion(r: RepeatRule, anchor: LocalDate): string {
	const k = r.interval;
	const unit = r.freq === "daily" ? "day" : r.freq === "weekly" ? "week" : r.freq === "monthly" ? "month" : "year";
	if (r.afterCompletion) return `${plural(k, unit)} after done`;
	if (r.freq === "daily") return k === 1 ? "every day" : `every ${k} days`;
	if (r.freq === "yearly") {
		// The chip stays short; the picker's summary spells out the Feb 29 fallback.
		const on = `on ${monthDayText(anchor)}`;
		return k === 1 ? `yearly ${on}` : `every ${k} years ${on}`;
	}
	if (r.freq === "weekly") {
		const days = r.weekdays === null || r.weekdays.length === 0 ? [weekdayOf(anchor)] : WEEKDAYS.filter((d) => r.weekdays!.includes(d));
		let list: string;
		if (days.length === 7) list = k === 1 ? "day" : "daily";
		else if (days.length === 5 && EVERY_WEEKDAY.every((d) => days.includes(d))) list = k === 1 ? "weekday" : "weekdays";
		else list = days.map((d) => WEEKDAY_SHORT[d]).join(", ");
		return k === 1 ? `every ${list}` : `every ${k} weeks, ${list}`;
	}
	const m = r.monthly;
	if (m !== null && m.kind === "nth") {
		const what = `on the ${NTH[m.n] ?? ""} ${WEEKDAY_LONG[m.weekday]}`;
		return k === 1 ? `monthly ${what}` : `every ${k} months ${what}`;
	}
	if (m !== null && m.kind === "lastDay") return k === 1 ? "monthly on the last day" : `every ${k} months on the last day`;
	const day = m === null ? Number(anchor.slice(8, 10)) : m.day;
	// The chip stays short; the picker's summary spells out the month-end fallback.
	const on = `on the ${ordinal(day)}`;
	return k === 1 ? `monthly ${on}` : `every ${k} months ${on}`;
}

/** "every Fri", "3 days after done", "monthly on the 1st", "yearly on Mar 14" (the row chip). `at` picks the version (default: the last). */
export function describeRule(rec: Recurrence, at?: LocalDate): string {
	const v = at === undefined ? rec.versions[rec.versions.length - 1]! : versionAt(rec, at);
	return describeVersion(v.rule, rec.anchor);
}

/** "ends Dec 31", "ends after 10 times", or null when it never ends. The year shows when it differs from `today`'s. */
export function describeEnd(rec: Pick<Recurrence, "end">, today?: LocalDate): string | null {
	const end = rec.end;
	if (end.kind === "never") return null;
	if (end.kind === "count") return `ends after ${plural(end.count, "time")}`;
	const label = monthDayText(end.date);
	return today !== undefined && today.slice(0, 4) !== end.date.slice(0, 4) ? `ends ${label}, ${end.date.slice(0, 4)}` : `ends ${label}`;
}

// -- writes, as plans ----------------------------------------------------------------

/** What "Complete occurrence" resolves: the done date and the past dates skipped automatically. */
export interface CompletionPlan {
	done: LocalDate;
	autoSkipped: LocalDate[];
}

/**
 * Null when there is no current occurrence. Fixed mode, overdue: the earliest unresolved date is done and
 * every other unresolved date before today is skipped automatically, stopping at a count end. After
 * completion, or due today or later: the current date alone is done. Pure; RecurrenceService writes it.
 */
export function completionPlan(task: Task, records: readonly OccurrenceRecord[], today: LocalDate, weekStart: WeekStart): CompletionPlan | null {
	const rec = task.recurrence;
	if (rec === null || task.status === "completed") return null;
	const own = ownRecords(task.id, records);
	const cur = nextUnresolved(rec, own, weekStart);
	if (cur === null) return null;
	const doneDate = dateOf(cur);
	const t = dayNum(today);
	if (cur >= t || ruleAt(rec, doneDate).afterCompletion) return { done: doneDate, autoSkipped: [] };
	const c = compile(rec);
	const recorded = new RecordedDays(recordedDays(own));
	let remaining = rec.end.kind === "count" ? rec.end.count - countedRecords(rec, own) - 1 : Infinity;
	const autoSkipped: LocalDate[] = [];
	// The records this write adds share one resolvedAt, and a tie prefers the done one, so the base
	// is the completion day (today) throughout. Mirrored here so a later after-completion version sees
	// what the written records will give: its next date is after today, so the catch-up passes it.
	const taken = new Set(recordedDays(own));
	taken.add(cur);
	const after: AfterBase = { base: t, taken };
	for (let n = cur + 1; remaining > 0; ) {
		const d = walk(c, n, recorded, after, weekStart);
		// Only fixed dates are caught up: an after-completion version never skips automatically.
		if (d === null || d >= t || ruleAt(rec, dateOf(d)).afterCompletion) break;
		autoSkipped.push(dateOf(d));
		taken.add(d);
		remaining--;
		n = d + 1;
	}
	return { done: doneDate, autoSkipped };
}

/** "missed": a generated date after the current one and before today, which completing will skip. */
export type ProjectedKind = "done" | "skipped" | "current" | "missed" | "future";

export interface ProjectedOccurrence {
	date: LocalDate;
	kind: ProjectedKind;
}

/**
 * A series' occurrences in [from, to] for the calendar, by date: records as done or skipped, the
 * current occurrence, and (fixed mode) the later generated dates the end still allows. An ended series
 * shows its records only; after completion shows its next date only. With `today`, generated dates after
 * the current one and before today are "missed" (an overdue fixed series will skip them); without it they
 * are "future".
 */
export function projectOccurrences(
	task: Task,
	records: readonly OccurrenceRecord[],
	from: LocalDate,
	to: LocalDate,
	weekStart: WeekStart,
	today?: LocalDate,
): ProjectedOccurrence[] {
	const rec = task.recurrence;
	if (rec === null || to < from) return [];
	const own = ownRecords(task.id, records);
	const out: ProjectedOccurrence[] = [];
	for (const r of own) if (r.occurrenceDate >= from && r.occurrenceDate <= to) out.push({ date: r.occurrenceDate, kind: r.status });
	const cur = task.status === "completed" ? null : nextUnresolved(rec, own, weekStart);
	if (cur !== null) {
		const curDate = dateOf(cur);
		if (curDate >= from && curDate <= to) out.push({ date: curDate, kind: "current" });
		if (!ruleAt(rec, curDate).afterCompletion) {
			let allowed = rec.end.kind === "count" ? rec.end.count - countedRecords(rec, own) - 1 : Infinity;
			const recorded = new RecordedDays(recordedDays(own));
			const fromDay = dayNum(from);
			// Without a count, dates before the window cannot matter, so generation starts at the window.
			const start = allowed === Infinity ? Math.max(cur + 1, fromDay) : cur + 1;
			for (const d of generate(compile(rec), start, dayNum(to), weekStart)) {
				if (allowed <= 0) break;
				if (recorded.has(d)) continue;
				allowed--;
				if (d >= fromDay) out.push({ date: dateOf(d), kind: today !== undefined && dateOf(d) < today ? "missed" : "future" });
			}
		}
	}
	return out.sort((a, b) => compareSortKeys(a.date, b.date));
}

// -- copies --------------------------------------------------------------------------

/**
 * A rule whose "the anchor's weekday / day of month" is spelled out, so a new anchor keeps the dates:
 * weekly `weekdays: null` → the anchor's weekday; monthly `monthly: null` → `{ kind: "day", day }` of
 * the anchor. After-completion rules are returned unchanged.
 */
export function explicitRule(r: RepeatRule, anchor: LocalDate): RepeatRule {
	if (r.afterCompletion) return r;
	if (r.freq === "weekly" && r.weekdays === null) return { ...r, weekdays: [weekdayOf(anchor)] };
	if (r.freq === "monthly" && r.monthly === null) return { ...r, monthly: { kind: "day", day: Number(anchor.slice(8, 10)) } };
	return r;
}

/**
 * The series of a copy ("Duplicate"): it starts at the source's current occurrence when that is today
 * or later, else at its first date on or after today (today in after-completion mode, or when the source
 * has no date left), so the copy is never overdue from day one. Only the rule in force then is kept
 * (later versions counted their periods from the source's anchor, so they would shift), with "the
 * anchor's weekday / day" spelled out; the end is kept (a passed end date becomes never); no history, not
 * ended, no `anchoredAt` or `countFrom`.
 */
export function restartedSeries(task: Task & { recurrence: Recurrence }, records: readonly OccurrenceRecord[], today: LocalDate, weekStart: WeekStart): Recurrence {
	const rec = task.recurrence;
	const cur = currentOccurrence(task, records, today, weekStart);
	let anchor = today;
	if (cur !== null && cur >= today) anchor = cur;
	else if (!ruleAt(rec, today).afterCompletion) {
		const next = generate(compile(rec), dayNum(today), Infinity, weekStart).next();
		if (next.done !== true) anchor = dateOf(next.value);
	}
	// A yearly rule takes its month and day from the anchor: a copy of a Feb 29 series is anchored on its clamped
	// date (Feb 28), so it falls on Feb 28 in leap years too (Repeating tasks rule 17).
	const versions = [{ effectiveFrom: anchor, rule: explicitRule(ruleAt(rec, anchor), rec.anchor) }];
	// An end date that leaves the copy no date of its own is dropped: the sweep would end the copy at once.
	const end: RepeatEnd = rec.end.kind === "date" && repeatEndProblem(rec.end, { anchor, versions }, weekStart) !== null ? { kind: "never" } : rec.end;
	const { anchoredAt: _moved, countFrom: _counted, ...rest } = rec;
	return { ...rest, anchor, versions, end, endedAt: null };
}

// -- indexes for views ---------------------------------------------------------------

const indexCache = new WeakMap<ReadonlyMap<string, OccurrenceRecord>, ReadonlyMap<ID, readonly OccurrenceRecord[]>>();
const NO_RECORDS: readonly OccurrenceRecord[] = [];

/**
 * Records by task, each list sorted by occurrenceDate and frozen. Cached per (immutable) map. Date order
 * is not resolution order: an after-completion record done early can be dated before a record resolved
 * earlier. Order by `resolvedAt` where resolution order matters (history).
 */
export function indexOccurrenceRecords(map: ReadonlyMap<string, OccurrenceRecord>): ReadonlyMap<ID, readonly OccurrenceRecord[]> {
	let index = indexCache.get(map);
	if (index !== undefined) return index;
	const byTask = new Map<ID, OccurrenceRecord[]>();
	for (const r of map.values()) {
		let list = byTask.get(r.taskId);
		if (list === undefined) {
			list = [];
			byTask.set(r.taskId, list);
		}
		list.push(r);
	}
	for (const list of byTask.values()) {
		list.sort((a, b) => compareSortKeys(a.occurrenceDate, b.occurrenceDate));
		Object.freeze(list);
	}
	index = byTask;
	indexCache.set(map, index);
	return index;
}

/** A per-call resolver of effectiveSchedule: a view resolves thousands of tasks against one index. */
export function scheduleResolver(
	state: { readonly occurrenceRecords: ReadonlyMap<string, OccurrenceRecord> },
	ctx: QueryContext,
): (task: Task) => DateSpec | null {
	const index = indexOccurrenceRecords(state.occurrenceRecords);
	const cache = new Map<Task, DateSpec | null>();
	return (task) => {
		if (task.recurrence === null) return task.scheduled;
		let spec = cache.get(task);
		if (spec === undefined) {
			spec = effectiveSchedule(task, index.get(task.id) ?? NO_RECORDS, ctx);
			cache.set(task, spec);
		}
		return spec;
	};
}

// -- rule input (the services) --------------------------------------------------------

/** Why a rule cannot be stored, or null when it can (the services refuse with this message). */
export function repeatRuleProblem(rule: RepeatRule): string | null {
	if (!(REPEAT_FREQS as readonly unknown[]).includes(rule.freq)) return "That repeat is not available.";
	if (typeof rule.interval !== "number" || !Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > MAX_INTERVAL) {
		return `Repeat every 1 to ${MAX_INTERVAL}.`;
	}
	if (rule.weekStart !== undefined && !(WEEK_STARTS as readonly unknown[]).includes(rule.weekStart)) return "That week start is not available.";
	if (rule.freq === "weekly" && rule.weekdays !== null) {
		if (rule.weekdays.length === 0) return "Pick at least one weekday.";
		if (!rule.weekdays.every((d) => (WEEKDAYS as readonly unknown[]).includes(d))) return "That weekday is not available.";
	}
	const m = rule.freq === "monthly" ? rule.monthly : null;
	if (m !== null) {
		if (m.kind === "day") {
			if (!Number.isInteger(m.day) || m.day < 1 || m.day > 31) return "Pick a day of the month from 1 to 31.";
		} else if (m.kind === "nth") {
			if (![1, 2, 3, 4, -1].includes(m.n) || !(WEEKDAYS as readonly unknown[]).includes(m.weekday)) return "That day of the month is not available.";
		} else if (m.kind !== "lastDay") return "That day of the month is not available.";
	}
	if (rule.afterCompletion) {
		if (rule.freq === "weekly" && rule.weekdays !== null) return "Count from completion works only without picked weekdays.";
		if (m !== null && m.kind !== "day") return "Count from completion works only with a day of the month.";
	}
	if (rule.time !== null || rule.tz !== null) {
		if (rule.time === null || !isClockTime(rule.time)) return "The time is not valid.";
		if (rule.tz === null || !isValidZone(rule.tz)) return "The time zone is not valid.";
	}
	return null;
}

/** The most times a count end allows, like the largest interval. */
const MAX_END_COUNT = 999;

/**
 * Why an end cannot be stored, or null when it can: a count of 1 to 999 and a real date. With `series` (the series the
 * end would close; its records and its own end are ignored), an end date that leaves the series no occurrence at all:
 * before its anchor or before its first date (every Friday from a Monday, ending on the Wednesday). Such a series would
 * be ended by the sweep as soon as it is written. The picker, Quick Add and the services all show this message.
 */
export function repeatEndProblem(end: RepeatEnd, series?: Pick<Recurrence, "anchor" | "versions">, weekStart: WeekStart = "MO"): string | null {
	if (end.kind === "never") return null;
	if (end.kind === "count") return Number.isInteger(end.count) && end.count >= 1 && end.count <= MAX_END_COUNT ? null : `End after 1 to ${MAX_END_COUNT} times.`;
	if (end.kind !== "date" || !isValidLocalDate(end.date)) return "The end date is not valid.";
	if (series === undefined) return null;
	const closed: Recurrence = { anchor: series.anchor, versions: series.versions, end, endedAt: null };
	return end.date < series.anchor || nextUnresolved(closed, [], weekStart) === null ? "The repeat ends before its first date." : null;
}

/**
 * The stored form of a valid rule: weekdays deduplicated in Monday-first order, unused fields null. A
 * weekly rule keeps its own week start, else takes `weekStart` (the setting); without either it has
 * none (the engine then uses the setting it is given). Other rules carry no week start.
 */
export function normalizeRepeatRule(rule: RepeatRule, weekStart?: WeekStart): RepeatRule {
	const weekly = rule.freq === "weekly" && rule.weekdays !== null;
	const monthly = rule.freq === "monthly" ? rule.monthly : null;
	const ws = rule.freq === "weekly" ? (rule.weekStart ?? weekStart) : undefined;
	const out: RepeatRule = {
		freq: rule.freq,
		interval: rule.interval,
		weekdays: weekly ? WEEKDAYS.filter((d) => rule.weekdays!.includes(d)) : null,
		monthly: monthly === null ? null : monthly.kind === "day" ? { kind: "day", day: monthly.day } : monthly.kind === "lastDay" ? { kind: "lastDay" } : { kind: "nth", n: monthly.n, weekday: monthly.weekday },
		afterCompletion: rule.afterCompletion,
		time: rule.time,
		tz: rule.time === null ? null : rule.tz,
	};
	if (ws !== undefined) out.weekStart = ws;
	return out;
}

export interface StartedRecurrence {
	recurrence: Recurrence;
	/** True when the rule took its time and zone from the timed `scheduled` spec. */
	timeFromSpec: boolean;
}

/** A series with one version: `rule` from `anchor` on, ending as `end` says (never by default). */
export function singleVersionRecurrence(anchor: LocalDate, rule: RepeatRule, end: RepeatEnd = { kind: "never" }): Recurrence {
	return { anchor, versions: [{ effectiveFrom: anchor, rule }], end, endedAt: null };
}

/**
 * The anchor of a new series from its start date (Repeating tasks rules 11 and 19): a weekly rule with picked weekdays
 * starts on the first of them on or after `start`, so `every 2 weeks on Monday` made on a Wednesday first falls on the
 * coming Monday, not the one two weeks after it; every other rule starts on `start`. Quick Add, setRepeat and the
 * picker's checks all go through it.
 */
export function seriesAnchor(start: LocalDate, rule: RepeatRule): LocalDate {
	if (rule.freq !== "weekly" || rule.weekdays === null || rule.weekdays.length === 0) return start;
	const n = dayNum(start);
	for (let d = n; d < n + 7; d++) {
		const date = dateOf(d);
		if (rule.weekdays.includes(weekdayOf(date))) return date;
	}
	return start;
}

/**
 * "Make repeating" (Quick Add and setRepeat share it). The anchor is the date of `scheduled` in the
 * display zone, else `fallback`, moved to the first picked weekday by `seriesAnchor`. A timed spec gives the rule its wall time and zone when the rule has
 * none; the anchor is then the spec's own wall date, so the first occurrence is the scheduled moment.
 * The rule is normalized; validate it with repeatRuleProblem first.
 */
export function startRecurrence(
	scheduled: DateSpec | null,
	rule: RepeatRule,
	end: RepeatEnd | undefined,
	fallback: LocalDate,
	zone: string,
	weekStart?: WeekStart,
): StartedRecurrence {
	let r = normalizeRepeatRule(rule, weekStart);
	let anchor = fallback;
	let timeFromSpec = false;
	if (scheduled !== null) {
		if (scheduled.kind === "datetime" && r.time === null) {
			r = { ...r, time: scheduled.local.slice(11, 16), tz: scheduled.tz };
			anchor = scheduled.local.slice(0, 10);
			timeFromSpec = true;
		} else {
			anchor = dateSpecDate(scheduled, zone);
		}
	}
	return {
		recurrence: singleVersionRecurrence(seriesAnchor(anchor, r), r, end),
		timeFromSpec,
	};
}
