// Entity types. Records are treated as immutable values:
// every change produces a new object, which the serializer's line cache and
// the undo stack rely on.

export type ID = string;
/** ISO 8601 UTC, e.g. "2026-10-01T14:03:22.120Z". */
export type Instant = string;
/** "YYYY-MM-DD". Never converted to an instant. */
export type LocalDate = string;
/** "YYYY-MM-DDTHH:mm" wall time. */
export type LocalDateTime = string;

/** A plain object (not null, not an array), as read from JSON. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type DateSpec =
	| { kind: "date"; date: LocalDate }
	| { kind: "datetime"; local: LocalDateTime; tz: string };

export interface DescriptionNote {
	path: string;
	linkedAt: Instant;
}

export type TaskStatus = "open" | "completed";

/** 0 none, 1 high, 2 medium, 3 low. Independent of urgent/important. */
export type Priority = 0 | 1 | 2 | 3;
export const PRIORITIES: readonly Priority[] = [0, 1, 2, 3];
/** The word for each priority, lowercase: "high" … "none". */
export const PRIORITY_NAME: Readonly<Record<Priority, string>> = { 1: "high", 2: "medium", 3: "low", 0: "none" };

export function isPriority(value: unknown): value is Priority {
	return value === 0 || value === 1 || value === 2 || value === 3;
}

export interface Task {
	id: ID;
	title: string;
	descriptionNote: DescriptionNote | null;
	categoryId: ID;
	tagKeys: string[];
	parentId: ID | null;
	/** The section within the list; null means "No section". */
	sectionId: ID | null;
	scheduled: DateSpec | null;
	deadline: DateSpec | null;
	plannedDurationMin: number | null;
	urgent: boolean;
	important: boolean;
	priority: Priority;
	status: TaskStatus;
	completedAt: Instant | null;
	/** The repeat rule; null = not repeating. A repeating task keeps `scheduled` null. */
	recurrence: Recurrence | null;
	sortKey: string;
	createdAt: Instant;
	modifiedAt: Instant;
}

export const INBOX_ID = "inbox";

export interface Category {
	id: ID;
	name: string;
	/** A Lucide icon name, or a legacy emoji kept as typed. */
	icon: string | null;
	/** The list color; null means the default. */
	color: TagColor | null;
	nameKey: string;
	isInbox: boolean;
	sortKey: string;
	createdAt: Instant;
	modifiedAt: Instant;
}

/** A named group of tasks inside one list (Inbox included). */
export interface Section {
	id: ID;
	categoryId: ID;
	name: string;
	/** Case-insensitive uniqueness key within the list. */
	nameKey: string;
	sortKey: string;
	createdAt: Instant;
	modifiedAt: Instant;
}

export const TAG_COLORS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"] as const;
export type TagColor = (typeof TAG_COLORS)[number];

/** The default color of the next list or tag, rotating through the palette by how many exist. */
export function paletteColor(existing: number): TagColor {
	return TAG_COLORS[((existing % TAG_COLORS.length) + TAG_COLORS.length) % TAG_COLORS.length] as TagColor;
}

export interface Tag {
	key: string;
	displayName: string;
	color: TagColor | null;
	createdAt: Instant;
	/** Lets merge-import pick the newer record. */
	modifiedAt: Instant;
}

export interface TrashEntry {
	batchId: ID;
	deletedAt: Instant;
	/** The deleted task first, then its subtasks. */
	tasks: Task[];
}

// TickTick sync links. Schema v5.

export type SyncLinkKind = "task" | "list" | "section";
export const SYNC_LINK_KINDS: readonly SyncLinkKind[] = ["task", "list", "section"];

/**
 * How a task link takes part in the sync. `sync` (the default): both ways. `excluded`: not
 * synced while the task repeats on either side; resumes once neither repeats. `localOnly`: the user chose Keep for a
 * task missing from TickTick; it stays in Logwell only and never resumes by itself.
 */
export type SyncLinkMode = "sync" | "excluded" | "localOnly";
export const SYNC_LINK_MODES: readonly SyncLinkMode[] = ["sync", "excluded", "localOnly"];

/**
 * One linked Logwell object. Keyed `kind:logwellId` (`syncLinkId`); the key is derived, not stored. Sync
 * bookkeeping lives here so it never changes a task's record or `modifiedAt`.
 */
