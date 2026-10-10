import type { Checkin, Habit, HabitGoal, HabitReminder, HabitSchedule, HabitVersion, ID, LocalDate, TagColor, TimeOfDay, WeekStart } from "./types";
import { TIMES_OF_DAY, WEEKDAYS, WEEKDAY_SHORT } from "./types";
import { compareSortKeys } from "./sortKey";
import { WEEK_START_ISO as START_ISO, DAY_MS, dateOf, dayNum, isoWeekdayOfDay as isoWeekday, weekStartOfDay as weekStartNum } from "./time";

// Habits. Pure: no
// obsidian, no clock. `today` is always passed in. Dates are "YYYY-MM-DD".
//
// Date-only arithmetic runs on day numbers (days since 1970-01-01, UTC), not
// on Luxon: the streak walk visits every day of a habit's history, and the
// performance budget gives 20 habits and 20,000 check-ins 25 ms. A date-only value has no zone,
// so UTC day numbers are exact.

/** One status feeds the strip ring, the list meta, the month calendar and the Today block. */
export type DayStatus = "met" | "partial" | "missed" | "off" | "future" | "before";

/**
 * The active check-ins of each habit, by date. Build it once per `checkins` map.
 *
 * "Active" means not deleted **and a value above 0**: a check-in of 0 (only an import or a
 * hand edit can make one; the service refuses it) is not presence. It counts for nothing, so a binary
 * day, a week-period day, the strip ring and the reminder rule all ignore it, and it is left out of
 * `byDate` and `active` (the log does not show it). It stays in the store; `records` still holds it.
 */
export interface HabitIndex {
	byDate(habitId: ID): ReadonlyMap<LocalDate, Checkin[]>;
	/** Sorted by date, then by creation. */
	active(habitId: ID): Checkin[];
	/** Every stored check-in of the habit, deleted and value-0 ones included, in no order (for the service's writes). */
	records(habitId: ID): readonly Checkin[];
}

/** A day, or a week by the version's `weekStart`; `end` is inclusive. */
export interface Period {
	start: LocalDate;
	end: LocalDate;
	version: HabitVersion;
}

export interface Progress {
	value: number;
	target: number;
	met: boolean;
	period: Period;
}

export interface Streaks {
	current: number;
	best: number;
	unit: "days" | "weeks";
}

/** What the New habit and Edit habit dialog collects. */
export interface HabitInput {
	name: string;
	icon: string | null;
	color: TagColor | null;
	timeOfDay: TimeOfDay;
	reminder: HabitReminder | null;
	goal: HabitGoal;
	schedule: HabitSchedule;
}

// -- day numbers ---------------------------------------------------------------

/** The first day of the week that holds `date` (same as calendar.weekStartOf, without Luxon). */
function weekStartDate(date: LocalDate, weekStart: WeekStart): LocalDate {
	return dateOf(weekStartNum(dayNum(date), weekStart));
}

/** Sums are rounded to the 6 decimals a value may have, so 0.7 + 0.1 meets 0.8. */
function round6(x: number): number {
	return Math.round(x * 1e6) / 1e6;
}

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

/** A real "YYYY-MM-DD" date. Without Luxon: the validator checks 20,000 check-ins on every load. */
export function isLocalDate(value: unknown): value is LocalDate {
	return typeof value === "string" && LOCAL_DATE_RE.test(value) && dateOf(dayNum(value)) === value;
}

// -- compiled rules (cached per habit object; records are immutable) ----------------

interface Rule {
	from: number;
	v: HabitVersion;
	/** Bit n set: ISO weekday n is scheduled. */
	mask: number;
}

const ALL_DAYS = 0b11111110;
const rulesCache = new WeakMap<Habit, Rule[]>();

