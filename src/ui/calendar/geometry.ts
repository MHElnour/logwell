import { instantInZone } from "../../domain/time";

/** One hour row of the week grid. Keep equal to `--cp-cal-hour` in styles.css (a test checks it). */
export const HOUR_PX = 48;

/**
 * Blocks shorter than this (visible minutes) get one line: two lines of text need about 33 px, and a
 * block is `HOUR_PX * len / 60 - 2` tall, so 45 minutes (34 px) is the shortest that holds two.
 */
export const SHORT_BLOCK_MIN = 45;

/** Entries shown per all-day cell before "+k more", as in the month view. */
export const ALLDAY_LIMIT = 3;

/**
 * Hour labels are centred on their line (`top: -0.55em` of 11 px, about 6 px above it). The grid
 * scrolls to an hour line minus this much, so the label of the first visible hour is never cut by
 * the sticky header. Keep at least half the label height (see the stylesheet test).
 */
export const LABEL_PEEK_PX = 7;

const WORKDAY_START_MIN = 7 * 60;

/** Wall-clock minutes since midnight of an instant in the display zone. */
export function nowMinutes(nowIso: string, zone: string): number {
	const t = instantInZone(nowIso, zone);
	return t.hour * 60 + t.minute;
}

/**
 * Scroll to 07:00, or the hour line at or before one hour before now when that is later and today
 * is in view; a few pixels earlier than that hour line, so the hour's label stays whole under the sticky rows.
 */
export function initialScrollTop(nowMin: number, todayVisible: boolean): number {
	const start = todayVisible ? Math.max(WORKDAY_START_MIN, nowMin - 60) : WORKDAY_START_MIN;
	// Snap down to the hour line: mid-hour, the label above would sit cut under the sticky rows.
	return Math.max(0, Math.floor(start / 60) * HOUR_PX - LABEL_PEEK_PX);
}
