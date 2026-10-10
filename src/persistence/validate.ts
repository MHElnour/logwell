import { isValidTagKey } from "../domain/tags";
import { isInstant, isValidDateSpec, isValidLocalDate, isValidZone } from "../domain/time";
import { isClockTime } from "../domain/habits";
import type {
	Category,
	Checkin,
	FocusGap,
	FocusSession,
	FocusStatus,
	GapResolution,
	GoalType,
	Habit,
	HabitGoal,
	HabitSchedule,
	HabitVersion,
	MonthlyOn,
	OccurrenceRecord,
	OpaqueRecord,
	Recurrence,
	RepeatEnd,
	RepeatFreq,
	RepeatRule,
	RepeatVersion,
	Section,
	SyncLink,
	SyncLinkKind,
	SyncLinkMode,
	Tag,
	TagColor,
	Task,
	TimeOfDay,
	TrashEntry,
	WeekStart,
	Weekday,
} from "../domain/types";
import {
	FOCUS_STATUSES,
	GAP_RESOLUTIONS,
	GOAL_TYPES,
	INBOX_ID,
	REPEAT_FREQS,
	SYNC_LINK_KINDS,
	SYNC_LINK_MODES,
	TAG_COLORS,
	TIMES_OF_DAY,
	WEEKDAYS,
	WEEK_STARTS,
	isPriority,
	isRecord,
} from "../domain/types";
import { categoryNameKey } from "../domain/tasks";
import { MAX_INTERVAL } from "../domain/recurrence";
import { compareSortKeys } from "../domain/sortKey";
import {
	COLLECTIONS,
	type CollectionName,
	CURRENT_SCHEMA_VERSION,
	DB_FORMAT,
	type DbData,
	type DbMeta,
	emptyCollections,
	expandRecord,
	inboxCategory,
	isSafeId,
	recordId,
} from "./schema";

// Load-time validation (each collection has its own validator and
// a damaged collection is reported by name). Structural errors throw;
// referential problems are repaired and reported as issues.

export class CollectionError extends Error {
	constructor(
		readonly collection: CollectionName | "header",
		readonly recordKey: string | null,
		detail: string,
	) {
		super(`${collection}${recordKey === null ? "" : ` [${recordKey}]`}: ${detail}`);
		this.name = "CollectionError";
	}
}

type Obj = Record<string, unknown>;

class RecordReader {
	constructor(
		private readonly collection: CollectionName,
		private readonly key: string,
		private readonly obj: Obj,
	) {}

	fail(detail: string): never {
		throw new CollectionError(this.collection, this.key, detail);
	}

	string(field: string): string {
		const v = this.obj[field];
		if (typeof v !== "string") this.fail(`"${field}" must be a string`);
		return v;
	}

	nonEmptyString(field: string): string {
		const v = this.string(field);
		if (v.length === 0) this.fail(`"${field}" must not be empty`);
		return v;
	}

	optString(field: string): string | null {
		const v = this.obj[field];
		if (v === null || v === undefined) return null;
		if (typeof v !== "string") this.fail(`"${field}" must be a string or null`);
		return v;
	}

	boolean(field: string): boolean {
		const v = this.obj[field];
		if (typeof v !== "boolean") this.fail(`"${field}" must be true or false`);
		return v;
	}

	stringArray(field: string): string[] {
		const v = this.obj[field];
		if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) this.fail(`"${field}" must be a list of strings`);
		return [...v];
	}
}

function asObject(collection: CollectionName, value: unknown, index: number): Obj {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CollectionError(collection, `#${index}`, "record is not an object");
	}
	return expandRecord(collection, value as Obj);
}

/** A list or tag color. An unknown one is cleared with an issue naming `owner`. */
function readTagColor(r: RecordReader, owner: string, issues: string[]): TagColor | null {
	const raw = r.optString("color");
	if (raw === null) return null;
	if ((TAG_COLORS as readonly string[]).includes(raw)) return raw as TagColor;
	issues.push(`${owner}: unknown color "${raw}" was cleared.`);
	return null;
}

function readCategory(o: Obj, key: string, issues: string[]): Category {
	const r: RecordReader = new RecordReader("categories", key, o);
	const name = r.nonEmptyString("name");
	const color = readTagColor(r, `List "${name}"`, issues);
	return {
		id: r.nonEmptyString("id"),
		name,
		icon: r.optString("icon"),
		color,
		nameKey: isNonEmptyString(o.nameKey) ? o.nameKey : categoryNameKey(name),
		isInbox: r.boolean("isInbox"),
		sortKey: r.string("sortKey"),
		createdAt: r.string("createdAt"),
		modifiedAt: r.string("modifiedAt"),
	};
}

/**
 * A damaged section is dropped with an issue instead of failing the
 * whole load. Its tasks are cleared by `repairReferences`. A section's stored
 * `nameKey` is never trusted: it is recomputed from the name, and a
 * different stored one is reported. (A list keeps a non-empty stored `nameKey`;
 * readCategory computes one only when it is missing.)
 */