function rulesOf(habit: Habit): Rule[] {
	let rules = rulesCache.get(habit);
	if (rules === undefined) {
		rules = habit.versions.map((v) => {
			let mask = ALL_DAYS;
			if (v.schedule.kind === "weekdays") {
				mask = 0;
				for (const d of v.schedule.days) {
					const i = WEEKDAYS.indexOf(d);
					if (i >= 0) mask |= 1 << (i + 1);
				}
			}
			return { from: dayNum(v.effectiveFrom), v, mask };
		});
		rulesCache.set(habit, rules);
	}
	return rules;
}

/** The last rule in effect on day `n`, or -1 before the first. */
function ruleIndex(rules: readonly Rule[], n: number): number {
	for (let i = rules.length - 1; i >= 0; i--) if (rules[i]!.from <= n) return i;
	return -1;
}

function scheduledOn(rule: Rule, n: number): boolean {
	return ((rule.mask >> isoWeekday(n)) & 1) === 1;
}

interface NumPeriod {
	s: number;
	e: number;
	rule: Rule;
}

/**
 * The period of rule `i` that holds day `n`: the day itself, or its week by the rule's weekStart, cut at
 * the rule's own start and before the next rule (a week split by a version change, or the creation week).
 */
function periodAt(rules: readonly Rule[], i: number, n: number): NumPeriod {
	const rule = rules[i]!;
	if (rule.v.goal.period === "day") return { s: n, e: n, rule };
	let s = weekStartNum(n, rule.v.weekStart);
	let e = s + 6;
	if (s < rule.from) s = rule.from;
	const next = rules[i + 1];
	if (next !== undefined && next.from <= e) e = next.from - 1;
	return { s, e, rule };
}

/** The active check-ins of one habit as day number → sum of values (presence = a check-in that day). */
const sumsCache = new WeakMap<ReadonlyMap<LocalDate, Checkin[]>, Map<number, number>>();

function daySums(index: HabitIndex, habitId: ID): Map<number, number> {
	const byDate = index.byDate(habitId);
	let sums = sumsCache.get(byDate);
	if (sums === undefined) {
		sums = new Map();
		for (const [date, list] of byDate) {
			let t = 0;
			for (const c of list) t += c.value;
			sums.set(dayNum(date), t);
		}
		sumsCache.set(byDate, sums);
	}
	return sums;
}

/** Count and quantity sum; a binary day counts once, however many check-ins it holds. */
function sumIn(sums: Map<number, number>, p: NumPeriod): number {
	const binary = p.rule.v.goal.type === "binary";
	let t = 0;
	for (let n = p.s; n <= p.e; n++) {
		const x = sums.get(n);
		if (x !== undefined) t += binary ? 1 : x;
	}
	return round6(t);
}

function metIn(sums: Map<number, number>, p: NumPeriod): boolean {
	return sumIn(sums, p) >= p.rule.v.goal.target;
}

/** A week cut short by a version's start or the next version (the creation week, a week-start split). */
function cutShort(p: NumPeriod): boolean {
	return p.rule.v.goal.period === "week" && p.e - p.s < 6;
}

function toPeriod(p: NumPeriod): Period {
	return { start: dateOf(p.s), end: dateOf(p.e), version: p.rule.v };
}

// -- the check-in index ---------------------------------------------------------

const EMPTY_BY_DATE: ReadonlyMap<LocalDate, Checkin[]> = new Map();

function byCreation(a: Checkin, b: Checkin): number {
	if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
	return compareSortKeys(a.id, b.id);
}

/**
 * Build once per `checkins` map (the caller caches it by map identity). Deleted check-ins and
 * check-ins of value 0 or less are left out of the active view; `records` keeps them all.
 */
