import type { BlockFilters } from "../parsing/blockQuery";
import { resolveListName } from "../domain/tasks";
import { isUnderTag, resolveTagName, tagNamesOf } from "../domain/tags";
import { INBOX_ID, type Task } from "../domain/types";
import type { DbData } from "../persistence/schema";
import type { TaskView } from "./views";

// Which view of the app a `logwell` block opens, and where a task opened from a block row is shown.

/**
 * The view that comes closest to what `filters` show: the list when there is one, else the tag (when the tags
 * come down to one), else Today (`due` or `scheduled` today or overdue) or Upcoming (a range ahead). Filters no view shows (priority, quadrant, linked) or
 * names that do not exist give null: the caller then just opens the app.
 */
export function blockOpenView(filters: BlockFilters, state: Pick<DbData, "categories" | "tags">): TaskView | null {
	if (filters.list !== undefined) {
		const match = resolveListName(state.categories.values(), filters.list);
		if (match.kind !== "one") return null;
		const list = match.list;
		return list.id === INBOX_ID ? { kind: "inbox" } : { kind: "category", id: list.id };
	}
	if (filters.tags !== undefined) {
		// The same rule as the block's own check: a full key, a name alone, or the parent of tags. A name that is no tag opens nothing.
		const names = tagNamesOf(state.tags);
		const keys: string[] = [];
		for (const typed of filters.tags) {
			const key = resolveTagName(names, typed);
			if (key === null) return null;
			if (!keys.includes(key)) keys.push(key);
		}
		// A tag under another selected tag adds nothing: the parent's view already holds it.
		const top = keys.filter((key) => !keys.some((other) => other !== key && isUnderTag(key, other)));
		// One tag has a view; several unrelated tags have none, so the dates decide.
		if (top.length === 1) return { kind: "tag", key: top[0]! };
	}
	const dates = [filters.due, filters.scheduled];
	if (dates.some((d) => d === "today" || d === "overdue")) return { kind: "today" };
	if (dates.some((d) => d !== undefined)) return { kind: "upcoming" };
	return null;
}

/** The view that shows `task` among its neighbours: its list, or the Inbox. */
export function taskListView(task: Pick<Task, "categoryId">): TaskView {
	return task.categoryId === INBOX_ID ? { kind: "inbox" } : { kind: "category", id: task.categoryId };
}
