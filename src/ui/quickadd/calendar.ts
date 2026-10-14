import type { WeekStart } from "../../app/settings";
import { monthGrid as domainMonthGrid } from "../../domain/calendar";
import { type YearMonth, dateOf, dayNumOf, isoWeekdayOf, monthLength, monthStart, shiftMonth, yearMonthOf } from "../../domain/time";
import { monthDayText } from "../../domain/recurrence";
import { type LocalDate, WEEKDAYS, WEEKDAY_LONG } from "../../domain/types";

// Month grid of the date popover. Pure calendar arithmetic on YYYY-MM-DD strings:
// no zone is involved, because "today" is passed in by the caller.

interface CalDay {
	date: LocalDate;
	inMonth: boolean;
}

export const WEEKDAY_NAMES = WEEKDAYS.map((d) => WEEKDAY_LONG[d]);



/** Whole weeks (4 to 6 rows) covering the month, starting on the week-start day. */
export function monthGrid(ym: YearMonth, weekStart: WeekStart): CalDay[] {
	const first = monthStart(ym);
	const prefix = first.slice(0, 8);
	return domainMonthGrid(first, weekStart)
		.flat()
		.map((date) => ({ date, inMonth: date.startsWith(prefix) }));
}

/** Moves a date by whole months, clamping the day (31 January + 1 month = 28 February). */
export function shiftDateByMonths(date: LocalDate, delta: number): LocalDate {
	const ym = shiftMonth(yearMonthOf(date), delta);
	const day = Math.min(Number(date.slice(8, 10)), monthLength(ym.year, ym.month));
	return dateOf(dayNumOf(ym.year, ym.month, day));
}

/** "Thursday, October 1" for the accessible name of a day. */
export function dayLabel(date: LocalDate): string {
	return `${WEEKDAY_NAMES[isoWeekdayOf(date) - 1] ?? ""}, ${monthDayText(date, true)}`;
}