export function indexCheckins(checkins: ReadonlyMap<string, Checkin>): HabitIndex {
	const lists = new Map<ID, Checkin[]>();
	const all = new Map<ID, Checkin[]>();
	for (const c of checkins.values()) {
		const records = all.get(c.habitId);
		if (records === undefined) all.set(c.habitId, [c]);
		else records.push(c);
		if (c.deletedAt !== null || !(c.value > 0)) continue;
		const list = lists.get(c.habitId);
		if (list === undefined) lists.set(c.habitId, [c]);
		else list.push(c);
	}
	const dated = new Map<ID, Map<LocalDate, Checkin[]>>();
	for (const [habitId, list] of lists) {
		list.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : byCreation(a, b)));
		const m = new Map<LocalDate, Checkin[]>();
		for (const c of list) {
			const day = m.get(c.date);
			if (day === undefined) m.set(c.date, [c]);
			else day.push(c);
		}
		dated.set(habitId, m);
	}
	return {
		byDate: (habitId) => dated.get(habitId) ?? EMPTY_BY_DATE,
		active: (habitId) => lists.get(habitId) ?? [],
		records: (habitId) => all.get(habitId) ?? [],
	};
}

// -- versions, schedule, periods ------------------------------------------------------

/** The last version with effectiveFrom ≤ date; null before the first ("before start"). */
export function versionAt(habit: Habit, date: LocalDate): HabitVersion | null {
	const rules = rulesOf(habit);
	const i = ruleIndex(rules, dayNum(date));
	return i < 0 ? null : rules[i]!.v;
}

/** `daily` and `weekly` show every day; `weekdays` those days. Never before the first version. */
export function isScheduled(habit: Habit, date: LocalDate): boolean {
	const rules = rulesOf(habit);
	const n = dayNum(date);
	const i = ruleIndex(rules, n);
	return i >= 0 && scheduledOn(rules[i]!, n);
}

export function periodOf(habit: Habit, date: LocalDate): Period | null {
	const rules = rulesOf(habit);
	const n = dayNum(date);
	const i = ruleIndex(rules, n);
	return i < 0 ? null : toPeriod(periodAt(rules, i, n));
}

/** The progress of the period that holds `date`, evaluated with that period's version. */
export function progressOn(habit: Habit, index: HabitIndex, date: LocalDate): Progress | null {
	const rules = rulesOf(habit);
	const n = dayNum(date);
	const i = ruleIndex(rules, n);
	if (i < 0) return null;
	const p = periodAt(rules, i, n);
	const value = sumIn(daySums(index, habit.id), p);
	const target = p.rule.v.goal.target;
	return { value, target, met: value >= target, period: toPeriod(p) };
}

export function dayStatus(habit: Habit, index: HabitIndex, date: LocalDate, today: LocalDate): DayStatus {
	if (date > today) return "future";
	const rules = rulesOf(habit);
	const n = dayNum(date);
	const i = ruleIndex(rules, n);
	if (i < 0) return "before";
	const p = periodAt(rules, i, n);
	const sums = daySums(index, habit.id);
	if (p.rule.v.goal.period === "day") {
		if (!scheduledOn(p.rule, n)) return "off";
		const value = sumIn(sums, p);
		return value >= p.rule.v.goal.target ? "met" : value > 0 ? "partial" : "missed";
	}
	const met = metIn(sums, p);
	if (sums.has(n)) return met ? "met" : "partial";
	// An unmet week cut short is skipped by the streaks, so its empty days are off, not missed.
	return !met && p.e < dayNum(today) && !cutShort(p) ? "missed" : "off";
}

// -- streaks and totals ------------------------------------------------------------

type Verdict = "count" | "skip" | "break";

/**
 * A met period counts. A day that is not scheduled is skipped. A period that is not met is skipped
 * when it is the current one (it holds today and is not finished), or when it is a week cut short by
 * the creation date or a version change; any other unmet period ends the run.
 */
function judge(sums: Map<number, number>, p: NumPeriod, t: number): Verdict {
	if (p.rule.v.goal.period === "day" && !scheduledOn(p.rule, p.s)) return "skip";
	if (metIn(sums, p)) return "count";
	if (p.e >= t) return "skip";
	if (cutShort(p)) return "skip";
	return "break";
}

