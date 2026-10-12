import type { Quadrant } from "../../src/domain/queries";
import { QUADRANT_ORDER } from "../../src/domain/matrix";
import { type CalMount, click, mountCal, settle } from "./calendar-helpers";

export { click, settle };
export type { CalMount };

/** The whole app with the matrix tests' fake clock (2026-10-01T10:00Z, Europe/Berlin: Thursday 12:00). */
export const mountMatrix = mountCal;

export const matrix = (root: ParentNode) => root.querySelector<HTMLElement>(".cp-matrix")!;

export async function openMatrix(m: CalMount): Promise<HTMLElement> {
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
		quadrantEl(root, q).getBoundingClientRect = () => ({ left, top, right: left + 500, bottom: top + 400, width: 500, height: 400, x: left, y: top, toJSON: () => ({}) });
		centers[q] = { x: left + 250, y: top + 200 };
	});
	return centers;
}

function pointerEvent(type: string, x: number, y: number, init: PointerEventInit = {}): Event {
	const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, ...init };
	if (typeof PointerEvent !== "undefined") return new PointerEvent(type, opts);
	const e = new MouseEvent(type, opts);
	Object.defineProperties(e, { pointerId: { value: opts.pointerId }, pointerType: { value: opts.pointerType } });
	return e;
}

/** Presses on `el`, moves in two steps and (unless `release` is false) releases at `to`. */
export async function dragTo(el: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }, release = true): Promise<void> {
	el.dispatchEvent(pointerEvent("pointerdown", from.x, from.y));
	el.dispatchEvent(pointerEvent("pointermove", from.x + 10, from.y + 10));
	el.dispatchEvent(pointerEvent("pointermove", to.x, to.y));
	if (release) {
		el.dispatchEvent(pointerEvent("pointerup", to.x, to.y));
		el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	}
	await settle();
}

export async function press(el: Element, key: string, init: KeyboardEventInit = {}): Promise<void> {
	el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
	await settle();
}

/** Releases the pointer (and sends the click a browser sends) after a `dragTo(..., false)`. */
export async function releaseAt(el: HTMLElement, to: { x: number; y: number }): Promise<void> {
	el.dispatchEvent(pointerEvent("pointerup", to.x, to.y));
	el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	await settle();
}