function readSection(o: Obj, issues: string[]): Section | null {
	const str = (f: string): string | null => {
		const v = o[f];
		return typeof v === "string" ? v : null;
	};
	const nonEmpty = (f: string): string | null => {
		const v = str(f);
		return v !== null && v.length > 0 ? v : null;
	};
	const id = nonEmpty("id");
	const name = nonEmpty("name");
	const categoryId = nonEmpty("categoryId");
	const sortKey = str("sortKey");
	const label = name !== null ? `"${name}"` : id !== null ? `(${id})` : "(unnamed)";
	if (id === null || name === null || categoryId === null || sortKey === null) {
		issues.push(`Section ${label} was damaged and has been removed; its tasks moved to No section.`);
		return null;
	}
	const nameKey = categoryNameKey(name);
	if (isNonEmptyString(o.nameKey) && o.nameKey !== nameKey) {
		issues.push(`Section "${name}" had a wrong name key; it was recomputed.`);
	}
	return {
		id,
		categoryId,
		name,
		nameKey,
		sortKey,
		createdAt: str("createdAt") ?? "",
		modifiedAt: str("modifiedAt") ?? "",
	};
}

function readTag(o: Obj, key: string, issues: string[]): Tag {
	const r: RecordReader = new RecordReader("tags", key, o);
	const tagKey = r.nonEmptyString("key");
	if (!isValidTagKey(tagKey)) r.fail(`"${tagKey}" is not a valid tag key`);
	const color = readTagColor(r, `Tag "${tagKey}"`, issues);
	const createdAt = r.string("createdAt");
	return {
		key: tagKey,
		displayName: r.nonEmptyString("displayName"),
		color,
		createdAt,
		modifiedAt: r.optString("modifiedAt") ?? createdAt,
	};
}

function readTask(collection: CollectionName, o: Obj, key: string, issues: string[]): Task {
	const r: RecordReader = new RecordReader(collection, key, o);
	const scheduled = o.scheduled ?? null;
	let deadline = o.deadline ?? null;
	if (scheduled !== null && !isValidDateSpec(scheduled)) r.fail(`"scheduled" is not a valid date`);
	if (deadline !== null && !isValidDateSpec(deadline)) r.fail(`"deadline" is not a valid date`);
	const recurrence = readRecurrence(o.recurrence ?? null, String(o.title), issues);
	// A repeating task has no deadline; the task pane cannot clear one.
	if (recurrence !== null && deadline !== null) {
		deadline = null;
		issues.push(`Repeating task "${String(o.title)}" had a deadline, which was removed.`);
	}
	const duration = o.plannedDurationMin ?? null;
	if (duration !== null && (typeof duration !== "number" || !Number.isInteger(duration) || duration < 1)) {
		r.fail(`"plannedDurationMin" must be a positive whole number`);
	}
	const priority = o.priority ?? 0;
	if (!isPriority(priority)) r.fail(`"priority" must be 0, 1, 2 or 3`);
	const status = o.status;
	if (status !== "open" && status !== "completed") r.fail(`"status" must be "open" or "completed"`);
	let descriptionNote: Task["descriptionNote"] = null;
	if (o.descriptionNote !== null && o.descriptionNote !== undefined) {
		const n = o.descriptionNote as Obj;
		if (typeof n !== "object" || typeof n.path !== "string" || typeof n.linkedAt !== "string") {
			r.fail(`"descriptionNote" must have a path and linkedAt`);
		}
		descriptionNote = { path: n.path, linkedAt: n.linkedAt };
	}
	// A sectionId that is not a string or null is cleared, not fatal.
	let sectionId: string | null = null;
	if (typeof o.sectionId === "string") sectionId = o.sectionId;
	else if (o.sectionId !== null && o.sectionId !== undefined) {
		issues.push(`Task "${String(o.title)}" had an invalid section and was moved to No section.`);
	}
	return {
		id: r.nonEmptyString("id"),
		title: r.string("title"),
		descriptionNote,
		categoryId: r.nonEmptyString("categoryId"),
		tagKeys: r.stringArray("tagKeys"),
		parentId: r.optString("parentId"),
		sectionId,
		scheduled,
		deadline,
		plannedDurationMin: duration,
		urgent: r.boolean("urgent"),
		important: r.boolean("important"),
		priority,
		status,
		completedAt: r.optString("completedAt"),
		recurrence,
		sortKey: r.string("sortKey"),
		createdAt: r.string("createdAt"),
		modifiedAt: r.string("modifiedAt"),
	};
}

function readTrash(o: Obj, key: string, issues: string[]): TrashEntry {
	const r: RecordReader = new RecordReader("trash", key, o);
	const tasks = o.tasks;
	if (!Array.isArray(tasks) || tasks.length === 0) r.fail(`"tasks" must be a nonempty list`);
	return {
		batchId: r.nonEmptyString("batchId"),
		deletedAt: r.string("deletedAt"),
		tasks: tasks.map((t, i) => {
			if (typeof t !== "object" || t === null) r.fail(`task #${i} is not an object`);
			return readTask("trash", t as Obj, `${key} task #${i}`, issues);
		}),
	};
}

/**
 * Strict like a task. A wrong type fails the load. Unknown fields are kept. A link whose
 * Logwell object is missing is kept silently, like an orphaned check-in: file sync can deliver it
 * before its task.
 */