/** The current streak walks back from today's period; best is the longest run since the first version. */
export function streaks(habit: Habit, index: HabitIndex, today: LocalDate): Streaks {
	const rules = rulesOf(habit);
	const t = dayNum(today);
	const ci = ruleIndex(rules, t);
	const unitPeriod = (ci < 0 ? rules[0]! : rules[ci]!).v.goal.period;
	const unit = unitPeriod === "day" ? "days" : "weeks";
	if (ci < 0) return { current: 0, best: 0, unit };
	const sums = daySums(index, habit.id);

	let current = 0;
	for (let n = t, i = ci; i >= 0; ) {
		const p = periodAt(rules, i, n);
		if (p.rule.v.goal.period !== unitPeriod) break;
		const verdict = judge(sums, p, t);
		if (verdict === "break") break;
		if (verdict === "count") current++;
		n = p.s - 1;
		while (i >= 0 && rules[i]!.from > n) i--;
	}

	let best = 0;
	let run = 0;
	for (let n = rules[0]!.from, i = 0; n <= t; ) {
		while (i + 1 < rules.length && rules[i + 1]!.from <= n) i++;
		const p = periodAt(rules, i, n);
		if (p.rule.v.goal.period !== unitPeriod) run = 0;
		else {
			const verdict = judge(sums, p, t);
			if (verdict === "count") best = Math.max(best, ++run);
			else if (verdict === "break") run = 0;
		}
		n = p.e + 1;
	}
	return { current, best: Math.max(best, current), unit };
}

/**
 * "Total": the sum of the active check-ins. A binary day counts once, so two binary
 * check-ins on one date from an import read as one day.
 */
export function total(habit: Habit, index: HabitIndex): number {
	const rules = rulesOf(habit);
	let t = 0;
	for (const [n, x] of daySums(index, habit.id)) {
		const i = ruleIndex(rules, n);
		t += rules[Math.max(i, 0)]!.v.goal.type === "binary" ? 1 : x;
	}
	return round6(t);
}

function monthBounds(month: string): { first: number; last: number } {
	const y = Number(month.slice(0, 4));
	const m = Number(month.slice(5, 7));
	return { first: Date.UTC(y, m - 1, 1) / DAY_MS, last: Date.UTC(y, m, 1) / DAY_MS - 1 };
}

/**
 * "This month": met of scheduled days so far (a day period), or met of the weeks that start in the
 * month so far, the current one included (a week period). The unit is the one in effect on the month's
 * last day so far. A past week cut short that was not met is left out, as the streaks skip it.
 */
export function monthStats(habit: Habit, index: HabitIndex, month: string, today: LocalDate): { met: number; of: number; unit: "days" | "weeks" } {
	const rules = rulesOf(habit);
	const { first, last } = monthBounds(month);
	const t = dayNum(today);
	const end = Math.min(last, t);
	const ui = ruleIndex(rules, end);
	const unitPeriod = (ui < 0 ? rules[0]! : rules[ui]!).v.goal.period;
	const sums = daySums(index, habit.id);
	let met = 0;
	let of = 0;
	for (let n = first, i = ruleIndex(rules, first); n <= end; n++) {
		while (i + 1 < rules.length && rules[i + 1]!.from <= n) i++;
		if (i < 0) continue;
		const p = periodAt(rules, i, n);
		if (p.rule.v.goal.period !== unitPeriod) continue;
		if (unitPeriod === "day" ? !scheduledOn(p.rule, n) : p.s !== n) continue;
		const ok = metIn(sums, p);
		if (!ok && p.e < t && cutShort(p)) continue;
		of++;
		if (ok) met++;
	}
	return { met, of, unit: unitPeriod === "day" ? "days" : "weeks" };
}

