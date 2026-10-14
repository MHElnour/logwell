import { formatLatin, instantInZone, isValidZone, sameDateSpec, wallTimeOf, wallTimeToDateTime } from "../time";
import type { DateSpec, Priority, Task, TaskStatus } from "../types";
import type { TtTask } from "./types";

// The pure field mapping between a Logwell task and a TickTick task. No I/O. Tag names are
// mapped in `tags.ts`.

// ---------------------------------------------------------------------------------------------------------------
// Priority, status, what syncs

/** TickTick 5/3/1/0 (high/medium/low/none) to Logwell 1/2/3/0. Anything else reads as none. */
export function priorityFromTt(value: number | undefined): Priority {
	switch (value) {
		case 5:
			return 1;
		case 3:
			return 2;
		case 1:
			return 3;
		default:
			return 0;
	}
}

export function priorityToTt(priority: Priority): number {
	switch (priority) {
		case 1:
			return 5;
		case 2:
			return 3;
		case 3:
			return 1;
		default:
			return 0;
	}
}

/** 0 is open; 2 (completed) and -1 (won't do) are completed. Read `status` only: `completedTime` stays set after a reopen. */
export function statusFromTt(status: number | undefined): TaskStatus {
	return status === 2 || status === -1 ? "completed" : "open";
}

export function statusToTt(status: TaskStatus): number {
	return status === "completed" ? 2 : 0;
}

/** A TickTick note and a repeating task (non-empty `repeatFlag`) never sync. A checklist task does. */
export function isSyncable(task: Pick<TtTask, "kind" | "repeatFlag">): boolean {
	if (task.kind === "NOTE") return false;
	return task.repeatFlag === undefined || task.repeatFlag === "";
}

// ---------------------------------------------------------------------------------------------------------------
// The one date

/** The date that goes up: the deadline if set, else the schedule. */
export function syncDateOf(task: Pick<Task, "scheduled" | "deadline">): DateSpec | null {
	return task.deadline ?? task.scheduled;
}

export interface TtDateFields {
	startDate: string;
	dueDate: string;
	isAllDay: boolean;
	timeZone: string;
}

/** `2026-10-08T00:00:00+0300`: the format of the recorded requests. */
const TT_DATE_FORMAT = "yyyy-MM-dd'T'HH:mm:ssZZZ";

const MEMO_MAX = 32_768;
/** "wall time|zone" -> the sent text. */
const pushed = new Map<string, string>();
/** "text|isAllDay|zone" -> the Logwell date. Specs are plain values; callers get a copy. */
const pulled = new Map<string, DateSpec | null>();

/**
 * A Logwell date as TickTick fields. A date goes up as local midnight of `displayZone`; a datetime as its wall time
 * in its own zone. TickTick keeps one instant, so `startDate` equals `dueDate` (a span is not kept).
 */
export function dateToTt(spec: DateSpec, displayZone: string): TtDateFields {
	const allDay = spec.kind === "date";
	const zone = spec.kind === "date" ? displayZone : spec.tz;
	const local = spec.kind === "date" ? `${spec.date}T00:00` : spec.local;
	// Luxon is the cost here, and a list holds a few hundred distinct days: memoized by (wall time, zone).
	const key = `${local}|${zone}`;
	let sent = pushed.get(key);
	if (sent === undefined) {
		sent = formatLatin(wallTimeToDateTime(local, zone), TT_DATE_FORMAT);
		if (pushed.size >= MEMO_MAX) pushed.clear();
		pushed.set(key, sent);
	}
	return { startDate: sent, dueDate: sent, isAllDay: allDay, timeZone: zone };
}

/**
 * A TickTick date as a Logwell date. An all-day task is the date in the task's own zone; a timed one is the wall
 * time there plus that zone. `fallbackZone` stands in for a missing or unknown `timeZone`. No date, or one that does
 * not parse, is null.
 */