// The sync treats a link whose task, list or section is missing as not yet arrived, never as a deletion.
function readSyncLink(o: Obj, key: string): SyncLink {
	const r: RecordReader = new RecordReader("syncLinks", key, o);
	const kind = o.kind;
	if (typeof kind !== "string" || !(SYNC_LINK_KINDS as readonly string[]).includes(kind)) {
		r.fail(`"kind" must be "task", "list" or "section"`);
	}
	const strictOptString = (field: string): string | null => {
		const v = o[field];
		if (v !== null && typeof v !== "string") r.fail(`"${field}" must be a string or null`);
		return v;
	};
	const base = o.base;
	if (!isRecord(base) || !Object.values(base).every((v) => typeof v === "string")) {
		r.fail(`"base" must map field names to strings`);
	}
	// The flag and the mode are kept in memory only when not the default, so a link reads back exactly as written.
	const pendingDelete = r.boolean("pendingDelete");
	const mode = o.mode;
	if (typeof mode !== "string" || !(SYNC_LINK_MODES as readonly string[]).includes(mode)) {
		r.fail(`"mode" must be "sync", "excluded" or "localOnly"`);
	}
	// Optional, so absent stays absent; a wrong type fails the load.
	const noteBase = o.noteBase;
	if (noteBase !== undefined && typeof noteBase !== "string") r.fail(`"noteBase" must be a string`);
	const noteItems = o.noteItems;
	if (noteItems !== undefined && (!Array.isArray(noteItems) || !noteItems.every((v) => typeof v === "string"))) {
		r.fail(`"noteItems" must be a list of strings`);
	}
	const { pendingDelete: _p, mode: _m, noteBase: _b, noteItems: _i, ...rest } = o;
	return {
		...rest,
		...(pendingDelete ? { pendingDelete } : {}),
		...(mode !== "sync" ? { mode: mode as SyncLinkMode } : {}),
		...(typeof noteBase === "string" ? { noteBase } : {}),
		...(Array.isArray(noteItems) ? { noteItems: [...noteItems] } : {}),
		kind: kind as SyncLinkKind,
		logwellId: r.nonEmptyString("logwellId"),
		ttId: r.nonEmptyString("ttId"),
		ttProjectId: strictOptString("ttProjectId"),
		etag: strictOptString("etag"),
		base: { ...(base as Record<string, string>) },
		noteBySync: r.boolean("noteBySync"),
		lastPulledAt: strictOptString("lastPulledAt"),
		modifiedAt: r.nonEmptyString("modifiedAt"),
	};
}

function readOpaque(collection: CollectionName, o: Obj, key: string): OpaqueRecord {
	const r: RecordReader = new RecordReader(collection, key, o);
	r.nonEmptyString("id");
	return o;
}

// -- recurrence -------------------------------------------------------------
//
// Typed readers that repair instead of failing the load, like readHabit. Each repair records an issue
// that names the task. Fields this version does not know are kept, at the top, in versions and in rules.

const NTH_VALUES: readonly unknown[] = [1, 2, 3, 4, -1];

function isWeekday(value: unknown): value is Weekday {
	return (WEEKDAYS as readonly unknown[]).includes(value);
}

function readMonthly(raw: unknown, fix: (what: string) => void): MonthlyOn | null {
	if (raw === null) return null;
	if (!isRecord(raw)) {
		fix("an unreadable day of the month, which now follows the start date");
		return null;
	}
	if (raw.kind === "lastDay") return { ...raw, kind: "lastDay" };
	if (raw.kind === "day" && typeof raw.day === "number" && Number.isFinite(raw.day)) {
		const day = Math.min(31, Math.max(1, Math.round(raw.day)));
		if (day !== raw.day) fix(`day of the month ${raw.day}, which was set to ${day}`);
		return { ...raw, kind: "day", day };
	}
	if (raw.kind === "nth" && NTH_VALUES.includes(raw.n) && isWeekday(raw.weekday)) {
		return { ...raw, kind: "nth", n: raw.n as 1 | 2 | 3 | 4 | -1, weekday: raw.weekday };
	}
	fix("an unreadable day of the month, which now follows the start date");
	return null;
}