/** The month calendar: whole weeks by `weekStart`; days of other months are empty cells. */
export function monthCells(
	habit: Habit,
	index: HabitIndex,
	month: string,
	today: LocalDate,
	weekStart: WeekStart,
): { date: LocalDate | null; status: DayStatus | null }[][] {
	const { first, last } = monthBounds(month);
	const start = weekStartNum(first, weekStart);
	const rows = Math.floor((last - start) / 7) + 1;
	return Array.from({ length: rows }, (_, r) =>
		Array.from({ length: 7 }, (_, c) => {
			const n = start + r * 7 + c;
			if (n < first || n > last) return { date: null, status: null };
			const date = dateOf(n);
			return { date, status: dayStatus(habit, index, date, today) };
		}),
	);
}

/**
 * The strip ring: habits met ÷ habits scheduled that day. A week-period habit counts as scheduled
 * every day and as met for the day when the day has a check-in. The caller leaves archived habits out.
 */
export function dayShare(habits: Habit[], index: HabitIndex, date: LocalDate, _today: LocalDate): { met: number; scheduled: number } {
	const n = dayNum(date);
	let met = 0;
	let scheduled = 0;
	for (const habit of habits) {
		const rules = rulesOf(habit);
		const i = ruleIndex(rules, n);
		if (i < 0) continue;
		const p = periodAt(rules, i, n);
		const sums = daySums(index, habit.id);
		if (p.rule.v.goal.period === "day") {
			if (!scheduledOn(p.rule, n)) continue;
			scheduled++;
			if (metIn(sums, p)) met++;
		} else {
			scheduled++;
			if (sums.has(n)) met++;
		}
	}
	return { met, scheduled };
}

// -- groups ---------------------------------------------------------------------

/** Morning from 05:00, Afternoon from 12:00, Evening from the Evening time setting until 05:00. */
export function timeOfDayNow(localTime: string, eveningTime: string): TimeOfDay {
	if (localTime < "05:00" || localTime >= eveningTime) return "evening";
	return localTime >= "12:00" ? "afternoon" : "morning";
}

function bySortKey(a: Habit, b: Habit): number {
	return compareSortKeys(a.sortKey, b.sortKey);
}

/** Time-of-day order, sortKey order inside a group, empty groups dropped. The caller filters archived habits. */
export function groupHabits(habits: Habit[]): { timeOfDay: TimeOfDay; habits: Habit[] }[] {
	return TIMES_OF_DAY.map((timeOfDay) => ({ timeOfDay, habits: habits.filter((h) => h.timeOfDay === timeOfDay).sort(bySortKey) })).filter(
		(g) => g.habits.length > 0,
	);
}

// -- input rules, versions and texts ---------------------------------------------

const CLOCK_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

/** A 24-hour "HH:MM" (a reminder time). */
export function isClockTime(value: unknown): value is string {
	return typeof value === "string" && CLOCK_TIME_RE.test(value);
}

export const MAX_HABIT_VALUE = 1_000_000;
const MAX_UNIT_LENGTH = 12;

/** At most 6 decimals. */
export function hasAtMostSixDecimals(value: number): boolean {
	return round6(value) === value;
}

/** The dialog's rules, as the message to show inline, or null when the input is valid. */
export function validateHabitInput(input: HabitInput): string | null {
	if (input.name.trim().length === 0) return "Enter a name.";
	const g = input.goal;
	const unit = (g.unit ?? "").trim();
	if (g.type === "quantity" && unit.length === 0) return "Enter a unit, like min or km.";
	if (unit.length > MAX_UNIT_LENGTH) return `Keep the unit to ${MAX_UNIT_LENGTH} characters or fewer.`;
	if (!Number.isFinite(g.target) || g.target <= 0) return "The goal must be a number above 0.";
	if (g.type === "count" && !Number.isInteger(g.target)) return "A count goal must be a whole number.";
	if (g.type === "binary" && !Number.isInteger(g.target)) return "The number of times must be a whole number.";
	if (g.type === "binary" && g.period === "week" && g.target > 7) return "A week has at most 7 days.";
	if (g.target > MAX_HABIT_VALUE) return "The goal can be at most 1,000,000.";
	if (!hasAtMostSixDecimals(g.target)) return "Use at most 6 decimals.";
	if (input.schedule.kind === "weekdays" && input.schedule.days.length === 0) return "Pick at least one day.";
	if (input.reminder !== null && !isClockTime(input.reminder.time)) return "Enter the reminder time as HH:MM.";
	return null;
}

