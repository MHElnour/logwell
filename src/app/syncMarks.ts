import { listsInSidebarOrder } from "../domain/tasks";
import type { ID, SyncLink, Task } from "../domain/types";
import { syncLinkId } from "../domain/types";
import type { DbData } from "../persistence/schema";

// What the UI marks as synced, read from the links alone. One reader for the sidebar
// marker, the list header and the "Not synced" chip.

type Links = ReadonlyMap<string, SyncLink>;

/** The list is linked to a TickTick project (the sidebar marker and the list header). */
export function isListSynced(links: Links, listId: ID): boolean {
	return links.has(syncLinkId("list", listId));
}

/** A list linked to TickTick: the Logwell list's id and name, and its link. */
export interface LinkedList {
	listId: ID;
	name: string;
	link: SyncLink;
}

/**
 * The lists linked to TickTick, in sidebar order (Inbox first). A link whose Logwell list does not exist (not arrived yet, or gone)
 * is left out. Read over the lists, which are few, never over every link (each synced task has one).
 */
export function linkedLists(state: Pick<DbData, "categories" | "syncLinks">): LinkedList[] {
	const out: LinkedList[] = [];
	for (const list of listsInSidebarOrder(state.categories.values())) {
		const link = state.syncLinks.get(syncLinkId("list", list.id));
		if (link !== undefined) out.push({ listId: list.id, name: list.name, link });
	}
	return out;
}

/** Whether any existing list is linked to TickTick (`linkedLists` is not empty), without building the list. */
export function hasLinkedList(state: Pick<DbData, "categories" | "syncLinks">): boolean {
	for (const id of state.categories.keys()) if (isListSynced(state.syncLinks, id)) return true;
	return false;
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
