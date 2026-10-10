import type { ID, Task } from "./types";
import { compareNewestFirst } from "./completed";
import { compareSortKeys } from "./sortKey";
import { type ListEntry, type Quadrant, type QueryContext, entryOf, hasPastDate, keyDate, nextSevenDaysEnd, quadrantOf, scheduleOf } from "./queries";
import { dateSpecSortValue } from "./time";

// The Eisenhower matrix layout. Pure: it takes the tasks the view menu let
// through and returns, per quadrant, the date groups to draw. A task's quadrant comes only from its
// urgent and important flags; a schedule, a deadline or a priority never changes it.

/** Grid order: I top left, II top right, III bottom left, IV bottom right. */
export const QUADRANT_ORDER: readonly Quadrant[] = ["urgent-important", "important", "urgent", "neither"];

export function quadrantFlags(q: Quadrant): { urgent: boolean; important: boolean } {
	return { urgent: q === "urgent-important" || q === "urgent", important: q === "urgent-important" || q === "important" };
}

export type MatrixGroupId = "overdue" | "today" | "next7" | "later" | "nodate" | "completed";

export interface MatrixGroup {
	id: MatrixGroupId;
	label: string;
	tone?: "overdue" | "today";
	entries: ListEntry[];
}

const GROUPS: { id: MatrixGroupId; label: string; tone?: "overdue" | "today" }[] = [
	{ id: "overdue", label: "Overdue", tone: "overdue" },
	{ id: "today", label: "Today", tone: "today" },
	{ id: "next7", label: "Next 7 days" },
	{ id: "later", label: "Later" },
	{ id: "nodate", label: "No date" },
	{ id: "completed", label: "Completed" },
];

function groupOf(task: Task, ctx: QueryContext, held: ReadonlySet<ID>): MatrixGroupId {
	// A task completed a moment ago stays in its date group until its check animation ends.
	if (task.status === "completed" && !held.has(task.id)) return "completed";
	if (hasPastDate(task, ctx)) return "overdue";
	const key = keyDate(task, ctx);
	if (key === null) return "nodate";
	if (key <= ctx.today) return "today";
	return key <= nextSevenDaysEnd(ctx) ? "next7" : "later";
}

/** Scheduled tasks first by time, then the rest; ties by creation time, then id. */
function compareInGroup(ctx: QueryContext): (a: Task, b: Task) => number {
	// A repeating task is placed by its current occurrence.
	return (a, b) => {
		const schedA = scheduleOf(a, ctx);
		const schedB = scheduleOf(b, ctx);
		if ((schedA === null) !== (schedB === null)) return schedA === null ? 1 : -1;
		if (schedA !== null && schedB !== null) {
			const sa = dateSpecSortValue(schedA, ctx.zone);
			const sb = dateSpecSortValue(schedB, ctx.zone);
			if (sa !== sb) return sa < sb ? -1 : 1;
		}
		if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
		return compareSortKeys(a.id, b.id);
	};
}

export function matrixQuadrants(
	tasks: Iterable<Task>,
	byId: ReadonlyMap<ID, Task>,
	ctx: QueryContext,
	held: ReadonlySet<ID> = new Set(),
): Record<Quadrant, MatrixGroup[]> {
	const buckets = {} as Record<Quadrant, Map<MatrixGroupId, Task[]>>;
	for (const q of QUADRANT_ORDER) buckets[q] = new Map();
	for (const t of tasks) {
		const g = groupOf(t, ctx, held);
		const bucket = buckets[quadrantOf(t)];
		const list = bucket.get(g);
		if (list === undefined) bucket.set(g, [t]);
		else list.push(t);
	}
	const cmp = compareInGroup(ctx);
	const out = {} as Record<Quadrant, MatrixGroup[]>;
	for (const q of QUADRANT_ORDER) {
		out[q] = GROUPS.flatMap((def) => {
			const list = buckets[q].get(def.id);
			if (list === undefined) return [];
			const entries = list.sort(def.id === "completed" ? compareNewestFirst : cmp).map<ListEntry>((task) => entryOf(task, byId, ctx));
			return [{ ...def, entries }];
		});
	}
	return out;
}