export interface SyncLink {
	kind: SyncLinkKind;
	/** The task, category or section id. */
	logwellId: ID;
	/** TickTick's id: a task id, project id or column id. */
	ttId: string;
	/** Task and section links: the TickTick project. Null for list links. */
	ttProjectId: string | null;
	etag: string | null;
	/** A short hash per synced field at the last sync. Opaque strings. */
	base: Record<string, string>;
	/** Task links: the description note was created by the sync, and the sync keeps it and TickTick's text in step. */
	noteBySync: boolean;
	/**
	 * Task links: the text of the sync-created note at the last sync, as TickTick has it (`content`, or a
	 * checklist's `desc`), the base of the three-way merge. Absent until the sync makes a note. Present with
	 * `noteBySync` false: the user unlinked or deleted that note, and the sync makes no new one. Optional; omitted when
	 * absent.
	 */
	noteBase?: string;
	/**
	 * Task links: a checklist's items at the last sync, as lines (`- [ ] Title`, `- [x] Title`). No ids:
	 * TickTick gives items new ids on every update. Absent for a normal task. Optional.
	 */
	noteItems?: string[];
	/** List links: the last successful pull. */
	lastPulledAt: Instant | null;
	/**
	 * Task links: the task was purged from Trash before the sync deleted its TickTick copy. The next sync deletes it
	 * there and removes the link. Optional; false is omitted on write.
	 */
	pendingDelete?: boolean;
	/**
	 * Task links: how the task takes part in the sync (`SyncLinkMode`). An `excluded` or `localOnly` link is kept so
	 * neither copy is imported again. Optional; `sync` is omitted on write.
	 */
	mode?: SyncLinkMode;
	/** Set on every write; lets a backup import merge newer-wins. */
	modifiedAt: Instant;
}

export function syncLinkId(kind: SyncLinkKind, logwellId: ID): string {
	return `${kind}:${logwellId}`;
}

/** A stored record the plugin round-trips without interpreting its fields (saved filters). */
export type OpaqueRecord = Record<string, unknown>;

// Focus sessions. One record per finished focus round.

export type FocusStatus = "completed" | "stopped" | "interrupted" | "recovered" | "split";
export const FOCUS_STATUSES: readonly FocusStatus[] = ["completed", "stopped", "interrupted", "recovered", "split"];
export type GapResolution = "pending" | "excluded" | "included";
export const GAP_RESOLUTIONS: readonly GapResolution[] = ["pending", "excluded", "included"];

export interface FocusSegment {
	start: Instant;
	end: Instant;
}

/** Time the plugin could not observe (reload, sleep). Counts only once `included`. */
export interface FocusGap {
	start: Instant;
	end: Instant;
	resolution: GapResolution;
}

export interface FocusSession {
	id: ID;
	deviceId: string;
	taskId: ID | null;
	taskTitleSnapshot: string;
	plannedSec: number;
	status: FocusStatus;
	segments: FocusSegment[];
	unobserved: FocusGap[];
	splitFrom: ID | null;
	/**
	 * The focus set this round belongs to. Optional: older records have none and show
	 * as a one-round set of their own.
	 */
	setId?: ID;
	/** The set's planned number of rounds (for "2 of 4" in the history); written with `setId`. */
	setRounds?: number;
	/** The 1-based round number inside the set, so a dropped or deleted round does not shift the others. */
	setRound?: number;
	startedAt: Instant;
	endedAt: Instant;
	finalizedAt: Instant;
	/**
	 * Stamped by every edit of a finalized record (Include, Exclude, Assign, Remove task), not by
	 * finalizing, so an import merge keeps the edited copy. Optional.
	 */
	modifiedAt?: Instant;
}

// Habits.

/** A weekday, as the database spells it. */
export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
/** ISO order, Monday first; index + 1 is the ISO weekday number. */
export const WEEKDAYS: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
/** "Mon" … "Sun". */
export const WEEKDAY_SHORT: Readonly<Record<Weekday, string>> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };
/** "Monday" … "Sunday". */
export const WEEKDAY_LONG: Readonly<Record<Weekday, string>> = {
	MO: "Monday",
	TU: "Tuesday",
	WE: "Wednesday",
	TH: "Thursday",
	FR: "Friday",
	SA: "Saturday",
	SU: "Sunday",
};
/** The first day of a week (the "Week starts on" setting; versioned per habit). */
export type WeekStart = "MO" | "SU" | "SA";
export const WEEK_STARTS: readonly WeekStart[] = ["MO", "SU", "SA"];

/** Order of ambiguous numeric dates in Quick Add: en = month/day, en-GB = day/month. */
export type DateLocale = "en" | "en-GB";

export type GoalType = "binary" | "count" | "quantity";
export const GOAL_TYPES: readonly GoalType[] = ["binary", "count", "quantity"];
export type GoalPeriod = "day" | "week";
export type TimeOfDay = "morning" | "afternoon" | "evening" | "anytime";
/** The order of the groups. */
export const TIMES_OF_DAY: readonly TimeOfDay[] = ["morning", "afternoon", "evening", "anytime"];

export interface HabitGoal {
	type: GoalType;
	/** 1 for a daily binary habit; a whole number for count; a positive amount for quantity. */
	target: number;
	/** null for binary; optional for count ("8 glasses"); required for quantity ("min"). */
	unit: string | null;
	period: GoalPeriod;
}

