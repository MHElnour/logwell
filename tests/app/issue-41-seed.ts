import { type DateSpec, type ID, INBOX_ID, type LocalDate, type Priority, type RepeatRule, type Task } from "../../src/domain/types";
import { addDays } from "../../src/domain/time";
import type { JournalOp } from "../../src/persistence/journal";
import { makeTask } from "../persistence/fixtures";
import { type AppHarness, appHarness } from "./harness";

// A seeded, realistic task state for the Tasks view tests of issue 41: lists with and without sections,
// nested tags (one parent without a record), subtasks (completed ones under open and completed parents,
// some in another list or section than their parent), dates around today (overdue, today, the Upcoming
// range, beyond it), deadlines, priorities, repeating tasks with done and skipped occurrence records.
// The same seed always gives the same state.

/** A small deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const TITLES = ["Call the bank", "Buy milk", "Pay rent", "Water the plants", "Book the dentist", "Call mom", "Clean the kitchen", "Read chapter 3", "Plan the trip", "Send the invoice", "Fix the bike", "Walk the dog"];

const rule = (r: Partial<RepeatRule>): RepeatRule => ({ freq: "daily", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null, ...r });

export interface SeededState {
	h: AppHarness;
	lists: ID[];
	tagKeys: string[];
	/** Tasks the views treat as just completed, waiting for their check animation (with open ones mixed in). */
	held: ReadonlySet<ID>;
}

export async function seededState(seed = 41, count = 240): Promise<SeededState> {
	const h = await appHarness();
	const rnd = seededRandom(seed);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
	const app = h.app;
	const lists: ID[] = [];
	for (const name of ["Work", "Home", "Errands"]) lists.push((await app.categories.create(name)).id);
	const sectionsOf = new Map<ID, ID[]>([[INBOX_ID, []]]);
	for (const id of lists) sectionsOf.set(id, []);
	const addSection = async (list: ID, name: string) => sectionsOf.get(list)!.push((await app.sections.create(list, name)).id);
	await addSection(INBOX_ID, "Soon");
	await addSection(INBOX_ID, "Later");
	await addSection(lists[0]!, "Meetings");
	await addSection(lists[0]!, "Admin");
	await addSection(lists[2]!, "Shops");
	for (const raw of ["Work", "Work/Meetings", "Home", "Errands", "Garden/Roses"]) await app.tags.create(raw);
	// "garden" has no record of its own: an implicit parent tag.
	const tagKeys = ["work", "work/meetings", "home", "errands", "garden/roses"];
	const today = app.queryContext().today;

	// Repeating tasks, then some of their occurrences done or skipped at different times of the day.
	const repeating: Task[] = [];
	const repeat = async (title: string, scheduled: LocalDate, r: Partial<RepeatRule>, extra: { categoryId?: ID; newTags?: string[] } = {}) =>
		repeating.push((await app.tasks.create({ title, scheduled: { kind: "date", date: scheduled }, repeat: { rule: rule(r) }, ...extra })).task);
	await repeat("Water the plants daily", today, {});
	await repeat("Call mom weekly", addDays(today, -3), { freq: "weekly" }, { categoryId: lists[1], newTags: ["Home"] });
	await repeat("Pay rent monthly", addDays(today, 2), { freq: "monthly" }, { categoryId: lists[1] });
	await repeat("Send the timesheet", addDays(today, -2), { freq: "daily", interval: 2 }, { categoryId: lists[0], newTags: ["Work/Meetings"] });
	await repeat("Walk the dog every day", addDays(today, -1), { afterCompletion: true }, { categoryId: lists[2] });
	await repeat("Buy milk each week", addDays(today, 1), { freq: "weekly" }, { newTags: ["Errands"] });
	for (const [i, t] of repeating.entries()) {
		h.clock.advance(7 * 60_000);
		if (i % 3 !== 2) await app.recurrence.complete(t.id);
		h.clock.advance(5 * 60_000);
		if (i % 2 === 0) await app.recurrence.complete(t.id);
		if (i === 3) await app.recurrence.skip(t.id);
	}

	// Plain tasks, written at once.
	const data = h.store.data;
	const tasks = new Map(data.tasks);
	const ops: JournalOp[] = [];
	const created: Task[] = [];
	const dateAround = (): DateSpec | null => {
		const r = rnd();
		if (r < 0.4) return null;
		const date = addDays(today, Math.floor(rnd() * 26) - 6);
		if (r < 0.85) return { kind: "date", date };
		return { kind: "datetime", local: `${date}T${pick(["08:30", "13:00", "21:15"])}`, tz: "Europe/Berlin" };
	};
	const completedAt = (): string => {
		const day = addDays(today, -Math.floor(rnd() * 4));
		return `${day}T${pick(["06:10", "09:45", "15:30", "21:05"])}:00.000Z`;
	};
	for (let i = 0; i < count; i++) {
		const id = `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`;
		const roots = created.filter((t) => t.parentId === null);
		const sub = roots.length > 0 && rnd() < 0.35;
		const parent = sub ? pick([...roots, ...repeating.slice(0, 2)]) : null;
		// A subtask mostly shares its parent's list and section; some do not (moved, or the parent moved).
		const own = parent === null || rnd() < 0.15;
		const categoryId = own ? pick([INBOX_ID, INBOX_ID, ...lists]) : parent.categoryId;
		const sections = sectionsOf.get(categoryId) ?? [];
		const sectionId = own ? (sections.length > 0 && rnd() < 0.6 ? pick(sections) : null) : parent.sectionId;
		const done = rnd() < 0.3;
		const tagCount = rnd() < 0.5 ? 0 : rnd() < 0.7 ? 1 : 2;
		const keys = [...new Set(Array.from({ length: tagCount }, () => pick(tagKeys)))];
		const t = makeTask(id, {
			title: `${pick(TITLES)} ${i}`,
			categoryId,
			sectionId,
			parentId: parent?.id ?? null,
			tagKeys: keys,
			scheduled: dateAround(),
			deadline: rnd() < 0.15 ? { kind: "date", date: addDays(today, Math.floor(rnd() * 12) - 4) } : null,
			priority: pick([0, 0, 1, 2, 3] as Priority[]),
			status: done ? "completed" : "open",
			completedAt: done ? completedAt() : null,
			// A few ties: the sort key is not unique.
			sortKey: `V${Math.floor(rnd() * 900).toString(36).padStart(3, "0")}`,
		});
		created.push(t);
		tasks.set(t.id, t);
		ops.push({ c: "tasks", id: t.id, v: t });
	}
	h.store.commit({ ...data, tasks }, ops);

	const held = new Set<ID>();
	const completedSubs = created.filter((t) => t.status === "completed" && t.parentId !== null);
	const completedRoots = created.filter((t) => t.status === "completed" && t.parentId === null);
	for (let i = 0; i < 6; i++) held.add(pick(completedSubs).id);
	for (let i = 0; i < 6; i++) held.add(pick(completedRoots).id);
	for (let i = 0; i < 3; i++) held.add(pick(created).id);
	held.add(repeating[0]!.id);
	return { h, lists, tagKeys: [...tagKeys, "garden"], held };
}
