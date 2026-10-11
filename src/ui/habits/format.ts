import { DateTime } from "luxon";
import { type DayStatus, type HabitIndex, type Progress, describeGoal, describeSchedule, progressOn, versionAt } from "../../domain/habits";
import { plural } from "../../domain/text";
import { addDays, utcDay } from "../../domain/time";
import type { Checkin, Habit, HabitVersion, LocalDate, TimeOfDay } from "../../domain/types";
import { ICON } from "../icons";
import { capitalize, formatDuration } from "../format";

// Display text and small derived values of the Habits page, the Today block and the Today column.
// Pure: no clock, no host.

export const TIME_OF_DAY_NAME: Readonly<Record<TimeOfDay, string>> = {
	morning: "Morning",
	afternoon: "Afternoon",
	evening: "Evening",
	anytime: "Anytime",
};

export const TIME_OF_DAY_ICON: Readonly<Record<TimeOfDay, string>> = {
	morning: "sunrise",
	afternoon: "sun",
	evening: "moon",
	anytime: "clock",
};

/** The icon a habit shows: its own Lucide name, else the flame. */
export function habitIcon(habit: Pick<Habit, "icon">): string {
	return habit.icon ?? ICON.railHabits;
}

/** The goal and rule in effect today; before the first version (a habit made "tomorrow") the first one. */
export function currentVersion(habit: Habit, today: LocalDate): HabitVersion {
	return versionAt(habit, today) ?? habit.versions[habit.versions.length - 1]!;
}

/** An amount without float noise: at most 6 decimals, no trailing zeros. */
export function amountText(n: number): string {
	return String(Math.round(n * 1e6) / 1e6);
}

/** "12 days", "1 day", "4 weeks". */
export function streakText(n: number, unit: "days" | "weeks"): string {
	const one = unit === "days" ? "day" : "week";
	return plural(n, one, unit);
}

/** The accessible name of the quantity field: "Min to add", "Pages to add". */
export function amountFieldLabel(unit: string | null): string {
	return `${capitalize(unit ?? "amount")} to add`;
}

/** The accessible name of a count habit's "+1" button: "Add one to Drink water" (a unit like "glasses" cannot be made singular). */
export function plusLabel(habitName: string): string {
	return `Add one to ${habitName}`;
}

/** The "n" of a board card's quantity button: the last check-in's value, else a third of the target rounded up. */
export function quickAmount(habit: Habit, index: HabitIndex, version: HabitVersion): number {
	const last = index.active(habit.id).at(-1);
	if (last !== undefined && last.value > 0) return last.value;
	return Math.max(1, Math.ceil(version.goal.target / 3));
}

/** The placeholder of the quantity field: a third of the target, rounded, at least 1. */
export function amountPlaceholder(target: number): string {
	return String(Math.max(1, Math.round(target / 3)));
}

/**
 * Parses an amount typed by a person: digits with an optional decimal part of at most 6
 * digits, the separator a point or a comma ("2,5" is 2.5). A separator followed by exactly three digits ("10,000",
 * "10.000") is ambiguous between a thousands separator and a decimal, so it is refused either way instead of
 * guessing; so are exponents ("1e3") and prefixes ("0x10"). Null when it is not a number above 0.
 */
export function parseAmount(raw: string): number | null {
	const text = raw.trim();
	if (!/^\d+(?:[.,]\d{1,6})?$/u.test(text)) return null;
	if (/^\d+[.,]\d{3}$/u.test(text)) return null;
	const n = Number(text.replace(",", "."));
	return Number.isFinite(n) && n > 0 ? n : null;
}

/** Whether the habit counts as done on `date` for the header, the group counts and the Today block (same rule as `dayShare`). `p` is the habit's `progressOn` when the caller has it already. */
export function doneOn(habit: Habit, index: HabitIndex, date: LocalDate, p: Progress | null = progressOn(habit, index, date)): boolean {
	if (p === null) return false;
	if (p.period.version.goal.period === "week") return (index.byDate(habit.id).get(date)?.length ?? 0) > 0;
	return p.met;
}

/** The habit's goal progress on `date` as the row's meta reads it: "20 of 30 min", "1 of 3 this week", or the schedule for done-or-not. */
export function progressText(habit: Habit, index: HabitIndex, date: LocalDate, p: Progress | null = progressOn(habit, index, date)): string {
	const v = p?.period.version ?? habit.versions[0]!;
	const g = v.goal;
	if (p === null || (g.type === "binary" && g.period === "day")) return describeSchedule(v);
	const unit = g.unit === null ? "" : ` ${g.unit}`;
	const per = g.period === "week" ? " this week" : "";
	return `${amountText(p.value)} of ${amountText(g.target)}${unit}${per}`;
}

/** Share of the bar to fill (0..1) for count and quantity rows; null for done-or-not. */
export function barShare(habit: Habit, index: HabitIndex, date: LocalDate, p: Progress | null = progressOn(habit, index, date)): number | null {
	if (p === null || p.period.version.goal.type === "binary") return null;
	return Math.max(0, Math.min(1, p.target === 0 ? 0 : p.value / p.target));
}

/** "Not scheduled today", "Not scheduled Saturday". */
export function notScheduledText(date: LocalDate, today: LocalDate): string {
	if (date === today) return "Not scheduled today";
	return `Not scheduled ${utcDay(date).toFormat("cccc")}`;
}