/** A rule, repaired field by field; null when its frequency is unreadable (the version is dropped). */
function readRepeatRule(raw: unknown, fix: (what: string) => void): RepeatRule | null {
	if (!isRecord(raw) || !(REPEAT_FREQS as readonly unknown[]).includes(raw.freq)) return null;
	const freq = raw.freq as RepeatFreq;
	let interval = 1;
	if (typeof raw.interval === "number" && (raw.interval > MAX_INTERVAL || raw.interval === Infinity)) {
		// A huge interval would make the engine work for nothing; 999 is the largest one.
		interval = MAX_INTERVAL;
		fix(`an interval above ${MAX_INTERVAL}, which was set to ${MAX_INTERVAL}`);
	} else if (typeof raw.interval === "number" && Number.isInteger(raw.interval) && raw.interval >= 1) interval = raw.interval;
	else fix(`an unreadable interval, which was set to 1`);

	let weekdays: Weekday[] | null = null;
	const rawDays = raw.weekdays ?? null;
	if (rawDays !== null) {
		if (freq !== "weekly") fix("weekdays on a rule that is not weekly, which were cleared");
		else if (!Array.isArray(rawDays)) fix("unreadable weekdays, which now follow the start date");
		else {
			const known = (rawDays as unknown[]).filter(isWeekday);
			const unique = known.filter((d, i) => known.indexOf(d) === i);
			if (unique.length === 0) fix("no readable weekday, so it now follows the start date");
			else if (unique.length !== rawDays.length) fix("unknown or repeated weekdays, which were removed");
			weekdays = unique.length > 0 ? unique : null;
		}
	}

	let monthly: MonthlyOn | null = null;
	const rawMonthly = raw.monthly ?? null;
	if (rawMonthly !== null) {
		if (freq !== "monthly") fix("a day of the month on a rule that is not monthly, which was cleared");
		else monthly = readMonthly(rawMonthly, fix);
	}

	let afterCompletion = false;
	if (typeof raw.afterCompletion === "boolean") afterCompletion = raw.afterCompletion;
	else if (raw.afterCompletion !== undefined) fix(`an unreadable "count from completion" switch, which was turned off`);
	if (afterCompletion && (weekdays !== null || (monthly !== null && monthly.kind !== "day"))) {
		afterCompletion = false;
		fix(`"count from completion" with fixed days, which was turned off`);
	}

	let time: string | null = null;
	let tz: string | null = null;
	const rawTime = raw.time ?? null;
	const rawTz = raw.tz ?? null;
	if (rawTime !== null || rawTz !== null) {
		if (isClockTime(rawTime) && typeof rawTz === "string" && isValidZone(rawTz)) {
			time = rawTime;
			tz = rawTz;
		} else fix("an unreadable time, which was cleared");
	}
	const rule: RepeatRule = { ...raw, freq, interval, weekdays, monthly, afterCompletion, time, tz };
	// Optional; an unknown week start is dropped (the setting applies again).
	if (raw.weekStart !== undefined && !(WEEK_STARTS as readonly unknown[]).includes(raw.weekStart)) {
		delete rule.weekStart;
		fix("an unknown week start, which was removed");
	}
	return rule;
}

function readRepeatEnd(raw: unknown, fix: (what: string) => void): RepeatEnd {
	if (raw === undefined) return { kind: "never" };
	if (isRecord(raw)) {
		if (raw.kind === "never") return { ...raw, kind: "never" };
		if (raw.kind === "date" && isValidLocalDate(raw.date)) return { ...raw, kind: "date", date: raw.date };
		if (raw.kind === "count" && typeof raw.count === "number" && Number.isInteger(raw.count) && raw.count >= 1) {
			return { ...raw, kind: "count", count: raw.count };
		}
	}
	fix("an unreadable end, which was set to never");
	return { kind: "never" };
}

/** Null (not repeating) with an issue when the anchor or every version is unreadable. */
function readRecurrence(raw: unknown, title: string, issues: string[]): Recurrence | null {
	if (raw === null) return null;
	const fixed: string[] = [];
	const fix = (what: string): void => {
		fixed.push(what);
	};
	const report = (): void => {
		for (const what of fixed) issues.push(`Repeating task "${title}" had ${what}.`);
	};
	if (!isRecord(raw) || !isValidLocalDate(raw.anchor)) {
		issues.push(`Repeating task "${title}" had an unreadable repeat, which was removed; the task no longer repeats.`);
		return null;
	}
	const byDate = new Map<string, RepeatVersion>();
	let unreadable = 0;
	let duplicates = 0;
	for (const v of Array.isArray(raw.versions) ? (raw.versions as unknown[]) : []) {
		const rule = isRecord(v) ? readRepeatRule(v.rule, fix) : null;
		if (!isRecord(v) || !isValidLocalDate(v.effectiveFrom) || rule === null) {
			unreadable++;
			continue;
		}
		if (byDate.has(v.effectiveFrom)) duplicates++;
		byDate.set(v.effectiveFrom, { ...v, effectiveFrom: v.effectiveFrom, rule });
	}
	if (byDate.size === 0) {
		issues.push(`Repeating task "${title}" had no readable repeat rule; the task no longer repeats.`);
		return null;
	}
	if (unreadable > 0) fix(unreadable === 1 ? "an unreadable rule change, which was removed" : `${unreadable} unreadable rule changes, which were removed`);
	if (duplicates > 0) fix("two rule changes on the same day; the later one was kept");
	const versions = [...byDate.values()].sort(byEffectiveFrom);
	const end = readRepeatEnd(raw.end, fix);
	let endedAt: string | null = null;
	if (typeof raw.endedAt === "string") endedAt = raw.endedAt;
	else if (raw.endedAt !== null && raw.endedAt !== undefined) fix("an unreadable end time, which was cleared");
	const out: Recurrence = { ...raw, anchor: raw.anchor, versions, end, endedAt };
	// Optional (absent: the anchor dates from the creation); an unreadable one is dropped.
	if (raw.countFrom !== undefined && !isNonEmptyString(raw.countFrom)) {
		delete out.countFrom;
		fix("an unreadable count start, which was removed");
	}
	if (raw.anchoredAt !== undefined && !isNonEmptyString(raw.anchoredAt)) {
		delete out.anchoredAt;
		fix("an unreadable move time, which was removed");
	}
	report();
	return out;
}

