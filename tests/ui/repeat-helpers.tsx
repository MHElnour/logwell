import type { ButtonSpec } from "../../src/ui/host";
import type { Task } from "../../src/domain/types";
import { type CalMount, click, mountCal, settle } from "./calendar-helpers";

// Shared by the repeating-task UI tests: a mounted app whose host records the Undo notices (message and store label) and
// answers the confirmations it is asked (host.choose), plus the way to a task row and the details pane.
// The clock is 2026-10-01T10:00Z: Thursday 2026-10-01, 12:00 in Europe/Berlin. 2026-10-09 is a Friday.

export { click, settle };

export interface Notice {
	message: string;
	label: string;
}

export interface Choice {
	title: string;
	message: string;
	buttons: string[];
}

export interface M7Mount extends CalMount {
	notices: Notice[];
	/** The confirmations asked, and the answer the next one gets (null cancels). */
	asked: Choice[];
	answer: { value: unknown };
}

export async function mountM7(): Promise<M7Mount> {
	const m = await mountCal();
	const notices: Notice[] = [];
	const asked: Choice[] = [];
	const answer = { value: null as unknown };
	Object.assign(m.host, {
		notifyUndo: (message: string, label: string, mark: number) => {
			notices.push({ message, label });
			m.host.bindUndo(label, mark);
		},
		choose: async (title: string, message: string, buttons: ButtonSpec<unknown>[]) => {
			asked.push({ title, message, buttons: buttons.map((b) => b.label) });
			return answer.value;
		},
	});
	return Object.assign(m, { notices, asked, answer });
}

export const q = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T => {
	const el = root.querySelector<T>(sel);
	if (el === null) throw new Error(`no ${sel}`);
	return el;
};

export const tasksEl = (m: CalMount) => q(m.root, ".cp-tasks");

/** Opens the Inbox of the Tasks section (the harness's tasks are all in it). */
export async function showInbox(m: CalMount): Promise<HTMLElement> {
	await click([...m.root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes("Inbox")));
	return tasksEl(m);
}

export const rowFor = (root: ParentNode, title: string): HTMLElement => {
	const row = [...root.querySelectorAll<HTMLElement>(".cp-task-row")].find((r) => r.querySelector(".cp-task-title")?.textContent?.startsWith(title));
	if (row === undefined) throw new Error(`no row "${title}"`);
	return row;
};

export const rowsFor = (root: ParentNode, title: string): HTMLElement[] =>
	[...root.querySelectorAll<HTMLElement>(".cp-task-row")].filter((r) => r.querySelector(".cp-task-title")?.textContent?.startsWith(title));

/** The pane of the selected task, with its fields open (the date chip toggles them). */
export async function openDetails(m: CalMount, title: string, fields = true): Promise<HTMLElement> {
	const section = await showInbox(m);
	await click(rowFor(section, title));
	const pane = q(section, ".cp-details");
	if (fields && pane.querySelector(".cp-details-fields") === null) await click(q(pane, ".cp-due-chip"));
	return pane;
}

export const lastNotice = (m: M7Mount): Notice | undefined => m.notices[m.notices.length - 1];

export const taskById = (m: CalMount, id: string): Task => m.h.app.store.state.tasks.get(id)!;

/** The Friday in the week after the harness clock's Thursday. */
export const FRIDAY = "2026-10-09";
export const weeklyFriday = {
	rule: { freq: "weekly", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null },
} as const;