/** The page heading's date: "Sunday, Oct 4". */
function pageDateText(date: LocalDate): string {
	return utcDay(date).toFormat("cccc, MMM d");
}

/** The sub line: "Sunday, Oct 4 · 2 of 5 done today" (a past day: "Saturday, Oct 3 · 3 of 5 done"). */
export function subText(date: LocalDate, today: LocalDate, met: number, scheduled: number): string {
	return `${pageDateText(date)} · ${met} of ${scheduled} done${date === today ? " today" : ""}`;
}

export interface StripDay {
	date: LocalDate;
	/** "Mon", or "Today". */
	name: string;
	/** The day of the month. */
	num: number;
	/** 0..1: the share of that day's scheduled habits that were met; 0 for an empty day. */
	share: number;
	label: string;
}

/** The seven days ending today, with the ring share and the accessible name ("Mon 28, 75% of habits done"). */
export function stripDays(today: LocalDate, share: (date: LocalDate) => { met: number; scheduled: number }): StripDay[] {
	return Array.from({ length: 7 }, (_, i) => {
		const date = addDays(today, i - 6);
		const dt = utcDay(date);
		const { met, scheduled } = share(date);
		const s = scheduled === 0 ? 0 : met / scheduled;
		const short = dt.toFormat("ccc d");
		return {
			date,
			name: date === today ? "Today" : dt.toFormat("ccc"),
			num: dt.day,
			share: s,
			label: scheduled === 0 ? `${short}, no habits scheduled` : `${short}, ${Math.round(s * 100)}% of habits done`,
		};
	});
}

/** "2026-10" for the month of a date. */
export function monthOf(date: LocalDate): string {
	return date.slice(0, 7);
}

export function shiftMonth(month: string, by: number): string {
	return DateTime.fromISO(`${month}-01`, { zone: "UTC" }).plus({ months: by }).toFormat("yyyy-MM");
}

/** The calendar cell class of a day status (met, part, miss, off, fut). */
export function cellClass(status: DayStatus): string {
	switch (status) {
		case "met":
			return "met";
		case "partial":
			return "part";
		case "missed":
			return "miss";
		case "future":
			return "fut";
		default:
			return "off";
	}
}

const CELL_WORDS: Readonly<Record<DayStatus, string>> = {
	met: "goal met",
	partial: "some progress",
	missed: "missed",
	off: "not scheduled",
	future: "upcoming",
	before: "before the habit started",
};

/** "Oct 4, goal met". */
export function cellLabel(date: LocalDate, status: DayStatus): string {
	return `${utcDay(date).toFormat("MMM d")}, ${CELL_WORDS[status]}`;
}

/** "Sep 1", or "Sep 1, 2025" in another year. */
function sinceText(date: LocalDate, today: LocalDate): string {
	const dt = utcDay(date);
	return dt.toFormat(date.slice(0, 4) === today.slice(0, 4) ? "MMM d" : "MMM d, yyyy");
}

/** "30 min a day · every day · since Sep 1". */
export function detailLine(habit: Habit, today: LocalDate): string {
	const v = currentVersion(habit, today);
	return `${describeGoal(v)} · ${describeSchedule(v)} · since ${sinceText(habit.versions[0]!.effectiveFrom, today)}`;
}

/** The Total tile: minutes as a duration, other units as "212 glasses", done-or-not as "17 days". */
export function totalText(habit: Habit, value: number, today: LocalDate): string {
	const g = currentVersion(habit, today).goal;
	if (g.type === "binary") return `${amountText(value)} ${value === 1 ? "day" : "days"}`;
	const unit = g.unit?.trim() ?? "";
	if (unit === "min") return formatDuration(Math.round(value));
	return unit === "" ? amountText(value) : `${amountText(value)} ${unit}`;
}

/** A log entry's value: "✓" for done-or-not, "+1" for a count, "+10 min" for an amount. */
export function checkinText(habit: Habit, c: Checkin, today: LocalDate): string {
	const g = (versionAt(habit, c.date) ?? currentVersion(habit, today)).goal;
	if (g.type === "binary") return "✓";
	if (g.type === "count") return `+${amountText(c.value)}`;
	const unit = g.unit?.trim() ?? "";
	return unit === "" ? `+${amountText(c.value)}` : `+${amountText(c.value)} ${unit}`;
}

/** Whether a log entry can change its amount: a done-or-not check-in has none. */
export function hasAmount(habit: Habit, c: Checkin, today: LocalDate): boolean {
	return (versionAt(habit, c.date) ?? currentVersion(habit, today)).goal.type !== "binary";
}

/** The log entry's small text: the time it was made, or "added later" when it was made on another day than it is for. */
export function checkinWhen(c: Checkin, zone: string): string {
	const made = DateTime.fromISO(c.createdAt, { zone: "UTC" }).setZone(zone);
	if (!made.isValid) return "";
	return made.toISODate() === c.date ? made.toFormat("HH:mm") : "added later";
}

/** Newest first: by date, then by creation. */
export function newestFirst(a: Checkin, b: Checkin): number {
	if (a.date !== b.date) return a.date < b.date ? 1 : -1;
	if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
	return a.id < b.id ? 1 : -1;
}
