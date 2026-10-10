import type { WeekStart } from "../../app/settings";
import { monthGrid as domainMonthGrid } from "../../domain/calendar";
import { isoWeekdayOf } from "../../domain/time";
import { type LocalDate, WEEKDAYS, WEEKDAY_LONG } from "../../domain/types";
import { pad2 } from "../format";

// Month grid of the date popover. Pure calendar arithmetic on YYYY-MM-DD strings:
// no zone is involved, because "today" is passed in by the caller.

interface CalDay {
	date: LocalDate;
	inMonth: boolean;
}

export interface YearMonth {
	year: number;
	/** 1 to 12. */
	month: number;
}

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;

export const WEEKDAY_NAMES = WEEKDAYS.map((d) => WEEKDAY_LONG[d]);

export function yearMonthOf(date: LocalDate): YearMonth {
	return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) };
}

export function monthTitle(ym: YearMonth): string {
	return `${MONTH_NAMES[ym.month - 1] ?? ""} ${ym.year}`;
}

export function shiftMonth(ym: YearMonth, delta: number): YearMonth {
	const index = ym.year * 12 + (ym.month - 1) + delta;
	return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function daysInMonth(ym: YearMonth): number {
	return new Date(Date.UTC(ym.year, ym.month, 0)).getUTCDate();
}

/** Whole weeks (4 to 6 rows) covering the month, starting on the week-start day. */
export function monthGrid(ym: YearMonth, weekStart: WeekStart): CalDay[] {
	const prefix = `${ym.year}-${pad2(ym.month)}-`;
	return domainMonthGrid(`${prefix}01`, weekStart)
		.flat()
		.map((date) => ({ date, inMonth: date.startsWith(prefix) }));
}

/** Moves a date by whole months, clamping the day (31 January + 1 month = 28 February). */
export function shiftDateByMonths(date: LocalDate, delta: number): LocalDate {
	const ym = shiftMonth(yearMonthOf(date), delta);
	const day = Math.min(Number(date.slice(8, 10)), daysInMonth(ym));
	return `${ym.year}-${pad2(ym.month)}-${pad2(day)}`;
}

/** "Thursday, October 1" for the accessible name of a day. */
export function dayLabel(date: LocalDate): string {
	const ym = yearMonthOf(date);
	return `${WEEKDAY_NAMES[isoWeekdayOf(date) - 1] ?? ""}, ${MONTH_NAMES[ym.month - 1] ?? ""} ${Number(date.slice(8, 10))}`;
}
