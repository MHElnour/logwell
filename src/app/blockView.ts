import type { BlockFilters } from "../parsing/blockQuery";
import { resolveListName } from "../domain/tasks";
import { resolveTagName, tagNamesOf } from "../domain/tags";
import { INBOX_ID, type Task } from "../domain/types";
import type { DbData } from "../persistence/schema";
import type { TaskView } from "./views";

// Which view of the app a `logwell` block opens, and where a task opened from a block row is shown.

/**
 * The view that comes closest to what `filters` show: the list when there is one, else the tag, else Today
 * (due today or overdue) or Upcoming (a range ahead). Filters no view shows (priority, quadrant, linked) or
 * names that do not exist give null: the caller then just opens the app.
 */
export function blockOpenView(filters: BlockFilters, state: Pick<DbData, "categories" | "tags">): TaskView | null {
	if (filters.list !== undefined) {
		const match = resolveListName(state.categories.values(), filters.list);
		if (match.kind !== "one") return null;
		const list = match.list;
		return list.id === INBOX_ID ? { kind: "inbox" } : { kind: "category", id: list.id };
	}
	if (filters.tag !== undefined) {
		// The same rule as the block's own check: a full key, a name alone, or the parent of tags.
		const key = resolveTagName(tagNamesOf(state.tags), filters.tag);
		return key === null ? null : { kind: "tag", key };
	}
	if (filters.due === "today" || filters.due === "overdue") return { kind: "today" };
	if (filters.due !== undefined) return { kind: "upcoming" };
	return null;
}

/** The view that shows `task` among its neighbours: its list, or the Inbox. */
export function taskListView(task: Pick<Task, "categoryId">): TaskView {
	return task.categoryId === INBOX_ID ? { kind: "inbox" } : { kind: "category", id: task.categoryId };
}
