import type { ID, SyncLink, Task } from "../domain/types";
import { syncLinkId } from "../domain/types";

// What the UI marks as synced, read from the links alone. One reader for the sidebar
// marker, the list header and the "Not synced" chip.

type Links = ReadonlyMap<string, SyncLink>;

/** The list is linked to a TickTick project (the sidebar marker and the list header). */
export function isListSynced(links: Links, listId: ID): boolean {
	return links.has(syncLinkId("list", listId));
}

/** Why an open task in a synced list is not synced (the "Not synced" chip), or null when it syncs or is not in a synced list. */
export type NotSyncedReason = "repeats" | "excluded" | "kept";

/**
 * An open task of a synced list that does not sync: it repeats in Logwell, its link is `excluded` (it repeats
 * in TickTick) or `localOnly` (kept in Logwell only). A task whose link has not arrived yet is not marked.
 */
export function notSyncedReason(links: Links, task: Pick<Task, "id" | "categoryId" | "status" | "recurrence">): NotSyncedReason | null {
	if (links.size === 0 || task.status !== "open" || !isListSynced(links, task.categoryId)) return null;
	if (task.recurrence !== null) return "repeats";
	const mode = links.get(syncLinkId("task", task.id))?.mode;
	if (mode === "excluded") return "excluded";
	if (mode === "localOnly") return "kept";
	return null;
}

/** The chip's tooltip. */
export const NOT_SYNCED_TITLE: Record<NotSyncedReason, string> = {
	repeats: "Repeating tasks are not synced with TickTick",
	excluded: "This task repeats in TickTick, so it is not synced",
	kept: "Kept in Logwell only, not synced with TickTick",
};