/** The resolve time of a record whose own is unreadable: the oldest possible, never "". */
const RESOLVED_AT_UNKNOWN = "1970-01-01T00:00:00.000Z";

/**
 * A record without a readable task id, date or status is dropped with an issue. One whose task is
 * missing is kept silently (git sync can deliver it before its task), and one whose task no
 * longer repeats is kept as history.
 */
function readOccurrenceRecord(o: Obj, issues: string[]): OccurrenceRecord | null {
	const taskId = isNonEmptyString(o.taskId) ? o.taskId : null;
	if (taskId === null || !isValidLocalDate(o.occurrenceDate) || (o.status !== "done" && o.status !== "skipped")) {
		const date = typeof o.occurrenceDate === "string" ? ` (${o.occurrenceDate})` : "";
		issues.push(`An occurrence record${date} was damaged and has been removed.`);
		return null;
	}
	const label = `Occurrence record (${taskId}:${o.occurrenceDate})`;
	let resolvedAt = RESOLVED_AT_UNKNOWN;
	if (isNonEmptyString(o.resolvedAt)) resolvedAt = o.resolvedAt;
	else issues.push(`${label} had an unreadable time; it was set to the oldest possible.`);
	let auto = false;
	if (typeof o.auto === "boolean") auto = o.auto;
	else issues.push(`${label} had an unreadable automatic flag; it was set to false.`);
	let completedOn: string | null = null;
	if (isValidLocalDate(o.completedOn)) completedOn = o.completedOn;
	else if (o.completedOn !== null) issues.push(`${label} had an unreadable completion day, which was cleared.`);
	return { ...o, taskId, occurrenceDate: o.occurrenceDate, status: o.status, resolvedAt, auto, completedOn };
}

/**
 * A typed reader that repairs instead of failing the load. An unknown status or gap resolution
 * is repaired and reported; a record whose id or segments cannot be read is dropped with an issue.
 * Fields this version does not know are kept, so a newer build's extras survive a write here.
 */
