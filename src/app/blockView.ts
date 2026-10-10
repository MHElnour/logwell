import type { BlockFilters } from "../parsing/blockQuery";
import { findListByName } from "../domain/tasks";
import { hasTagOrChild, normalizeTagKey } from "../domain/tags";
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
		const list = findListByName(state.categories, filters.list);
		if (list === undefined) return null;
		return list.id === INBOX_ID ? { kind: "inbox" } : { kind: "category", id: list.id };
	}
	if (filters.tag !== undefined) {
		const key = normalizeTagKey(filters.tag);
		// A tag exists as a record or as the path prefix of one (a parent), as in the block's own check.
		return hasTagOrChild(state.tags.keys(), key) ? { kind: "tag", key } : null;
	}
	if (filters.due === "today" || filters.due === "overdue") return { kind: "today" };
	if (filters.due !== undefined) return { kind: "upcoming" };
	return null;
}

/** The view that shows `task` among its neighbours: its list, or the Inbox. */
export function taskListView(task: Pick<Task, "categoryId">): TaskView {
	return task.categoryId === INBOX_ID ? { kind: "inbox" } : { kind: "category", id: task.categoryId };
}
