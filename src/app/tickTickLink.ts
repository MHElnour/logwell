import { isInboxProjectId } from "../domain/ticktick/inbox";
import type { ID } from "../domain/types";
import type { DbData } from "../persistence/schema";
import type { TickTickApi } from "./ports";
import type { ListIndex } from "./listIndex";
import { INBOX_ALIAS, canonicalProjectId } from "./tickTickInbox";

// What the "Sync with TickTick" link dialog offers for one list. Pure over the TickTick
// client and the database; the dialogs and the flow that use it are in src/obsidian.

/** Where the list is linked to: an existing TickTick project, or a new one with the list's name. */
export type LinkTarget = { kind: "existing"; projectId: string; name: string } | { kind: "create"; name: string };

export interface LinkOption {
	key: string;
	label: string;
	/** Short note on the right: "new, empty", "Linked to Home", "Note list: can't sync". */
	detail: string;
	/** Shown but not selectable: a note list, or a project another list is already linked to. */
	disabled: boolean;
	target: LinkTarget;
}

/** TickTick's own name for its Inbox project; the project list does not include it. */
const INBOX_LABEL = "Inbox";

/**
 * The options of the dialog, in order: create a project named like the list, TickTick's Inbox, then the projects.
 * Closed (archived) projects are left out. One request, for the project list; the Inbox is offered under its alias without being read, so it can be linked even when empty.
 */
export async function loadLinkOptions(api: Pick<TickTickApi, "listProjects">, state: DbData, listId: ID): Promise<LinkOption[]> {
	const list = state.categories.get(listId);
	const listName = list?.name ?? "";
	const linkedTo = new Map<string, string>();
	for (const l of state.syncLinks.values()) {
		if (l.kind !== "list") continue;
		const name = state.categories.get(l.logwellId)?.name ?? "another list";
		// An Inbox link may be spelled `inbox` or with the real id (one written by an early build).
		linkedTo.set(canonicalProjectId(l.ttId), name);
	}
	const projects = await api.listProjects();
	const options: LinkOption[] = [
		{ key: "create", label: `Create “${listName}” in TickTick`, detail: "new, empty", disabled: false, target: { kind: "create", name: listName } },
	];
	const existing = (projectId: string, name: string, kind: string | undefined): LinkOption => {
		const other = linkedTo.get(projectId);
		const note = kind === "NOTE";
		return {
			key: projectId,
			label: name,
			detail: other !== undefined ? `Linked to ${other}` : note ? "Note list: can't sync" : "",
			disabled: other !== undefined || note,
			target: { kind: "existing", projectId, name },
		};
	};
	// Offered under the alias, which the engine accepts for everything it reads, so it is linkable even when empty.
	options.push(existing(INBOX_ALIAS, INBOX_LABEL, undefined));
	for (const p of projects) if (p.closed !== true && !isInboxProjectId(p.id)) options.push(existing(p.id, p.name, p.kind));
	return options;
}

/** The option that starts selected: an enabled project with the list's name, else creating one. */
export function defaultOption(options: readonly LinkOption[], listName: string): LinkOption | undefined {
	const same = options.find((o) => !o.disabled && o.target.kind === "existing" && o.label.toLowerCase() === listName.toLowerCase());
	return same ?? options.find((o) => !o.disabled);
}

/** The open tasks of the list that a first sync sends (repeating tasks do not sync). */
export function countPushable(state: DbData, index: Pick<ListIndex, "tasksOf">, listId: ID): number {
	let n = 0;
	for (const t of index.tasksOf((id) => state.tasks.get(id), listId)) if (t.status === "open" && t.recurrence === null) n++;
	return n;
}
