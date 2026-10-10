import type { TaskPatch } from "../app/TaskService";
import type { GroupDrop, ViewGroup } from "../app/views";
import type { QueryContext } from "../domain/queries";
import type { DateSpec, Task } from "../domain/types";
import { columnPatch } from "./board/BoardView";
import { formatDate } from "./format";

// What dropping a list row on another group writes, and what the group is called.

/**
 * The patch a drop on a group makes (empty when the task is there already). A date drop is the board's:
 * the day changes and the time stays, and dropping on today also moves a deadline that is past.
 */
export function groupPatch(task: Task, drop: GroupDrop, ctx: QueryContext, schedule?: DateSpec | null): TaskPatch {
	switch (drop.kind) {
		case "section":
			return task.sectionId === drop.sectionId ? {} : { sectionId: drop.sectionId };
		case "list":
			return task.categoryId === drop.categoryId ? {} : { categoryId: drop.categoryId };
		case "priority":
			return task.priority === drop.priority ? {} : { priority: drop.priority };
		case "date":
			return columnPatch(
				task,
				{ id: drop.date === ctx.today ? "today" : drop.date, title: "", date: drop.date, acceptsDrop: true, cards: [], completed: [] },
				ctx,
				schedule,
			);
	}
}

/** The name a group shows in its heading, for the Undo notice: "Work", "High", "Today", "Mon, Oct 5". */
export function groupTitle(g: ViewGroup, ctx: QueryContext): string {
	return g.section?.name ?? g.label ?? (g.date === null ? "" : formatDate(g.date, ctx.today));
}
