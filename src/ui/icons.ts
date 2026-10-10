// Lucide icon names used by the UI. One set,
// one stroke width, sized by CSS: 22 px rail, 20 px sidebar, 16 px meta.

export const ICON = {
	// Rail. `railFocus` is also the focus chip and button icon.
	railTasks: "square-check",
	railCalendar: "calendar",
	railFocus: "target",
	railHabits: "flame",
	railMatrix: "layout-grid",
	railSearch: "search",
	railData: "database",
	// Sidebar.
	today: "sun",
	upcoming: "calendar-days",
	inbox: "inbox",
	completed: "circle-check",
	trash: "trash-2",
	add: "plus",
	list: "list",
	/** A list synced with TickTick. */
	sync: "refresh-cw",
	// Calendar header.
	calPrev: "chevron-left",
	calNext: "chevron-right",
	calToday: "calendar-check",
	calUnscheduled: "list-todo",
	// Popovers and meta.
	flag: "flag",
	clock: "clock",
	note: "file-text",
	openNote: "external-link",
	// Habits.
	check: "check",
	bell: "bell",
	more: "more-horizontal",
	edit: "pencil",
	remove: "trash-2",
	archive: "archive",
	restore: "rotate-ccw",
} as const;

type StoredIcon = { kind: "lucide"; name: string } | { kind: "emoji"; text: string };

/**
 * A category's stored icon: a Lucide name renders through setIcon, a legacy
 * emoji stays text, none falls back to `fallback` (default: the list icon).
 */
export function categoryIcon(stored: string | null | undefined, fallback: string = ICON.list): StoredIcon {
	if (stored === null || stored === undefined || stored === "") return { kind: "lucide", name: fallback };
	if (/^[a-z0-9-]+$/.test(stored)) return { kind: "lucide", name: stored };
	return { kind: "emoji", text: stored };
}

/** The curated Lucide names offered for a list icon. */
export const LIST_ICONS: readonly string[] = [
	"list", "book-open", "briefcase", "home", "dumbbell", "heart", "star", "code", "graduation-cap", "shopping-cart",
	"plane", "music", "camera", "wallet", "leaf", "coffee", "gamepad-2", "palette", "wrench", "users",
	"folder", "bookmark", "lightbulb", "target", "flag", "calendar", "inbox", "archive", "activity", "zap",
];

/**
 * A list's name for text-only places (native <select> options, suggestions, menus).
 * A list icon is a Lucide name drawn with setIcon, so it is never put in text:
 * printing it would show "book-open Study".
 */
export function categoryText(category: { name: string }): string {
	return category.name;
}