function readFocusSession(o: Obj, issues: string[]): FocusSession | null {
	const str = (f: string): string | null => (typeof o[f] === "string" ? o[f] : null);
	const id = str("id");
	if (id === null || id.length === 0) {
		issues.push("A focus record without an id was damaged and has been removed.");
		return null;
	}
	const segments: FocusSession["segments"] = [];
	let readable = Array.isArray(o.segments);
	if (Array.isArray(o.segments)) {
		for (const s of o.segments as unknown[]) {
			const seg = s as Obj | null;
			if (typeof seg !== "object" || seg === null || !isInstant(seg.start) || !isInstant(seg.end)) {
				readable = false;
				break;
			}
			segments.push({ ...seg, start: seg.start, end: seg.end });
		}
	}
	if (!readable) {
		issues.push(`Focus record (${id}) had unreadable time segments and has been removed.`);
		return null;
	}
	let status: FocusStatus = "stopped";
	if ((FOCUS_STATUSES as readonly unknown[]).includes(o.status)) status = o.status as FocusStatus;
	else issues.push(`Focus record (${id}) had an unknown status and was set to stopped.`);
	const unobserved: FocusGap[] = [];
	for (const g of Array.isArray(o.unobserved) ? (o.unobserved as unknown[]) : []) {
		const gap = g as Obj | null;
		if (typeof gap !== "object" || gap === null || !isInstant(gap.start) || !isInstant(gap.end)) {
			issues.push(`Focus record (${id}) had an unreadable gap, which was removed.`);
			continue;
		}
		let resolution: GapResolution = "pending";
		if ((GAP_RESOLUTIONS as readonly unknown[]).includes(gap.resolution)) resolution = gap.resolution as GapResolution;
		else issues.push(`Focus record (${id}) had a gap with an unknown resolution; it was set to pending.`);
		unobserved.push({ ...gap, start: gap.start, end: gap.end, resolution });
	}
	const last = segments[segments.length - 1];
	const startedAt = str("startedAt") ?? segments[0]?.start ?? "";
	const endedAt = str("endedAt") ?? last?.end ?? startedAt;
	const record: FocusSession = {
		...o,
		id,
		deviceId: str("deviceId") ?? "",
		taskId: str("taskId") || null,
		taskTitleSnapshot: str("taskTitleSnapshot") ?? "",
		plannedSec: typeof o.plannedSec === "number" && Number.isFinite(o.plannedSec) ? o.plannedSec : 0,
		status,
		segments,
		unobserved,
		splitFrom: str("splitFrom"),
		startedAt,
		endedAt,
		finalizedAt: str("finalizedAt") ?? endedAt,
	};
	// Both are optional; anything unreadable is dropped so the record shows as a set of its own.
	if (o.setId !== undefined && !isNonEmptyString(o.setId)) {
		delete record.setId;
		issues.push(`Focus record (${id}) had an unreadable set id, which was removed.`);
	}
	if (o.setRounds !== undefined && !(typeof o.setRounds === "number" && Number.isInteger(o.setRounds) && o.setRounds > 0)) {
		delete record.setRounds;
		issues.push(`Focus record (${id}) had an unreadable set size, which was removed.`);
	}
	if (o.setRound !== undefined && !(typeof o.setRound === "number" && Number.isInteger(o.setRound) && o.setRound > 0)) {
		delete record.setRound;
		issues.push(`Focus record (${id}) had an unreadable round number, which was removed.`);
	} else if (typeof record.setRound === "number" && typeof record.setRounds === "number" && record.setRound > record.setRounds) {
		// Only a hand-edited file can get here; the app never stamps a round past the set size.
		delete record.setRound;
		issues.push(`Focus record (${id}) had a round number past its set size, which was removed.`);
	}
	if (o.modifiedAt !== undefined && !isInstant(o.modifiedAt)) {
		delete record.modifiedAt;
		issues.push(`Focus record (${id}) had an unreadable edit time, which was removed.`);
	}
	return record;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** Oldest `effectiveFrom` first. */
function byEffectiveFrom(a: { effectiveFrom: string }, b: { effectiveFrom: string }): number {
	return compareSortKeys(a.effectiveFrom, b.effectiveFrom);
}

function readGoal(raw: unknown): HabitGoal | null {
	if (!isRecord(raw)) return null;
	if (!(GOAL_TYPES as readonly unknown[]).includes(raw.type)) return null;
	if (typeof raw.target !== "number" || !Number.isFinite(raw.target) || raw.target <= 0) return null;
	if (raw.period !== "day" && raw.period !== "week") return null;
	const unit = raw.unit ?? null;
	if (unit !== null && typeof unit !== "string") return null;
	return { ...raw, type: raw.type as GoalType, target: raw.target, unit, period: raw.period };
}

function readSchedule(raw: unknown): HabitSchedule | null {
	if (!isRecord(raw)) return null;
	if (raw.kind === "daily" || raw.kind === "weekly") return { ...raw, kind: raw.kind };
	if (raw.kind !== "weekdays") return null;
	const days = raw.days;
	if (!Array.isArray(days) || days.length === 0 || !days.every((d) => (WEEKDAYS as readonly unknown[]).includes(d))) return null;
	return { ...raw, kind: "weekdays", days: [...(days as Weekday[])] };
}

/**
 * A typed reader that repairs instead of failing the load, built like readFocusSession. A habit
 * without a readable id, name or version is dropped with an issue; anything else unreadable is cleared
 * with an issue. Fields this version does not know are kept, at the top and inside versions and goals.
 */
function readHabit(o: Obj, issues: string[]): Habit | null {
	const id = isNonEmptyString(o.id) ? o.id : null;
	const rawName = o.name;
	const label = typeof rawName === "string" && rawName.trim().length > 0 ? `"${rawName}"` : id !== null ? `(${id})` : "(unnamed)";
	if (id === null || typeof rawName !== "string") {
		issues.push(`Habit ${label} was damaged and has been removed; its check-ins are kept.`);
		return null;
	}
	let name = rawName;
	if (name.trim().length === 0) {
		name = "Untitled habit";
		issues.push(`A habit with an empty name was renamed to "Untitled habit".`);
	}
	const versions: HabitVersion[] = [];
	let unreadable = 0;
	for (const raw of Array.isArray(o.versions) ? (o.versions as unknown[]) : []) {
		const goal = isRecord(raw) ? readGoal(raw.goal) : null;
		const schedule = isRecord(raw) ? readSchedule(raw.schedule) : null;
		if (!isRecord(raw) || !isValidLocalDate(raw.effectiveFrom) || goal === null || schedule === null) {
			unreadable++;
			continue;
		}
		let weekStart: WeekStart = "MO";
		if ((WEEK_STARTS as readonly unknown[]).includes(raw.weekStart)) weekStart = raw.weekStart as WeekStart;
		else issues.push(`Habit "${name}" had a goal with an unknown week start; it was set to Monday.`);
		versions.push({ ...raw, effectiveFrom: raw.effectiveFrom, goal, schedule, weekStart });
	}
	if (versions.length === 0) {
		issues.push(`Habit "${name}" had no readable goal and has been removed; its check-ins are kept.`);
		return null;
	}
	if (unreadable > 0) issues.push(`Habit "${name}" had ${unreadable === 1 ? "an unreadable goal change" : `${unreadable} unreadable goal changes`}, which ${unreadable === 1 ? "was" : "were"} removed.`);
	versions.sort(byEffectiveFrom);

	let timeOfDay: TimeOfDay = "anytime";
	if ((TIMES_OF_DAY as readonly unknown[]).includes(o.timeOfDay)) timeOfDay = o.timeOfDay as TimeOfDay;
	else issues.push(`Habit "${name}" had an unknown time of day; it was set to Anytime.`);
	let reminder: Habit["reminder"] = null;
	if (isRecord(o.reminder) && isClockTime(o.reminder.time)) reminder = { ...o.reminder, time: o.reminder.time };
	else if (o.reminder !== null) issues.push(`Habit "${name}" had an unreadable reminder, which was removed.`);
	let icon: string | null = null;
	if (isNonEmptyString(o.icon)) icon = o.icon;
	else if (o.icon !== null) issues.push(`Habit "${name}" had an unreadable icon, which was cleared.`);
	let color: TagColor | null = null;
	if ((TAG_COLORS as readonly unknown[]).includes(o.color)) color = o.color as TagColor;
	else if (o.color !== null) issues.push(`Habit "${name}": ${typeof o.color === "string" ? `unknown color "${o.color}"` : "an unreadable color"} was cleared.`);
	let archivedAt: string | null = null;
	if (typeof o.archivedAt === "string") archivedAt = o.archivedAt;
	else if (o.archivedAt !== null) issues.push(`Habit "${name}" had an unreadable archive date; it is no longer archived.`);
	const str = (f: string): string => (typeof o[f] === "string" ? o[f] : "");
	return {
		...o,
		id,
		name,
		icon,
		color,
		timeOfDay,
		reminder,
		archivedAt,
		sortKey: str("sortKey"),
		createdAt: str("createdAt"),
		modifiedAt: str("modifiedAt"),
		versions,
	};
}

/** The delete time of a check-in whose own times are all unreadable: still deleted, oldest possible. */
const DELETED_AT_UNKNOWN = "1970-01-01T00:00:00.000Z";

/**
 * A check-in without a readable id, habit, date or value (a finite number ≥ 0) is dropped with an
 * issue. One whose habit does not exist is kept silently: sync can deliver it before its habit.
 */
function readCheckin(o: Obj, issues: string[]): Checkin | null {
	const id = isNonEmptyString(o.id) ? o.id : null;
	const habitId = isNonEmptyString(o.habitId) ? o.habitId : null;
	const value = o.value;
	if (id === null || habitId === null || !isValidLocalDate(o.date) || typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		issues.push(`A check-in ${id === null ? "without an id" : `(${id})`} was damaged and has been removed.`);
		return null;
	}
	const str = (f: string): string => (typeof o[f] === "string" ? o[f] : "");
	let note: string | null = null;
	if (typeof o.note === "string") note = o.note;
	else if (o.note !== null) issues.push(`Check-in (${id}) had an unreadable note, which was cleared.`);
	let deletedAt: string | null = null;
	if (typeof o.deletedAt === "string") deletedAt = o.deletedAt;
	else if (o.deletedAt !== null) {
		// Kept deleted: clearing it would bring a removed check-in back. With no readable time at all it
		// takes a fixed instant, never "".
		deletedAt = str("modifiedAt") || str("createdAt") || DELETED_AT_UNKNOWN;
		issues.push(`Check-in (${id}) had an unreadable delete time; it stays deleted.`);
	}
	return { ...o, id, habitId, date: o.date, value, note, createdAt: str("createdAt"), modifiedAt: str("modifiedAt"), deletedAt };
}

function readMeta(raw: Obj): DbMeta {
	const fail = (detail: string): never => {
		throw new CollectionError("header", null, detail);
	};
	if (raw.format !== DB_FORMAT) fail("not a Logwell database");
	if (typeof raw.schemaVersion !== "number") fail(`"schemaVersion" is missing`);
	if (typeof raw.dbId !== "string" || raw.dbId.length === 0) fail(`"dbId" is missing`);
	if (typeof raw.revision !== "string" || raw.revision.length === 0) fail(`"revision" is missing`);
	// Both end up in backup paths, so anything but a plain id is damage.
	if (!isSafeId(raw.dbId as string)) fail(`"dbId" is not a valid id`);
	if (!isSafeId(raw.revision as string)) fail(`"revision" is not a valid id`);
	const history = Array.isArray(raw.history) ? raw.history.filter((x): x is string => typeof x === "string") : [];
	return {
		format: DB_FORMAT,
		schemaVersion: raw.schemaVersion as number,
		dbId: raw.dbId as string,
		revision: raw.revision as string,
		baseRevision: typeof raw.baseRevision === "string" ? raw.baseRevision : null,
		history,
		writtenBy: typeof raw.writtenBy === "string" ? raw.writtenBy : "",
		writtenAt: typeof raw.writtenAt === "string" ? raw.writtenAt : "",
	};
}

/** Validates a single record of a collection (used for journal replay). */
export function readRecord(collection: CollectionName, value: unknown, key: string, issues: string[] = []): unknown {
	const o = asObject(collection, value, 0);
	switch (collection) {
		case "categories":
			return readCategory(o, key, issues);
		case "sections":
			return readSection(o, issues);
		case "tags":
			return readTag(o, key, issues);
		case "tasks":
			return readTask("tasks", o, key, issues);
		case "trash":
			return readTrash(o, key, issues);
		case "focusSessions":
			return readFocusSession(o, issues);
		case "habits":
			return readHabit(o, issues);
		case "checkins":
			return readCheckin(o, issues);
		case "occurrenceRecords":
			return readOccurrenceRecord(o, issues);
		case "syncLinks":
			return readSyncLink(o, key);
		default:
			return readOpaque(collection, o, key);
	}
}

export interface ValidatedDb {
	data: DbData;
	/** Repairs applied while loading (shown to the user, then written back). */
	issues: string[];
}

/** Validates a current-schema document and repairs references. */
export function validateDb(raw: Obj, now: string): ValidatedDb {
	const meta = readMeta(raw);
	if (meta.schemaVersion > CURRENT_SCHEMA_VERSION) {
		throw new CollectionError("header", null, `schema version ${meta.schemaVersion} is newer than supported`);
	}
	const issues: string[] = [];
	const cols = emptyCollections();
	for (const name of COLLECTIONS) {
		const list = raw[name] ?? [];
		if (!Array.isArray(list)) throw new CollectionError(name, null, "collection is not a list");
		const target = cols[name] as Map<string, unknown>;
		list.forEach((value, index) => {
			const key = typeof value === "object" && value !== null ? recordId(name, value) : `#${index}`;
			const record = readRecord(name, value, key, issues);
			if (record === null) return; // a damaged record of a repairing reader, dropped with an issue
			const id = recordId(name, record);
			if (target.has(id)) throw new CollectionError(name, id, "duplicate ID");
			target.set(id, record);
		});
	}
	repairReferences(cols, now, issues);
	return { data: { meta, ...cols }, issues };
}

type MutableCollections = ReturnType<typeof emptyCollections>;

/**
 * Cross-collection repairs (a subtask takes its parent's list), each
 * recorded as an issue.
 */
export function repairReferences(cols: MutableCollections, now: string, issues: string[]): void {
	// The Inbox always exists and is the only Inbox.
	const inbox = cols.categories.get(INBOX_ID);
	if (inbox === undefined) {
		cols.categories.set(INBOX_ID, inboxCategory(now));
		issues.push("The Inbox list was missing and has been recreated.");
	} else if (!inbox.isInbox) {
		cols.categories.set(INBOX_ID, { ...inbox, isInbox: true });
	}
	for (const [id, c] of cols.categories) {
		if (id !== INBOX_ID && c.isInbox) cols.categories.set(id, { ...c, isInbox: false });
	}

	// A section lives in exactly one existing list.
	const seenKeys = new Set<string>();
	for (const [id, section] of cols.sections) {
		if (!cols.categories.has(section.categoryId)) {
			cols.sections.delete(id);
			issues.push(`Section "${section.name}" pointed to a missing list and was removed.`);
			continue;
		}
		// Duplicate names in a list are harmless (the services refuse new ones); recorded only.
		const dupKey = `${section.categoryId}\u0000${section.nameKey}`;
		if (seenKeys.has(dupKey)) issues.push(`Section "${section.name}" has the same name as another section in its list.`);
		seenKeys.add(dupKey);
	}

	for (const [id, t] of cols.tasks) {
		let task = t;
		if (!cols.categories.has(task.categoryId)) {
			issues.push(`Task "${task.title}" pointed to a missing list and was moved to Inbox.`);
			task = { ...task, categoryId: INBOX_ID };
		}
		if (task.sectionId !== null) {
			const section = cols.sections.get(task.sectionId);
			if (section === undefined) {
				issues.push(`Task "${task.title}" pointed to a missing section and was moved to No section.`);
				task = { ...task, sectionId: null };
			} else if (section.categoryId !== task.categoryId) {
				issues.push(`Task "${task.title}" was in a section of another list and was moved to No section.`);
				task = { ...task, sectionId: null };
			}
		}
		if (task.title.trim().length === 0) {
			issues.push(`A task with an empty title was renamed to "Untitled task".`);
			task = { ...task, title: "Untitled task" };
		}
		if (task.status === "completed" && task.completedAt === null) task = { ...task, completedAt: task.modifiedAt };
		if (task.status === "open" && task.completedAt !== null) task = { ...task, completedAt: null };
		for (const key of task.tagKeys) {
			if (!cols.tags.has(key)) {
				cols.tags.set(key, { key, displayName: key, color: null, createdAt: now, modifiedAt: now });
				issues.push(`Tag "${key}" was missing and has been recreated.`);
			}
		}
		if (task !== t) cols.tasks.set(id, task);
	}

	// One level, and a subtask shares its parent's category.
	for (const [id, t] of cols.tasks) {
		if (t.parentId === null) continue;
		const parent = cols.tasks.get(t.parentId);
		if (parent === undefined || parent.parentId !== null || parent.id === id) {
			issues.push(`Subtask "${t.title}" lost its parent and is now a top-level task.`);
			cols.tasks.set(id, { ...t, parentId: null });
		} else {
			let sub = t;
			if (parent.categoryId !== sub.categoryId) {
				sub = { ...sub, categoryId: parent.categoryId };
				issues.push(`Subtask "${t.title}" was moved to its parent's list.`);
			}
			// A subtask shares its parent's section.
			if (parent.sectionId !== sub.sectionId) {
				sub = { ...sub, sectionId: parent.sectionId };
				issues.push(`Subtask "${t.title}" was moved to its parent's section.`);
			}
			if (sub !== t) cols.tasks.set(id, sub);
		}
	}
	// Sync links are not repaired. An orphaned link is kept silently (see readSyncLink).
}
