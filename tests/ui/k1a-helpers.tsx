import { type CalMount, click, mountCal, settle } from "./m3-helpers";
import { dragTo, press, releaseAt } from "./m4-helpers";

export { click, dragTo, press, releaseAt, settle };
export type { CalMount };

/** The whole app with the fake clock (2026-10-01T10:00Z, Europe/Berlin: Thursday 12:00). */
export const mountBoard = mountCal;

export const sidebarItem = (root: ParentNode, text: string) =>
	[...root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes(text))!;

export const modeButton = (root: ParentNode, label: "List" | "Board") =>
	[...root.querySelectorAll<HTMLButtonElement>(".cp-tasks .cp-mode-button")].find((b) => b.textContent.trim() === label) ?? null;

/** Opens a sidebar view and switches it to Board. */
export async function openBoard(m: CalMount, view: string): Promise<HTMLElement> {
	await click(sidebarItem(m.root, view));
	await click(modeButton(m.root, "Board"));
	return board(m.root);
}

export const board = (root: ParentNode) => root.querySelector<HTMLElement>(".cp-tasks .cp-board")!;

export const columnEls = (root: ParentNode) => [...board(root).querySelectorAll<HTMLElement>(".cp-board-col")];
export const columnEl = (root: ParentNode, id: string) => columnEls(root).find((c) => c.dataset.column === id)!;
export const columnTitles = (root: ParentNode) => columnEls(root).map((c) => c.querySelector(".cp-board-col-title")!.textContent.trim());

/** The titles of the cards (parents and un-nested subtasks) of a column. */
export const cardTitles = (root: ParentNode, id: string) =>
	[...columnEl(root, id).querySelectorAll<HTMLElement>(".cp-board-card > .cp-board-item")].map((i) => i.querySelector(".cp-board-title")!.textContent.trim());

export const item = (root: ParentNode, text: string): HTMLElement => {
	const found = [...board(root).querySelectorAll<HTMLElement>(".cp-board-item")].find((r) => r.querySelector(".cp-board-title")?.textContent?.trim() === text);
	if (found === undefined) throw new Error(`no board item "${text}"`);
	return found;
};

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) });

/**
 * Fake layout (happy-dom has none): columns are 300 x 800 boxes side by side, the cards in a column are
 * 60 px tall boxes stacked from y = 50. Returns the center of each column and of each card.
 */
export function stubBoardRects(root: ParentNode): { columns: Record<string, { x: number; y: number }>; card: (text: string) => { x: number; y: number } } {
	const columns: Record<string, { x: number; y: number }> = {};
	const centers = new Map<string, { x: number; y: number }>();
	columnEls(root).forEach((col, i) => {
		const left = i * 300;
		col.getBoundingClientRect = () => rect(left, 0, 300, 800);
		columns[col.dataset.column!] = { x: left + 150, y: 700 };
		col.querySelectorAll<HTMLElement>(".cp-board-card").forEach((card, j) => {
			const top = 50 + j * 60;
			card.getBoundingClientRect = () => rect(left, top, 300, 56);
			const parent = card.querySelector<HTMLElement>(".cp-board-item:not(.is-sub)")!;
			parent.getBoundingClientRect = () => rect(left, top, 300, 56);
			centers.set(parent.querySelector(".cp-board-title")!.textContent.trim(), { x: left + 150, y: top + 28 });
			card.querySelectorAll<HTMLElement>(".cp-board-item.is-sub").forEach((sub, k) => {
				const stop = top + 56 + k * 40;
				sub.getBoundingClientRect = () => rect(left, stop, 300, 36);
				centers.set(sub.querySelector(".cp-board-title")!.textContent.trim(), { x: left + 150, y: stop + 18 });
			});
		});
	});
	return { columns, card: (t) => centers.get(t)! };
}
