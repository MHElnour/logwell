import { addDays, monthStart, shiftMonth, utcDay, yearMonthOf } from "../../domain/time";
import { type LocalDate, MONTH_LONG } from "../../domain/types";

// Calendar titles, navigation and the text of day and time labels.
// Dates are plain YYYY-MM-DD values, so everything here runs in UTC and never shifts a day.

export type CalendarMode = "week" | "month";

const d = utcDay;

/** "Sep 28 – Oct 4, 2026"; both years when the week crosses New Year. */
export function weekTitle(days: readonly LocalDate[]): string {
	const first = d(days[0]!);
	const last = d(days[days.length - 1]!);
	if (first.year === last.year) return `${first.toFormat("LLL d")} – ${last.toFormat("LLL d, yyyy")}`;
	return `${first.toFormat("LLL d, yyyy")} – ${last.toFormat("LLL d, yyyy")}`;
}

/** "October 2026", from a date or a "YYYY-MM" month. The one month title of the calendar, the Habits page and the date popover. */
export function monthTitle(date: string): string {
	return `${MONTH_LONG[Number(date.slice(5, 7)) - 1] ?? ""} ${date.slice(0, 4)}`;
}

/**
 * Moves the anchor by a week or a month. A month step lands on the first of that month, or on
 * today when today is in it, so the week view opened from there makes sense.
 */
export function shiftAnchor(anchor: LocalDate, mode: CalendarMode, step: 1 | -1, today: LocalDate): LocalDate {
	if (mode === "week") return addDays(anchor, 7 * step);
	const first = monthStart(shiftMonth(yearMonthOf(anchor), step));
	return today.slice(0, 7) === first.slice(0, 7) ? today : first;
}

/** "Thu Oct 8". */
export function fmtDay(date: LocalDate): string {
	return d(date).toFormat("ccc LLL d");
}

/** "Thu". */
export function fmtDow(date: LocalDate): string {
	return d(date).toFormat("ccc");
}

/** "8". */
export function fmtDom(date: LocalDate): string {
	return String(d(date).day);
}

export { fmtMin } from "../../domain/time";