export function dateFromTt(
	task: Pick<TtTask, "startDate" | "dueDate" | "isAllDay" | "timeZone">,
	fallbackZone: string,
): DateSpec | null {
	// isFloating is not handled: floating tasks were not observed in the recordings.
	const text = task.dueDate ?? task.startDate;
	if (text === undefined) return null;
	const zone = task.timeZone !== undefined && isValidZone(task.timeZone) ? task.timeZone : fallbackZone;
	const allDay = task.isAllDay === true;
	const key = `${text}|${allDay ? 1 : 0}|${zone}`;
	let spec = pulled.get(key);
	if (spec === undefined) {
		spec = readTtDate(text, allDay, zone);
		if (pulled.size >= MEMO_MAX) pulled.clear();
		pulled.set(key, spec);
	}
	return spec === null ? null : { ...spec };
}

function readTtDate(text: string, allDay: boolean, zone: string): DateSpec | null {
	const inZone = instantInZone(text, zone);
	if (!inZone.isValid) return null;
	if (allDay) {
		const day = inZone.toISODate();
		return day === null ? null : { kind: "date", date: day };
	}
	return { kind: "datetime", local: wallTimeOf(inZone), tz: zone };
}

export interface DatePatch {
	scheduled?: DateSpec | null;
	deadline?: DateSpec | null;
}

/**
 * What a pulled TickTick date changes on the Logwell task. A new task (`current` null), or one with neither date,
 * gets it as both schedule and deadline. An existing one moves the date that was sent (the deadline if set, else the
 * schedule), and the schedule too when it equalled the deadline. A date cleared there (null) clears both: a schedule
 * left alone would be the date sent, and go back up. A field that already holds the value is left out.
 */
export function pulledDatePatch(
	current: Pick<Task, "scheduled" | "deadline"> | null,
	pulled: DateSpec | null,
): DatePatch {
	if (current === null) return { scheduled: pulled, deadline: pulled };
	if (current.scheduled === null && current.deadline === null) return pulled === null ? {} : { scheduled: pulled, deadline: pulled };
	const patch: DatePatch = {};
	if (pulled === null) {
		if (current.scheduled !== null) patch.scheduled = null;
		if (current.deadline !== null) patch.deadline = null;
		return patch;
	}
	if (current.deadline !== null) {
		if (!sameDateSpec(current.deadline, pulled)) patch.deadline = pulled;
		if (sameDateSpec(current.scheduled, current.deadline) && !sameDateSpec(current.scheduled, pulled)) patch.scheduled = pulled;
	} else if (!sameDateSpec(current.scheduled, pulled)) {
		patch.scheduled = pulled;
	}
	return patch;
}

// ---------------------------------------------------------------------------------------------------------------
// Change detection

/** The mapped values of one task that the sync compares. Ids for `parent` and `section` are the caller's namespace. */
export interface SyncFields {
	title: string;
	status: TaskStatus;
	priority: Priority;
	date: DateSpec | null;
	parent: string | null;
	section: string | null;
	/** The TickTick tag names (lowercase leaves), compared as a set. */
	tags: readonly string[];
}

function isList(value: unknown): value is readonly string[] {
	return Array.isArray(value);
}

function canonical(value: SyncFields[keyof SyncFields]): string {
	if (isList(value)) return JSON.stringify([...new Set(value)].sort());
	if (value !== null && typeof value === "object") {
		return value.kind === "date" ? `date:${value.date}` : `datetime:${value.local}|${value.tz}`;
	}
	return JSON.stringify(value);
}

/** FNV-1a, 32 bit, over the UTF-8 bytes, as 8 hex digits. */
function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(text)) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** A short stable hash per field. Equal values always hash equal; the keys are visited in sorted order. */
export function fieldHashes(fields: SyncFields): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of Object.keys(fields).sort() as (keyof SyncFields)[]) out[key] = fnv1a(canonical(fields[key]));
	return out;
}

/** The hash of the tags field alone (as `fieldHashes` gives it). */
export function tagsHash(names: readonly string[]): string {
	return fnv1a(canonical(names));
}
