import { DateTime } from "luxon";
import { dateTone as dayTone } from "../app/views";
import { NAME_LOCALE, dateSpecDate, dateSpecDisplayLocal, daysBetween, utcDay } from "../domain/time";
import type { DateSpec, LocalDate, Priority, Task, WeekStart } from "../domain/types";

// Display formatting. Date-only values are shown as-is; timed values in the
// display zone.

export function formatDate(date: LocalDate, today: LocalDate): string {
	const diff = daysBetween(today, date);
	if (diff === 0) return "Today";
	if (diff === 1) return "Tomorrow";
	if (diff === -1) return "Yesterday";
	const dt = utcDay(date);
	const sameYear = date.slice(0, 4) === today.slice(0, 4);
	return dt.toFormat(sameYear ? "EEE, MMM d" : "MMM d, yyyy");
}

export function formatDateSpec(spec: DateSpec, zone: string, today: LocalDate): string {
	const date = formatDate(dateSpecDate(spec, zone), today);
	const local = dateSpecDisplayLocal(spec, zone);
	return local === null ? date : `${date} ${local.slice(11)}`;
}

/** What an Undo that cannot be done says. */
export const NOTHING_TO_UNDO = "Nothing to undo.";

export function formatDuration(min: number): string {
	const h = Math.floor(min / 60);
	const m = min % 60;
	if (h === 0) return `${m}m`;
	return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatInstant(iso: string, zone: string): string {
	const dt = DateTime.fromISO(iso, { zone: "UTC", locale: NAME_LOCALE }).setZone(zone);
	return dt.isValid ? dt.toFormat("MMM d, yyyy, HH:mm") : iso;
}

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago": how long before `nowMs` an instant was. */
export function formatAgo(thenMs: number, nowMs: number): string {
	const minutes = Math.floor(Math.max(0, nowMs - thenMs) / 60_000);
	if (minutes < 1) return "just now";
	const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? "" : "s"} ago`;
	if (minutes < 60) return unit(minutes, "minute");
	if (minutes < 1440) return unit(Math.floor(minutes / 60), "hour");
	return unit(Math.floor(minutes / 1440), "day");
}

/** Splits a spec into the values of a date and a time input, in the display zone. */
export function specInputs(spec: DateSpec | null, zone: string): { date: string; time: string } {
	if (spec === null) return { date: "", time: "" };
	if (spec.kind === "date") return { date: spec.date, time: "" };
	const local = dateSpecDisplayLocal(spec, zone) ?? spec.local;
	return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

/** Builds a spec from input values. A time makes it a timed value in the display zone. */
export function specFromInputs(date: string, time: string, zone: string): DateSpec | null {
	if (date === "") return null;
	if (time === "") return { kind: "date", date };
	return { kind: "datetime", local: `${date}T${time}`, tz: zone };
}

export { pad2 } from "../domain/time";

const WEEKDAY_INITIALS: Readonly<Record<WeekStart, string[]>> = {
	MO: ["M", "T", "W", "T", "F", "S", "S"],
	SU: ["S", "M", "T", "W", "T", "F", "S"],
	SA: ["S", "S", "M", "T", "W", "T", "F"],
};

/** Weekday initials in display order, from the week start: M T W T F S S for a Monday start. */
export function weekdayInitials(weekStart: WeekStart): string[] {
	return WEEKDAY_INITIALS[weekStart];
}

/** "high" becomes "High". */
export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// -- Priority and row dates ----------------------------------------------------

export { PRIORITY_NAME } from "../domain/types";
/** The hue a priority takes: flag, checkbox border and fill. None has no hue. */
export const PRIORITY_HUE: Record<Priority, "red" | "yellow" | "blue" | null> = { 0: null, 1: "red", 2: "yellow", 3: "blue" };

export type DateTone = "overdue" | "today" | "tomorrow" | "later" | "none";

/**
 * The date a row or the details chip shows: the schedule, else the deadline. `schedule` is the effective
 * schedule (the current occurrence of a repeating task, whose own `scheduled` is null); without it the
 * task's own `scheduled` is used.
 */
export function dueSpecOf(task: Pick<Task, "scheduled" | "deadline">, schedule?: DateSpec | null): DateSpec | null {
	return (schedule === undefined ? task.scheduled : schedule) ?? task.deadline;
}

/** Color semantics of the design: overdue red, today blue, tomorrow orange, later faint. */
export function dateTone(spec: DateSpec | null, zone: string, today: LocalDate): DateTone {
	if (spec === null) return "none";
	return dayTone(dateSpecDate(spec, zone), today) ?? "later";
}

/** A row's date: only the time when it is today and timed. */
export function rowDateText(spec: DateSpec, zone: string, today: LocalDate): string {
	const local = dateSpecDisplayLocal(spec, zone);
	if (local !== null && dateSpecDate(spec, zone) === today) return local.slice(11);
	return formatDateSpec(spec, zone, today);
}

/**
 * The details chip: "Today, 19:00 · 45m", or "No date". `opts.schedule` is the effective schedule and
 * `opts.repeat` the short rule text, so a repeating task reads "Fri, Oct 9 · every Fri".
 */
export function detailsDateText(
	task: Pick<Task, "scheduled" | "deadline" | "plannedDurationMin">,
	zone: string,
	today: LocalDate,
	opts: { schedule?: DateSpec | null; repeat?: string | null } = {},
): string {
	const spec = dueSpecOf(task, opts.schedule);
	const repeat = opts.repeat ?? null;
	const extras = [...(repeat === null ? [] : [repeat]), ...(task.plannedDurationMin === null ? [] : [formatDuration(task.plannedDurationMin)])];
	if (spec === null) return ["No date", ...extras].join(" · ");
	const local = dateSpecDisplayLocal(spec, zone);
	const date = formatDate(dateSpecDate(spec, zone), today);
	const when = local === null ? date : `${date}, ${local.slice(11)}`;
	return [when, ...extras].join(" · ");
}

/** The key of a list row: a Completed history row shares its task's id, so its date is part of the key. */
export function entryKey(entry: { task: Pick<Task, "id">; occurrence: { date: LocalDate } | null }): string {
	return entry.occurrence === null ? entry.task.id : `${entry.task.id}:${entry.occurrence.date}`;
}
