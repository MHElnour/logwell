import type { GroupTone, ListEntry, QueryContext } from "./queries";
import { addDays, utcDay } from "./time";
import type { ID, LocalDate } from "./types";

// Board columns: the types and pure helpers. `buildBoard` is in app/views.ts, because
// it reads the store state and domain/ must not import app/ or persistence/.

/** A card and the subtasks nested in it; empty when it has none or they are not nested. */
export interface BoardCard {
	entry: ListEntry;
	subtasks: ListEntry[];
}

export interface BoardColumn {
	/** "overdue" | "today" | a LocalDate | "none" (no section). */
	id: string;
	/** "Overdue", "Today", "Sunday, Tomorrow", "Monday, Oct 5", "No section". */
	title: string;
	tone?: GroupTone;
	/** The day a drop schedules; null = no date change. */
	date: LocalDate | null;
	/** Inbox and list boards: null for "No section" (id "none"), else the section id (id = the section id). */
	sectionId?: ID | null;
	/** False for Overdue. */
	acceptsDrop: boolean;
	/** Open (and held) tasks, ordered per the sort. */
	cards: BoardCard[];
	/** The column's Completed group, newest first. */
	completed: ListEntry[];
}

/** Day title: "Sunday, Tomorrow", then "Monday, Oct 5". */
export function dayTitle(date: LocalDate, ctx: QueryContext): string {
	const dt = utcDay(date);
	return date === addDays(ctx.today, 1) ? `${dt.toFormat("cccc")}, Tomorrow` : dt.toFormat("cccc, LLL d");
}

/**
 * Nests a subtask in its parent's card when the parent is in the same column; any other
 * subtask is a card of its own with the "Parent ›" prefix. Order follows `entries`.
 */
export function toCards(entries: ListEntry[]): BoardCard[] {
	const here = new Set(entries.map((e) => e.task.id));
	const cards = new Map<ID, BoardCard>();
	const result: BoardCard[] = [];
	const nested: ListEntry[] = [];
	for (const e of entries) {
		const parentId = e.task.parentId;
		if (parentId !== null && here.has(parentId)) {
			nested.push({ ...e, depth: 1, parentTitle: null });
			continue;
		}
		const card: BoardCard = { entry: { ...e, depth: 0 }, subtasks: [] };
		cards.set(e.task.id, card);
		result.push(card);
	}
	for (const e of nested) cards.get(e.task.parentId!)?.subtasks.push(e);
	return result;
}