export type HabitSchedule = { kind: "daily" } | { kind: "weekdays"; days: Weekday[] } | { kind: "weekly" };

/** One rule of a habit, in effect from `effectiveFrom` until the next version. */
export interface HabitVersion {
	effectiveFrom: LocalDate;
	goal: HabitGoal;
	schedule: HabitSchedule;
	weekStart: WeekStart;
}

/** "HH:MM", the wall time of whichever device is open. */
export interface HabitReminder {
	time: string;
}

export interface Habit {
	id: ID;
	name: string;
	/** A Lucide icon name, or null (the flame shows). */
	icon: string | null;
	/** null shows the accent. */
	color: TagColor | null;
	timeOfDay: TimeOfDay;
	reminder: HabitReminder | null;
	/** Hidden from Today, the strip, the groups and the reminders; history stays. */
	archivedAt: Instant | null;
	sortKey: string;
	createdAt: Instant;
	modifiedAt: Instant;
	/** Sorted by effectiveFrom; at least one. */
	versions: HabitVersion[];
}

/** One check-in: every tap is its own record; soft delete only. */
export interface Checkin {
	id: ID;
	habitId: ID;
	date: LocalDate;
	value: number;
	note: string | null;
	createdAt: Instant;
	modifiedAt: Instant;
	deletedAt: Instant | null;
}

// Recurrence. A repeating task stores its rule here; each resolved
// occurrence is one OccurrenceRecord.

export type RepeatFreq = "daily" | "weekly" | "monthly";
export const REPEAT_FREQS: readonly RepeatFreq[] = ["daily", "weekly", "monthly"];

/** By day of month (29–31 fall back to the month's last day), the Nth weekday, or the last day. */
export type MonthlyOn =
	| { kind: "day"; day: number /* 1..31 */ }
	| { kind: "nth"; n: 1 | 2 | 3 | 4 | -1; weekday: Weekday }
	| { kind: "lastDay" };

export interface RepeatRule {
	freq: RepeatFreq;
	/** Every N days, weeks or months; a whole number >= 1. */
	interval: number;
	/** Weekly only; null = the anchor's weekday. "Every weekday" is MO..FR. */
	weekdays: Weekday[] | null;
	/** Monthly only; null = the anchor's day of month. */
	monthly: MonthlyOn | null;
	/** The next date counts from the completion. Only with weekdays null and monthly null or by day. */
	afterCompletion: boolean;
	/** "HH:mm" wall time, or null = all day. */
	time: string | null;
	/** The IANA zone of `time`; null exactly when `time` is null. */
	tz: string | null;
	/**
	 * Weekly only: the week start the rule was made with, so "every 2 weeks" keeps its weeks when the
	 * "Week starts on" setting changes. Optional, written only when present; without it the setting applies.
	 */
	weekStart?: WeekStart;
}

/** One rule of a series, in force from `effectiveFrom` until the next version. */
export interface RepeatVersion {
	effectiveFrom: LocalDate;
	rule: RepeatRule;
}

export type RepeatEnd = { kind: "never" } | { kind: "date"; date: LocalDate } | { kind: "count"; count: number };

export interface Recurrence {
	/** The first occurrence date; no occurrence is ever generated before it. */
	anchor: LocalDate;
	/** Sorted by effectiveFrom, at least one. */
	versions: RepeatVersion[];
	/** A count counts every record (done and skipped). */
	end: RepeatEnd;
	/** Set by "Stop repeating" or when `end` is reached; the task is then completed. */
	endedAt: Instant | null;
	/**
	 * When the anchor was last set by a move of the series (a schedule edit). After completion then
	 * counts only from records resolved after it. Absent: the anchor dates from the series' creation.
	 * Optional and written only when present, so schema v4 files without it are unchanged.
	 */
	anchoredAt?: Instant;
	/**
	 * When a task with records from an earlier repeat was made to repeat again. A count end then counts
	 * only records resolved after it. Moves never set it, so a move keeps the count. Optional, written only
	 * when present.
	 */
	countFrom?: Instant;
}

export type OccurrenceStatus = "done" | "skipped";

/** One resolved occurrence. Stored id: `${taskId}:${occurrenceDate}`. */
export interface OccurrenceRecord {
	taskId: ID;
	occurrenceDate: LocalDate;
	status: OccurrenceStatus;
	resolvedAt: Instant;
	/** True for the past occurrences that a catch-up completion skipped. */
	auto: boolean;
	/**
	 * The local day the record was resolved: completed (done) or skipped by hand. After completion counts
	 * from it (a skip counts from the skip day). Null for automatic skips (and for some older records);
	 * those count from their date.
	 */
	completedOn: LocalDate | null;
}
