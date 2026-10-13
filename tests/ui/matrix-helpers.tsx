import type { Quadrant } from "../../src/domain/queries";
import { QUADRANT_ORDER } from "../../src/domain/matrix";
import { type AppMount, click, rect } from "./app-helpers";

export const matrix = (root: ParentNode) => root.querySelector<HTMLElement>(".cp-matrix")!;

export async function openMatrix(m: AppMount): Promise<HTMLElement> {
	await click(m.root.querySelector('.cp-rail [aria-label="Matrix"]'));
	return matrix(m.root);
}

export const quadrantEl = (root: ParentNode, q: Quadrant) => matrix(root).querySelector<HTMLElement>(`.cp-matrix-q[data-quadrant="${q}"]`)!;

export const cardsIn = (root: ParentNode, q: Quadrant) => [...quadrantEl(root, q).querySelectorAll<HTMLElement>(".cp-task-row")];

export const titlesIn = (root: ParentNode, q: Quadrant) => cardsIn(root, q).map((r) => r.querySelector(".cp-task-title")!.textContent.trim());

export const groupLabels = (root: ParentNode, q: Quadrant) =>
	[...quadrantEl(root, q).querySelectorAll(".cp-matrix-group-label, .cp-completed-toggle")].map((e) => e.textContent.trim());

/** The quadrant's Completed group toggle, or null when it has none. */
export const completedToggle = (root: ParentNode, q: Quadrant) => quadrantEl(root, q).querySelector<HTMLButtonElement>(".cp-completed-toggle");

/** The card for a task title, anywhere in the matrix. */
export function card(root: ParentNode, text: string): HTMLElement {
	const found = [...matrix(root).querySelectorAll<HTMLElement>(".cp-task-row")].find((r) => r.querySelector(".cp-task-title")?.textContent?.includes(text));
	if (found === undefined) throw new Error(`no card "${text}"`);
	return found;
}

export const quadrantOfCard = (el: HTMLElement) => el.closest<HTMLElement>(".cp-matrix-q")?.dataset.quadrant;

/** Fake layout: happy-dom has none, so give the four quadrants a 2x2 grid of 500 x 400 boxes. */
export function stubQuadrantRects(root: ParentNode): Record<Quadrant, { x: number; y: number }> {
	const centers = {} as Record<Quadrant, { x: number; y: number }>;
	QUADRANT_ORDER.forEach((q, i) => {
		const left = (i % 2) * 500;
		const top = (i >> 1) * 400;
		quadrantEl(root, q).getBoundingClientRect = () => rect(left, top, left + 500, top + 400);
		centers[q] = { x: left + 250, y: top + 200 };
	});
	return centers;
}

