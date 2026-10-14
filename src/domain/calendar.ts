import { DateTime } from "luxon";
import { isDeadlineMissed } from "./queries";
import { occurrenceSpec, projectOccurrences } from "./recurrence";
import { compareTasksBySortKey, isOpen } from "./tasks";
import { addDays, clockTimeOf, dateOf, dateSpecDate, dateSpecDisplayLocal, dayNum, daysBetween, fmtMin, wallTimeToDateTime, weekStartOfDay } from "./time";
import type { DateSpec, ID, LocalDate, OccurrenceRecord, Task, WeekStart } from "./types";

// Calendar layout. Pure: the caller filters
// the tasks (trash, filter bar); everything here places what it is given.
//
// Grid model: every day column has 24 wall-clock hour rows. A block sits
// at its start's wall time in the display zone and is as tall as its elapsed
// planned duration, so a 60 minute task is 60 minutes tall on a DST day too.

/** Lives in ./types; re-exported for the importers of this module. */
export type { WeekStart } from "./types";

/** The first day of the week that contains `date`. */
export function weekStartOf(date: LocalDate, weekStart: WeekStart): LocalDate {
	return dateOf(weekStartOfDay(dayNum(date), weekStart));
}

/** The 7 dates of the week that contains `anchor`. */
export function weekDays(anchor: LocalDate, weekStart: WeekStart): LocalDate[] {
	const first = weekStartOf(anchor, weekStart);
	return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/**
 * The whole weeks that cover the month of `anchor`: as many rows as the month
 * needs (4 to 6; February 2026 with a Sunday start is exactly 4).
 */
export function monthGrid(anchor: LocalDate, weekStart: WeekStart): LocalDate[][] {
	const first = `${anchor.slice(0, 7)}-01`;
	const last = addDays(DateTime.fromISO(first, { zone: "UTC" }).plus({ months: 1 }).toISODate() ?? first, -1);
	const start = weekStartOf(first, weekStart);
	const rows = Math.floor(daysBetween(start, last) / 7) + 1;
	return Array.from({ length: rows }, (_, r) => Array.from({ length: 7 }, (_, c) => addDays(start, r * 7 + c)));
}

export interface DayHours {
	date: LocalDate;
	lengthMin: number;
	skipped: { startMin: number; endMin: number } | null;
	repeated: { startMin: number; endMin: number } | null;
}

function offsetAt(startMs: number, minutes: number, zone: string): number {
	return DateTime.fromMillis(startMs + minutes * 60_000, { zone }).offset;
}

/**
 * The shape of one day's hour rows. Computed from the zone's UTC offsets,
 * not from a fixed clock time, so a 30 minute shift (Australia/Lord_Howe) works.
 */
export function dayHours(date: LocalDate, zone: string): DayHours {
	const start = DateTime.fromISO(date, { zone }).startOf("day");
	if (!start.isValid) throw new RangeError(`Invalid date ${date} or zone ${zone}`);
	const next = start.plus({ days: 1 }).startOf("day");
	const lengthMin = Math.round((next.toMillis() - start.toMillis()) / 60_000);
	// startOf("day") lands after a gap that covers local midnight.
	const startWall = start.hour * 60 + start.minute;
	let skipped: DayHours["skipped"] = startWall > 0 ? { startMin: 0, endMin: startWall } : null;
	let repeated: DayHours["repeated"] = null;

	const before = start.offset;
	const after = next.offset;
	if (before !== after) {
		// The first elapsed minute with the new offset; offsets are monotonic within a day.
		const startMs = start.toMillis();
		let lo = 0;
		let hi = lengthMin;
		while (hi - lo > 1) {
			const mid = Math.floor((lo + hi) / 2);
			if (offsetAt(startMs, mid, zone) === before) lo = mid;
			else hi = mid;
		}
		// hi === lengthMin: the transition is the end of the day (the gap swallows the next
		// local midnight, so `next` is the first instant after the gap). This day is a plain
		// 24 h one; the gap belongs to the next day, which reports it from 00:00.
		if (hi < lengthMin) {
			const shift = after - before;
			const transitionWall = startWall + hi;
			if (shift > 0) skipped = { startMin: transitionWall, endMin: transitionWall + shift };
			else repeated = { startMin: transitionWall + shift, endMin: transitionWall };
		}
	}
	return { date, lengthMin, skipped, repeated };
}

export interface CalendarContext {
	zone: string;
	today: LocalDate;
	/** ISO instant. */
	now: string;
	/** The "Week starts on" setting; weekly repeats with an interval count weeks from it. */
	weekStart: WeekStart;
	/** The occurrence records by task (indexOccurrenceRecords), for the projection of repeating tasks. */
	records: ReadonlyMap<ID, readonly OccurrenceRecord[]>;
}

/**
 * What an entry stands for. null for a plain task. A repeating task shows each occurrence: the
 * "current" one (the next to do), "future" ones after it, and "done" ones (struck through like a completed
 * task). Skipped occurrences are never shown, so "skipped" does not occur in a layout. "missed" is a generated
 * past date after the current one of an overdue series (completing it skips them): drawn like a future occurrence
 * with the overdue tint.
 */
export type OccurrenceKind = "current" | "future" | "done" | "skipped" | "missed";

export type AllDayEntry =
	| { kind: "date"; task: Task; date: LocalDate; past: boolean; occurrence: OccurrenceKind | null }
	| { kind: "deadline"; task: Task; date: LocalDate; missed: boolean; occurrence: null };

export interface TimedSegment {
	task: Task;
	date: LocalDate;
	startMin: number;
	endMin: number;
	durationMin: number;
	noDuration: boolean;
	continued: boolean;
	past: boolean;
	/** See OccurrenceKind. */
	occurrence: OccurrenceKind | null;
	/**
	 * "HH:mm" in the display zone: the real end (start instant plus the planned elapsed duration, 30
	 * minutes when none) of the whole block, the same on both halves of a split block. On a DST day
	 * this differs from `startMin + durationMin` as wall-clock arithmetic.
	 */
	endLocal: string;
	column: number;
	columns: number;
}

export interface WeekLayout {
	days: LocalDate[];
	allDay: Map<LocalDate, AllDayEntry[]>;
	timed: Map<LocalDate, TimedSegment[]>;
	hours: DayHours[];
}

const DEFAULT_DURATION_MIN = 30;
const NO_RECORDS: readonly OccurrenceRecord[] = [];
const DAY_MIN = 1440;

function wallMinutes(local: string): number {
	return Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
}

/**
 * Display and stored wall dates of one instant differ by at most 2 days: the zone offsets span
 * UTC-12 to UTC+14, 26 hours. The range pre-check widens by this much on both sides.
 */
const ZONE_SHIFT_DAYS = 2;

function compareAllDay(a: AllDayEntry, b: AllDayEntry): number {
	if (a.kind !== b.kind) return a.kind === "date" ? -1 : 1;
	return compareTasksBySortKey(a.task, b.task);
}

function compareSegments(a: TimedSegment, b: TimedSegment): number {
	if (a.startMin !== b.startMin) return a.startMin - b.startMin;
	const la = a.endMin - a.startMin;
	const lb = b.endMin - b.startMin;
	if (la !== lb) return lb - la;
	return compareTasksBySortKey(a.task, b.task);
}

/**
 * Greedy interval colouring over segments sorted by start. A cluster is
 * a run of segments connected by overlaps; end == start does not overlap.
 */
function assignColumns(sorted: TimedSegment[]): void {
	let cluster: TimedSegment[] = [];
	let columnEnds: number[] = [];
	let clusterEnd = -1;
	const close = (): void => {
		for (const s of cluster) s.columns = columnEnds.length;
		cluster = [];
		columnEnds = [];
	};
	for (const s of sorted) {
		if (cluster.length > 0 && s.startMin >= clusterEnd) close();
		let col = columnEnds.findIndex((end) => end <= s.startMin);
		if (col === -1) {
			col = columnEnds.length;
			columnEnds.push(s.endMin);
		} else {
			columnEnds[col] = s.endMin;
		}
		s.column = col;
		clusterEnd = cluster.length === 0 ? s.endMin : Math.max(clusterEnd, s.endMin);
		cluster.push(s);
	}
	close();
}

/**
 * Places tasks on the visible days. Tasks and subtasks are treated alike.
 * - `past`: a date-only entry is past when its date is before today; a
 *   timed entry is past when the end instant of the whole block (start plus
 *   duration, 30 minutes when none) is before `now`, so both halves of a split
 *   block agree. Completed tasks are never past or missed (the flag is a
 *   warning about open work).
 * - A timed task contributes to every visible day it covers, including the
 *   continued part of a block that started before the first visible day.
 */
export function layoutWeek(tasks: Iterable<Task>, days: LocalDate[], ctx: CalendarContext): WeekLayout {
	const allDay = new Map<LocalDate, AllDayEntry[]>();
	const timed = new Map<LocalDate, TimedSegment[]>();
	for (const d of days) {
		allDay.set(d, []);
		timed.set(d, []);
	}
	const hours = days.map((d) => dayHours(d, ctx.zone));
	if (days.length === 0) return { days, allDay, timed, hours };

	let minDay = days[0] as LocalDate;
	let maxDay = minDay;
	for (const d of days) {
		if (d < minDay) minDay = d;
		if (d > maxDay) maxDay = d;
	}
	const nowMs = DateTime.fromISO(ctx.now).toMillis();
	const queryCtx = { today: ctx.today, zone: ctx.zone, upcomingDays: 0, weekStart: ctx.weekStart };
	// Cheap pre-check for tasks far outside the visible days (most of a large store): compare the
	// stored date, with no Luxon call, before doing any zone math.
	const minNum = dayNum(minDay) - ZONE_SHIFT_DAYS;
	const maxNum = dayNum(maxDay) + ZONE_SHIFT_DAYS;

	// A timed block may start before the first day and still cover it: widen the lower bound by the
	// whole days of its duration (plus one for the split of the first day).
	const inRange = (local: string, durationMin: number | null): boolean => {
		const n = dayNum(local);
		const extra = durationMin !== null && durationMin > 0 ? Math.ceil(durationMin / DAY_MIN) + 1 : 0;
		return n <= maxNum && n + extra >= minNum;
	};

	// Places one scheduled value: a plain task's own, or one occurrence of a repeating task.
	const place = (task: Task, scheduled: DateSpec, occurrence: OccurrenceKind | null): void => {
		// Open work only: a completed task, or a done occurrence of a series that goes on, is never past.
		let open: boolean | null = null;
		const isOpenWork = (): boolean => (open ??= isOpen(task) && occurrence !== "done");
		if (scheduled.kind === "date") {
			const list = allDay.get(scheduled.date);
			if (list !== undefined) list.push({ kind: "date", task, date: scheduled.date, past: isOpenWork() && scheduled.date < ctx.today, occurrence });
		} else if (inRange(scheduled.local, task.plannedDurationMin)) {
			// One Luxon parse per task. In the display zone itself the stored wall time is the answer.
			const sameZone = scheduled.tz === ctx.zone;
			const startDt = wallTimeToDateTime(scheduled.local, scheduled.tz);
			const shown = sameZone ? startDt : startDt.setZone(ctx.zone);
			const startDate = sameZone ? scheduled.local.slice(0, 10) : (shown.toISODate() ?? maxDay);
			if (shown.isValid && startDate <= maxDay) {
				const noDuration = task.plannedDurationMin === null || task.plannedDurationMin <= 0;
				const durationMin = noDuration ? DEFAULT_DURATION_MIN : (task.plannedDurationMin as number);
				const startMin = sameZone ? wallMinutes(scheduled.local) : shown.hour * 60 + shown.minute;
				// Segment i covers day startDate + i: the rest of the first day, then whole days.
				const firstLen = Math.min(durationMin, DAY_MIN - startMin);
				const count = 1 + Math.ceil(Math.max(0, durationMin - firstLen) / DAY_MIN);
				const lo = startDate >= minDay ? 0 : daysBetween(startDate, minDay);
				let hi = count - 1;
				if (hi > 0) hi = Math.min(hi, daysBetween(startDate, maxDay));
				let past = false;
				let endLocal: string | null = null;
				for (let i = lo; i <= hi; i++) {
					const day = i === 0 ? startDate : addDays(startDate, i);
					const list = timed.get(day);
					if (list === undefined) continue;
					if (endLocal === null) {
						// Elapsed arithmetic on the instant, so DST days come out right.
						const endMs = startDt.toMillis() + durationMin * 60_000;
						past = isOpenWork() && endMs < nowMs;
						const end = DateTime.fromMillis(endMs, { zone: ctx.zone });
						endLocal = fmtMin(end.isValid ? end.hour * 60 + end.minute : (startMin + durationMin) % DAY_MIN);
					}
					const from = i === 0 ? startMin : 0;
					const length = i === 0 ? firstLen : Math.min(DAY_MIN, durationMin - firstLen - DAY_MIN * (i - 1));
					list.push({
						task,
						date: day,
						startMin: from,
						endMin: from + length,
						durationMin,
						noDuration,
						continued: i > 0,
						past,
						occurrence,
						endLocal,
						column: 0,
						columns: 1,
					});
				}
			}
		}
	};

	for (const task of tasks) {
		if (task.recurrence === null) {
			// A plain task: its own schedule. The one raw read of `scheduled` here, because nothing is derived.
			if (task.scheduled !== null) place(task, task.scheduled, null);
		} else {
			// Every occurrence in range. The window is widened like the zone pre-check and a timed block
			// that started before the first day; a skipped occurrence is not shown.
			const extra = task.plannedDurationMin !== null && task.plannedDurationMin > 0 ? Math.ceil(task.plannedDurationMin / DAY_MIN) + 1 : 0;
			const from = addDays(minDay, -(ZONE_SHIFT_DAYS + extra));
			const to = addDays(maxDay, ZONE_SHIFT_DAYS);
			for (const o of projectOccurrences(task, ctx.records.get(task.id) ?? NO_RECORDS, from, to, ctx.weekStart, ctx.today)) {
				if (o.kind !== "skipped") place(task, occurrenceSpec(task.recurrence, o.date), o.kind);
			}
		}
		const deadline = task.deadline;
		if (deadline !== null && (deadline.kind === "date" || inRange(deadline.local, null))) {
			const date = dateSpecDate(deadline, ctx.zone);
			allDay.get(date)?.push({ kind: "deadline", task, date, missed: isDeadlineMissed(task, queryCtx), occurrence: null });
		}
	}

	for (const list of allDay.values()) list.sort(compareAllDay);
	for (const list of timed.values()) {
		list.sort(compareSegments);
		assignColumns(list);
	}
	return { days, allDay, timed, hours };
}

export interface MonthCell {
	date: LocalDate;
	inMonth: boolean;
	count: number;
	shown: (AllDayEntry | TimedSegment)[];
	more: number;
}

/**
 * Month cells. Each cell counts its distinct entries: date entries, timed
 * blocks (by their start day; the continued half of a block that crossed
 * midnight is the same entry) and deadlines. Titles are shown in that order.
 */
export function layoutMonth(
	tasks: Iterable<Task>,
	grid: LocalDate[][],
	month: string,
	ctx: CalendarContext,
	maxTitles = 3,
): MonthCell[][] {
	const layout = layoutWeek(tasks, grid.flat(), ctx);
	return grid.map((row) =>
		row.map((date) => {
			const allDay = layout.allDay.get(date) ?? [];
			const entries: (AllDayEntry | TimedSegment)[] = [
				...allDay.filter((e) => e.kind === "date"),
				...(layout.timed.get(date) ?? []).filter((s) => !s.continued),
				...allDay.filter((e) => e.kind === "deadline"),
			];
			const shown = entries.slice(0, Math.max(0, maxTitles));
			return {
				date,
				inMonth: date.startsWith(month),
				count: entries.length,
				shown,
				more: entries.length - shown.length,
			};
		}),
	);
}

// Drag helpers. Pure: the UI turns the pointer into a day delta and a minute delta (or
// a target date and slot); these build the value to store. Timed results are always local wall time
// in the display zone (a task stored in another zone is re-anchored); the task service then
// resolves DST gaps and reports the warning.

const DRAG_SNAP_MIN = 15;
const LAST_SLOT_MIN = DAY_MIN - DRAG_SNAP_MIN;

const snapSlot = (min: number): number => Math.min(LAST_SLOT_MIN, Math.max(0, Math.floor(min / DRAG_SNAP_MIN + 0.5) * DRAG_SNAP_MIN));

const wallAt = (date: LocalDate, min: number): string => `${date}T${fmtMin(min)}`;

/** A timed value at `minute` of `date` in `zone`, snapped to 15 minutes and clamped to 00:00..23:45. */
export function slotSpec(date: LocalDate, minute: number, zone: string): DateSpec {
	return { kind: "datetime", local: wallAt(date, snapSlot(minute)), tz: zone };
}

/**
 * The start of a timed value moved by whole days and minutes, seen in the display zone, then
 * snapped and clamped inside the target day. Null for a date-only value (use `moveToDate`).
 */
export function moveTimed(spec: DateSpec, zone: string, dayDelta: number, minuteDelta: number): DateSpec | null {
	const shown = dateSpecDisplayLocal(spec, zone);
	if (shown === null) return null;
	return slotSpec(addDays(shown.slice(0, 10), dayDelta), wallMinutes(shown) + minuteDelta, zone);
}

/** Month view and all-day cells. Date-only stays date-only; a timed value keeps its time of day in the display zone. */
export function moveToDate(spec: DateSpec, date: LocalDate, zone: string): DateSpec {
	if (spec.kind === "date") return { kind: "date", date };
	const shown = dateSpecDisplayLocal(spec, zone) ?? spec.local;
	return { kind: "datetime", local: `${date}T${shown.slice(11, 16)}`, tz: zone };
}

/** True when `next` is the value `current` already shows (same date, or same wall time in the display zone): a no-op drop. */
export function moveSameMoment(current: DateSpec | null, next: DateSpec, zone: string): boolean {
	if (current === null || current.kind !== next.kind) return false;
	if (current.kind === "date" && next.kind === "date") return current.date === next.date;
	return dateSpecDisplayLocal(current, zone) === dateSpecDisplayLocal(next, zone);
}

/**
 * The planned duration after dragging the bottom edge to `rawEndMin` (minutes since midnight of
 * the start day): end snapped to 15 minutes, at least 15 minutes long, at most up to 24:00.
 */
export function resizedDuration(startMin: number, rawEndMin: number): number {
	const snapped = Math.floor(rawEndMin / DRAG_SNAP_MIN + 0.5) * DRAG_SNAP_MIN;
	const end = Math.min(DAY_MIN, Math.max(startMin + DRAG_SNAP_MIN, snapped));
	return end - startMin;
}

/** "10:15–11:00" for a drag ghost: the real end, so a DST day is right. Just the start when there is no duration. */
export function slotRange(local: string, durationMin: number | null, zone: string): string {
	const start = local.slice(11, 16);
	if (durationMin === null || durationMin <= 0) return start;
	const end = DateTime.fromISO(local, { zone }).plus({ minutes: durationMin });
	return `${start}–${end.isValid ? clockTimeOf(end) : fmtMin((wallMinutes(local) + durationMin) % DAY_MIN)}`;
}