function sameGoal(a: HabitGoal, b: HabitGoal): boolean {
	return a.type === b.type && a.target === b.target && a.unit === b.unit && a.period === b.period;
}

function sameSchedule(a: HabitSchedule, b: HabitSchedule): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind !== "weekdays" || b.kind !== "weekdays") return true;
	return a.days.length === b.days.length && a.days.every((d) => b.days.includes(d));
}

/** Whether `goal` and `schedule` are the rule of `v` (the versioned part an edit compares). */
export function sameRule(v: HabitVersion, goal: HabitGoal, schedule: HabitSchedule): boolean {
	return sameGoal(v.goal, goal) && sameSchedule(v.schedule, schedule);
}

/**
 * The versions after an edit of the goal or schedule. The new version starts today (a day period)
 * or at the start of the current week by the new weekStart (a week period), never before the first
 * version and never inside a week period that is already over (on a change of week start,
 * MO to SU or SA mid-week, the start moves to the current period, so the finished week keeps its
 * rule and its days; the new version's first week is cut short instead). Days of this week that were
 * day periods are taken into the new week. Versions starting on or after that day
 * are replaced, and an edit back to the rule before leaves no version of its own.
 */
export function nextVersion(habit: Habit, goal: HabitGoal, schedule: HabitSchedule, weekStart: WeekStart, today: LocalDate): HabitVersion[] {
	const first = habit.versions[0]?.effectiveFrom ?? today;
	let from = goal.period === "week" ? weekStartDate(today, weekStart) : today;
	if (from < first) from = first;
	if (habit.versions.length > 0) {
		const rules = rulesOf(habit);
		const t = dayNum(today);
		for (let n = dayNum(from); n < t; ) {
			const p = periodAt(rules, ruleIndex(rules, n), n);
			if (p.rule.v.goal.period !== "week" || p.e >= t) break;
			n = p.e + 1;
			from = dateOf(n);
		}
	}
	const kept = habit.versions.filter((v) => v.effectiveFrom < from);
	const version: HabitVersion = {
		effectiveFrom: from,
		goal: { type: goal.type, target: goal.target, unit: goal.unit, period: goal.period },
		schedule: schedule.kind === "weekdays" ? { kind: "weekdays", days: [...schedule.days] } : { kind: schedule.kind },
		weekStart,
	};
	const prev = kept[kept.length - 1];
	if (prev !== undefined && prev.weekStart === weekStart && sameRule(prev, goal, schedule)) return kept;
	return [...kept, version];
}

/** "30 min a day", "8 glasses a day", "3 times a week", "once a day". */
export function describeGoal(v: HabitVersion): string {
	const g = v.goal;
	const per = g.period === "day" ? "a day" : "a week";
	const unit = g.unit?.trim() ?? "";
	if (g.type !== "binary" && unit.length > 0) return `${g.target} ${unit} ${per}`;
	return g.target === 1 ? `once ${per}` : `${g.target} times ${per}`;
}

/** "every day", "Mon, Wed, Fri" (from the version's week start), "any days". */
export function describeSchedule(v: HabitVersion): string {
	const s = v.schedule;
	if (s.kind === "daily") return "every day";
	if (s.kind === "weekly") return "any days";
	const start = START_ISO[v.weekStart] - 1;
	const ordered = Array.from({ length: 7 }, (_, i) => WEEKDAYS[(start + i) % 7]!).filter((d) => s.days.includes(d));
	return ordered.length === 7 ? "every day" : ordered.map((d) => WEEKDAY_SHORT[d]).join(", ");
}
