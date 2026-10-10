// "Group by" in List mode: the options each view offers and their defaults.

export type GroupBy = "none" | "section" | "date" | "priority" | "tag" | "list";

/** The `TaskView` kinds, repeated here because domain/ must not import app/. */
export type GroupViewKind = "today" | "upcoming" | "inbox" | "category" | "tag" | "completed" | "trash";

export const GROUP_BY_TITLE: Record<GroupBy, string> = {
	none: "None",
	section: "Section",
	date: "Date",
	priority: "Priority",
	tag: "Tag",
	list: "List",
};

/** The options of a view, in menu order. Completed and Trash have none. */
export function groupByOptions(kind: GroupViewKind): GroupBy[] {
	switch (kind) {
		case "inbox":
		case "category":
			return ["none", "section", "date", "priority", "tag"];
		case "today":
		case "upcoming":
			return ["date", "list", "priority", "tag", "none"];
		case "tag":
			return ["none", "date", "list", "priority"];
		case "completed":
		case "trash":
			return [];
	}
}

/** Today and Upcoming group by date; everything else is a plain list. */
export function defaultGroupBy(kind: GroupViewKind): GroupBy {
	return kind === "today" || kind === "upcoming" ? "date" : "none";
}

/** The grouping a view uses: its stored choice when that is one of its options, else the default. */
export function effectiveGroupBy(kind: GroupViewKind, stored: GroupBy | undefined): GroupBy {
	return stored !== undefined && groupByOptions(kind).includes(stored) ? stored : defaultGroupBy(kind);
}
