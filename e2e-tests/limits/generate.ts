import type {
	Category,
	Checkin,
	DateSpec,
	FocusSession,
	Habit,
	HabitGoal,
	HabitSchedule,
	OccurrenceRecord,
	Priority,
	RepeatRule,
	Section,
	Tag,
	TagColor,
	Task,
	TimeOfDay,
} from "../../src/domain/types";
import { INBOX_ID, TAG_COLORS } from "../../src/domain/types";
import { type DbData, createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { uuid } from "../../tests/helpers";

// The data side of the limits harness (docs/development/performance.md). `generateDb(dimension, count)` builds a valid
// current-schema database through the project's own types and `serializeDb`, with one dimension at its matrix count
// and everything else at the README baseline: 500 tasks, 10 lists, 20 tags, 5 habits, 200 focus records.
// Deterministic: a seeded generator, and dates relative to the `today` passed in.
//
// How a dimension is added to the baseline:
//   tasks_total            the total number of tasks (subtasks included).
//   tasks_in_one_list      N tasks in "Big list", on top of the 500 baseline tasks in the other lists.
//   lists                  N named lists (Big list is the first); the 500 tasks spread over them.
//   sections_per_list      N sections in Big list, which holds 200 tasks spread over the sections.
//   tags / tag_depth       N tags, or one extra chain a/a-b/... of N levels (every level is a tag).
//   subtasks_per_task      one extra parent in Big list with N subtasks.
//   repeating_tasks        N repeating tasks on top of the 500 baseline tasks; 100 have 50+ done records.
//   calendar_month         N timed tasks inside the current month, on top of the baseline.
//   habits / checkins      N habits (60 check-ins each), or 5 habits sharing N check-ins.
//   focus_sessions         N focus records over the past 18 months.
//   title_length           one extra Inbox task whose title has N characters (words, with spaces).

export const BIG_LIST_NAME = "Big list";

export interface GenOptions {
	/** The local day "today" is, YYYY-MM-DD. Dates are spread around it. */
	today: string;
	/** An IANA zone for the timed tasks. */
	zone: string;
	dbId: string;
}

export interface Markers {
	bigListId: string;
	bigListName: string;
	/** Open, plain, top-level tasks the harness may complete (never a parent, never repeating). */
	completeTaskIds: string[];
	/** The parent with the subtasks (subtasks_per_task), or null. */
	parentTaskId: string | null;
	/** The task with the long title (title_length), or null. */
	longTaskId: string | null;
}

export interface Generated {
	text: string;
	sizeKb: number;
	markers: Markers;
	/** Counts of what was written, for the log. */
	summary: Record<string, number>;
}

interface Sizes {
	tasks: number;
	lists: number;
	tags: number;
	tagDepth: number;
	habits: number;
	/** null: 60 per habit. */
	checkins: number | null;
	focus: number;
	bigListTasks: number;
	sections: number;
	parentSubtasks: number;
	repeating: number;
	calendarTasks: number;
	longTitle: number;
}

const BASE: Sizes = {
	tasks: 500,
	lists: 10,
	tags: 20,
	tagDepth: 0,
	habits: 5,
	checkins: null,
	focus: 200,
	bigListTasks: 0,
	sections: 3,
	parentSubtasks: 0,
	repeating: 0,
	calendarTasks: 0,
	longTitle: 0,
};

const CHECKINS_PER_HABIT = 60;
const FOCUS_SPAN_DAYS = 540;
const HABIT_SPAN_DAYS = 730;

function sizesFor(dimension: string, count: number): Sizes {
	switch (dimension) {
		case "tasks_total":
			return { ...BASE, tasks: count };
		case "tasks_in_one_list":
			return { ...BASE, bigListTasks: count };
		case "lists":
			return { ...BASE, lists: count };
		case "sections_per_list":
			return { ...BASE, sections: count, bigListTasks: 200 };
		case "tags":
			return { ...BASE, tags: count };
		case "tag_depth":
			return { ...BASE, tagDepth: count };
		case "subtasks_per_task":
			return { ...BASE, parentSubtasks: count };
		case "repeating_tasks":
			return { ...BASE, repeating: count };
		case "calendar_month":
			return { ...BASE, calendarTasks: count };
		case "habits":
			return { ...BASE, habits: count };
		case "checkins":
			return { ...BASE, checkins: count };
		case "focus_sessions":
			return { ...BASE, focus: count };
		case "title_length":
			return { ...BASE, longTitle: count };
		default:
			throw new Error(`Unknown dimension "${dimension}"`);
	}
}

// -- helpers ---------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const K_TASK = 1;
const K_HABIT = 2;
const K_CHECKIN = 3;
const K_FOCUS = 4;
const K_LIST = 5;
const K_SECTION = 6;

function addDays(date: string, n: number): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function daysInMonth(date: string): number {
	const [y, m] = date.split("-").map(Number) as [number, number];
	return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** A stable, well mixed index below `mod` (a plain `i * k % mod` skips most slots when k divides mod). */
const spread = (i: number, mod: number): number => (Math.imul(i + 1, 2654435761) >>> 0) % mod;
const pad = (n: number): string => String(n).padStart(2, "0");
const sortKey = (n: number): string => `V${n.toString(36).padStart(5, "0")}`;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const VERBS = ["Call", "Email", "Write", "Review", "Book", "Buy", "Fix", "Plan", "Draft", "Send", "Update", "Clean", "Schedule", "Read", "Pay", "Renew", "Prepare", "Order", "Check", "Organize"];
const OBJECTS = [
	"the quarterly report",
	"dentist appointment",
	"lecture notes for chapter 4",
	"the bike tyres",
	"insurance paperwork",
	"groceries for the week",
	"presentation slides",
	"the landlord about the heating",
	"flight tickets to Lisbon",
	"thesis introduction",
	"gym membership",
	"the garden shed",
	"tax return",
	"birthday gift for Sam",
	"project proposal",
	"the team retro agenda",
	"library books",
	"car service",
	"passport renewal",
	"the backlog before Friday",
	"meal plan",
	"rent transfer",
	"conference registration",
	"photos from the trip",
	"the invoice for March",
	"study group session",
	"the router firmware",
	"a reply to Alex",
	"recipe ideas",
	"the budget spreadsheet",
];
const EXTRAS = ["before lunch", "this week", "with the whole team", "if there is time", "and send a summary", "for the new term", "at the weekend", "(urgent)"];
const LIST_NAMES = ["Work", "Home", "Study", "Errands", "Health", "Finance", "Reading", "Projects", "Travel", "Ideas", "Garden", "Car", "Family", "Admin"];
const TAG_BANK = [
	"work",
	"home",
	"errands",
	"urgent",
	"waiting",
	"ideas",
	"work/project-a",
	"work/project-b",
	"work/meetings",
	"home/garden",
	"home/repairs",
	"health",
	"health/gym",
	"study",
	"study/exams",
	"reading",
	"finance",
	"travel",
	"admin",
	"calls",
];
const HABIT_NAMES = ["Drink water", "Read 20 pages", "Meditate", "Stretch", "Walk outside", "Journal", "Practice guitar", "Learn a language", "No sugar", "Sleep before 23:00"];
const TIMES_OF_DAY: TimeOfDay[] = ["morning", "afternoon", "evening", "anytime"];

const rule = (patch: Partial<RepeatRule>): RepeatRule => ({ freq: "daily", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null, ...patch });

// -- the generator ---------------------------------------------------------------------------

export function generateDb(dimension: string, count: number, opts: GenOptions): Generated {
	const size = sizesFor(dimension, count);
	const { today, zone } = opts;
	const now = `${today}T08:00:00.000Z`;
	const rnd = mulberry32(0x10c0 + count);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
	const instantAgo = (days: number, hour = 9): string => `${addDays(today, -days)}T${pad(hour)}:00:00.000Z`;

	const db = createEmptyDb({ dbId: opts.dbId, revision: "r-limits000001", deviceId: "d-limits", now });
	const categories = new Map(db.categories);
	const sections = new Map<string, Section>();
	const tags = new Map<string, Tag>();
	const tasks = new Map<string, Task>();
	const occurrenceRecords = new Map<string, OccurrenceRecord>();
	const habits = new Map<string, Habit>();
	const checkins = new Map<string, Checkin>();
	const focusSessions = new Map<string, FocusSession>();

	// Lists: Big list first, then the bank, then "List n".
	const listIds: string[] = [];
	for (let i = 0; i < size.lists; i++) {
		const id = uuid(K_LIST, i + 1);
		const name = i === 0 ? BIG_LIST_NAME : (LIST_NAMES[i - 1] ?? `List ${i + 1}`);
		const category: Category = {
			id,
			name,
			icon: null,
			color: i % 5 === 4 ? null : (TAG_COLORS[i % TAG_COLORS.length] as TagColor),
			nameKey: name.toLowerCase(),
			isInbox: false,
			sortKey: sortKey(i + 1),
			createdAt: instantAgo(200),
			modifiedAt: instantAgo(200),
		};
		categories.set(id, category);
		listIds.push(id);
	}
	const bigListId = listIds[0] as string;

	// Sections of Big list.
	const sectionIds: string[] = [];
	for (let k = 0; k < size.sections; k++) {
		const id = uuid(K_SECTION, k + 1);
		const name = size.sections <= 3 ? (["Backlog", "In progress", "Later"][k] as string) : `Section ${k + 1}`;
		sections.set(id, { id, categoryId: bigListId, name, nameKey: name.toLowerCase(), sortKey: sortKey(k + 1), createdAt: instantAgo(100), modifiedAt: instantAgo(100) });
		sectionIds.push(id);
	}
	let bigSeq = 0;
	const sectionFor = (categoryId: string): string | null => {
		if (categoryId !== bigListId || sectionIds.length === 0) return null;
		const j = bigSeq++ % (sectionIds.length + 1);
		return j === sectionIds.length ? null : (sectionIds[j] as string);
	};

	// Tags: the bank, then topics (a third flat, the rest nested under eight areas); plus an optional chain.
	const tagColor = (i: number): TagColor | null => (i % 2 === 0 ? null : (TAG_COLORS[i % TAG_COLORS.length] as TagColor));
	const addTag = (key: string, i: number): void => {
		const displayName = key.split("/").map(cap).join("/");
		tags.set(key, { key, displayName, color: tagColor(i), createdAt: instantAgo(150), modifiedAt: instantAgo(150) });
	};
	for (let i = 0; i < size.tags; i++) {
		if (i < TAG_BANK.length) addTag(TAG_BANK[i] as string, i);
		else {
			const n = String(i + 1).padStart(4, "0");
			const area = `area-${i % 8}`;
			// Every tag's parent is a tag: an area's first slot makes the area itself.
			addTag(i % 3 === 0 ? `topic-${n}` : tags.has(area) ? `${area}/topic-${n}` : area, i);
		}
	}
	const usableTags = [...tags.keys()];
	const chain: string[] = [];
	for (let level = 0; level < size.tagDepth; level++) {
		const segs = Array.from({ length: level + 1 }, (_, s) => String.fromCharCode(97 + (s % 26)) + (s >= 26 ? String(Math.floor(s / 26)) : ""));
		const key = segs.join("/");
		chain.push(key);
		addTag(key, level + 3);
	}

	// Tasks.
	let taskSeq = 0;
	const parentIds = new Set<string>();
	const openPlain: string[] = [];
	const lateSchedule = (): { scheduled: DateSpec | null; deadline: DateSpec | null } => {
		const r = rnd();
		let date: string | null = null;
		if (r < 0.08) date = today;
		else if (r < 0.23) date = addDays(today, -(1 + Math.floor(rnd() * 30)));
		else if (r < 0.55) date = addDays(today, 1 + Math.floor(rnd() * 14));
		else if (r < 0.75) date = addDays(today, 15 + Math.floor(rnd() * 60));
		let scheduled: DateSpec | null = null;
		if (date !== null) {
			scheduled = rnd() < 0.25 ? { kind: "datetime", local: `${date}T${pad(7 + Math.floor(rnd() * 13))}:${pick(["00", "15", "30", "45"])}`, tz: zone } : { kind: "date", date };
		}
		const deadline: DateSpec | null = date !== null && rnd() < 0.1 ? { kind: "date", date: addDays(date, 1 + Math.floor(rnd() * 5)) } : null;
		return { scheduled, deadline };
	};
	const priority = (): Priority => {
		const r = rnd();
		return r < 0.55 ? 0 : r < 0.7 ? 3 : r < 0.85 ? 2 : 1;
	};
	const title = (): string => `${pick(VERBS)} ${pick(OBJECTS)}${rnd() < 0.2 ? ` ${pick(EXTRAS)}` : ""}`;
	const tagKeysFor = (i: number): string[] => {
		if (usableTags.length === 0) return [];
		const a = spread(i, usableTags.length);
		if (i % 11 === 0) return [...new Set([usableTags[a] as string, usableTags[spread(i + 7, usableTags.length)] as string])];
		if (i % 3 === 0) return [usableTags[a] as string];
		return [];
	};
	const makeTask = (patch: Partial<Task> & { categoryId: string }): Task => {
		const n = taskSeq++;
		const created = instantAgo(1 + Math.floor(rnd() * 120));
		const t: Task = {
			id: uuid(K_TASK, n + 1),
			title: title(),
			descriptionNote: null,
			tagKeys: [],
			parentId: null,
			sectionId: null,
			scheduled: null,
			deadline: null,
			plannedDurationMin: rnd() < 0.15 ? pick([15, 30, 45, 60, 90]) : null,
			urgent: rnd() < 0.2,
			important: rnd() < 0.25,
			priority: priority(),
			status: "open",
			completedAt: null,
			recurrence: null,
			sortKey: sortKey(n + 1),
			createdAt: created,
			modifiedAt: created,
			...patch,
		};
		tasks.set(t.id, t);
		return t;
	};
	const finishSome = (t: Task): Task => {
		if (rnd() >= 0.15) return t;
		const done: Task = { ...t, status: "completed", completedAt: instantAgo(Math.floor(rnd() * 20), 17) };
		tasks.set(done.id, done);
		return done;
	};

	const listPool = size.bigListTasks > 0 ? listIds.slice(1) : listIds;
	const pool = [INBOX_ID, INBOX_ID, ...listPool];
	const chainTagged = (i: number): string[] | null => {
		if (chain.length === 0 || i >= 15) return null;
		const keys = [chain[i % chain.length] as string];
		if (i % 5 === 0) keys.push(chain[chain.length - 1] as string);
		return [...new Set(keys)];
	};
	let top: Task | null = null;
	for (let i = 0; i < size.tasks; i++) {
		const slot = i % 25;
		if ((slot === 1 || slot === 2) && top !== null) {
			// Two subtasks under every 25th task, in the parent's list.
			const parent: Task = top;
			parentIds.add(parent.id);
			finishSome(makeTask({ categoryId: parent.categoryId, sectionId: parent.sectionId, parentId: parent.id, title: `${pick(VERBS)} ${pick(OBJECTS)}`, sortKey: sortKey(i + 1) }));
			continue;
		}
		const categoryId = pool[spread(i, pool.length)] as string;
		const { scheduled, deadline } = lateSchedule();
		const t = makeTask({
			categoryId,
			sectionId: sectionFor(categoryId),
			scheduled,
			deadline,
			tagKeys: chainTagged(i) ?? tagKeysFor(i),
		});
		top = finishSome(t);
	}
	// Only top-level tasks that are open and have no subtasks may be completed by the harness (no confirmation dialog).
	for (const t of tasks.values()) if (t.status === "open" && t.parentId === null && t.recurrence === null && !parentIds.has(t.id) && t.categoryId === INBOX_ID) openPlain.push(t.id);

	// Extra tasks in Big list.
	for (let j = 0; j < size.bigListTasks; j++) {
		const { scheduled, deadline } = lateSchedule();
		finishSome(makeTask({ categoryId: bigListId, sectionId: sectionFor(bigListId), scheduled, deadline, tagKeys: tagKeysFor(j) }));
	}

	// One parent with N subtasks.
	let parentTaskId: string | null = null;
	if (size.parentSubtasks > 0) {
		const parent = makeTask({ categoryId: bigListId, title: `Release checklist with ${size.parentSubtasks} steps`, sortKey: sortKey(0) });
		parentTaskId = parent.id;
		for (let s = 0; s < size.parentSubtasks; s++) {
			finishSome(makeTask({ categoryId: bigListId, parentId: parent.id, title: `Step ${s + 1}: ${pick(VERBS).toLowerCase()} ${pick(OBJECTS)}`, sortKey: sortKey(s + 1) }));
		}
	}

	// Timed tasks inside the current month.
	if (size.calendarTasks > 0) {
		const month = today.slice(0, 7);
		const days = daysInMonth(today);
		for (let j = 0; j < size.calendarTasks; j++) {
			const date = `${month}-${pad(1 + (j % days))}`;
			const local = `${date}T${pad(7 + ((j * 3) % 14))}:${["00", "15", "30", "45"][(j * 7) % 4]}`;
			finishSome(
				makeTask({
					categoryId: pool[spread(j, pool.length)] as string,
					scheduled: { kind: "datetime", local, tz: zone },
					plannedDurationMin: j % 10 < 7 ? (j % 2 === 0 ? 30 : 60) : null,
					tagKeys: tagKeysFor(j),
				}),
			);
		}
	}

	// Repeating tasks. The first 100 are daily series with 50 to 69 resolved days behind them.
	if (size.repeating > 0) {
		const rules: RepeatRule[] = [
			rule({}),
			rule({ freq: "weekly", weekdays: ["MO", "WE", "FR"] }),
			rule({ freq: "weekly", interval: 2, weekdays: ["TU"] }),
			rule({ freq: "monthly", monthly: { kind: "day", day: 31 } }),
			rule({ freq: "monthly", monthly: { kind: "nth", n: -1, weekday: "FR" } }),
			rule({ freq: "monthly", interval: 2, monthly: { kind: "lastDay" } }),
			rule({ interval: 3, afterCompletion: true }),
			rule({ time: "09:00", tz: zone }),
		];
		for (let k = 0; k < size.repeating; k++) {
			const history = k < 100;
			const r = history ? (k % 2 === 0 ? (rules[0] as RepeatRule) : (rules[7] as RepeatRule)) : (rules[k % rules.length] as RepeatRule);
			const resolved = history ? 50 + (k % 20) : 0;
			const anchor = history ? addDays(today, -resolved) : addDays(today, -(k % 14));
			const t = makeTask({
				categoryId: pool[spread(k, pool.length)] as string,
				title: `${pick(["Water", "Review", "Back up", "Stretch", "Plan", "Tidy"])} ${pick(["the plants", "the inbox", "the laptop", "the desk", "the week", "the budget"])}`,
				recurrence: { anchor, versions: [{ effectiveFrom: anchor, rule: r }], end: { kind: "never" }, endedAt: null },
				tagKeys: tagKeysFor(k),
			});
			for (let d = 0; d < resolved; d++) {
				const date = addDays(anchor, d);
				const skipped = d % 7 === 3;
				occurrenceRecords.set(`${t.id}:${date}`, {
					taskId: t.id,
					occurrenceDate: date,
					status: skipped ? "skipped" : "done",
					resolvedAt: `${date}T08:00:00.000Z`,
					auto: skipped,
					completedOn: skipped ? null : date,
				});
			}
		}
	}

	// The long title.
	let longTaskId: string | null = null;
	if (size.longTitle > 0) {
		let text = "";
		while (text.length < size.longTitle) text += `${pick(VERBS).toLowerCase()} ${pick(OBJECTS)} `;
		text = text.slice(0, size.longTitle);
		if (text.endsWith(" ")) text = `${text.slice(0, -1)}x`;
		longTaskId = makeTask({ categoryId: INBOX_ID, title: text, sortKey: sortKey(0), scheduled: { kind: "date", date: today } }).id;
	}

	// Habits and check-ins.
	const habitIds: string[] = [];
	for (let h = 0; h < size.habits; h++) {
		const id = uuid(K_HABIT, h + 1);
		const kind = h % 3;
		const goal: HabitGoal =
			kind === 0 ? { type: "binary", target: 1, unit: null, period: "day" } : kind === 1 ? { type: "count", target: 3, unit: null, period: "week" } : { type: "quantity", target: 20, unit: "min", period: "day" };
		const schedule: HabitSchedule = kind === 0 ? { kind: "daily" } : kind === 1 ? { kind: "weekly" } : { kind: "weekdays", days: ["MO", "TU", "WE", "TH", "FR"] };
		const name = h < HABIT_NAMES.length ? (HABIT_NAMES[h] as string) : `Habit ${h + 1}`;
		habits.set(id, {
			id,
			name,
			icon: null,
			color: h % 3 === 0 ? null : (TAG_COLORS[h % TAG_COLORS.length] as TagColor),
			timeOfDay: TIMES_OF_DAY[h % TIMES_OF_DAY.length] as TimeOfDay,
			reminder: null,
			archivedAt: null,
			sortKey: sortKey(h + 1),
			createdAt: instantAgo(HABIT_SPAN_DAYS, 7),
			modifiedAt: instantAgo(HABIT_SPAN_DAYS, 7),
			versions: [{ effectiveFrom: addDays(today, -HABIT_SPAN_DAYS), goal, schedule, weekStart: "MO" }],
		});
		habitIds.push(id);
	}
	if (habitIds.length > 0) {
		const total = size.checkins ?? size.habits * CHECKINS_PER_HABIT;
		let n = 0;
		habitIds.forEach((habitId, h) => {
			const mine = Math.floor(total / habitIds.length) + (h < total % habitIds.length ? 1 : 0);
			const span = Math.min(HABIT_SPAN_DAYS, Math.max(30, Math.ceil(mine * 1.5)));
			const value = h % 3 === 2 ? 20 : 1;
			for (let j = 0; j < mine; j++) {
				const date = addDays(today, -(span - 1) + Math.floor((j * span) / mine));
				const at = `${date}T20:00:00.000Z`;
				const id = uuid(K_CHECKIN, ++n);
				checkins.set(id, { id, habitId, date, value, note: null, createdAt: at, modifiedAt: at, deletedAt: null });
			}
		});
	}

	// Focus records over the past 18 months.
	const taskList = [...tasks.values()].filter((t) => t.parentId === null);
	for (let k = 0; k < size.focus; k++) {
		const date = addDays(today, -(FOCUS_SPAN_DAYS - 1) + Math.floor(((k + 0.5) * FOCUS_SPAN_DAYS) / size.focus));
		const hour = 8 + (k % 10);
		const second = k % 2 === 0 ? 1 : 0;
		const start = `${date}T${pad(hour)}:00:00.000Z`;
		const mid = `${date}T${pad(hour)}:25:00.000Z`;
		const end = second === 1 ? `${date}T${pad(hour)}:55:00.000Z` : mid;
		const task = taskList.length === 0 ? null : (taskList[(k * 17) % taskList.length] as Task);
		const id = uuid(K_FOCUS, k + 1);
		focusSessions.set(id, {
			id,
			deviceId: "d-limits",
			taskId: task === null ? null : task.id,
			taskTitleSnapshot: task === null ? "Focus" : task.title,
			plannedSec: 1500,
			status: k % 10 === 8 ? "stopped" : k % 10 === 9 ? "interrupted" : "completed",
			segments: second === 1 ? [{ start, end: mid }, { start: `${date}T${pad(hour)}:30:00.000Z`, end }] : [{ start, end }],
			unobserved: [],
			splitFrom: null,
			startedAt: start,
			endedAt: end,
			finalizedAt: end,
		});
	}

	const data: DbData = { ...db, categories, sections, tags, tasks, occurrenceRecords, habits, checkins, focusSessions };
	const text = serializeDb(data);
	// Prefer plain tasks in Inbox; fall back to any open plain task when the baseline left Inbox thin.
	const complete = openPlain.slice(0, 5);
	if (complete.length < 3) {
		for (const t of tasks.values()) {
			if (complete.length >= 5) break;
			if (t.status === "open" && t.parentId === null && t.recurrence === null && !parentIds.has(t.id) && !complete.includes(t.id) && t.id !== parentTaskId) complete.push(t.id);
		}
	}
	return {
		text,
		sizeKb: new TextEncoder().encode(text).length / 1024,
		markers: { bigListId, bigListName: BIG_LIST_NAME, completeTaskIds: complete, parentTaskId, longTaskId },
		summary: {
			tasks: tasks.size,
			lists: listIds.length,
			sections: sections.size,
			tags: tags.size,
			habits: habits.size,
			checkins: checkins.size,
			focusSessions: focusSessions.size,
			occurrenceRecords: occurrenceRecords.size,
		},
	};
}
