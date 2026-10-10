import { type VirtualHandle, virtualHandle } from "./virtual";

// The arrow keys and Tab of a windowed list or board column. The row a key goes to may
// not be drawn, so the DOM order (what rowItem.ts `onItemKeyDown` walks) is not the row order there. These
// handlers run in the capture phase on the list, find the next row from the listbox's data and ask its handle
// to draw, focus and (by focusing) scroll it into view. Rapid keys build on the row the previous key was sent
// to (the handle's pending key), not on the event target, which can still be the old row.

/** The rows of one listbox, windowed (a handle) or plain (every row drawn). */
interface Rows {
	count: number;
	indexOf(el: HTMLElement): number;
	element(index: number): HTMLElement | null;
	focus(index: number, pick?: (item: HTMLElement) => HTMLElement | null): void;
	/** The index a key was sent to and focus has not reached yet, or -1. */
	pending: number;
}

function rowsOf(box: HTMLElement, itemSelector: string): Rows {
	const handle: VirtualHandle | undefined = virtualHandle(box);
	if (handle !== undefined) {
		const key = handle.pendingKey;
		return {
			count: handle.count,
			indexOf: (el) => handle.indexOfElement(el),
			element: (i) => handle.elementAt(i),
			focus: (i, pick) => handle.focusIndex(i, pick),
			pending: key === null ? -1 : handle.indexOfKey(key),
		};
	}
	const items = [...box.children].filter((c): c is HTMLElement => c.matches(itemSelector));
	return {
		count: items.length,
		indexOf: (el) => items.indexOf(el),
		element: (i) => items[i] ?? null,
		focus: (i, pick) => {
			const el = items[i];
			if (el !== undefined) (pick?.(el) ?? el).focus();
		},
		pending: -1,
	};
}

const TABBABLE = "button, input, select, textarea, a[href], [tabindex]";

/**
 * The tab stop of `list` after (step 1) or before (-1) the listbox `box`, counting each listbox as one stop: another
 * listbox, or a control outside the listboxes (a section heading's buttons, a Completed toggle). Null at the end.
 */
function nextStop(list: HTMLElement, box: HTMLElement, step: 1 | -1): HTMLElement | null {
	const stops = [...list.querySelectorAll<HTMLElement>(`.cp-task-rows, ${TABBABLE}`)].filter(
		(el) => el.classList.contains("cp-task-rows") || (el.closest(".cp-task-rows") === null && el.tabIndex >= 0 && !el.hasAttribute("disabled") && !el.hidden),
	);
	return stops[stops.indexOf(box) + step] ?? null;
}

/**
 * Arrow keys and Tab on a row of a windowed `.cp-task-list`. Up and Down go to the previous or next row of
 * the whole list (across groups and the Completed group), as `onItemKeyDown` does on a list that draws every
 * row; at either end focus stays. Tab and Shift+Tab are left to the browser unless the row they reach is not
 * drawn where the browser would look: the neighbouring row of the same listbox, or, out of the listbox's last
 * (first) row, the first (last) row of the next listbox when no control comes in between. That row is drawn and
 * focused, so the Tab order is every row.
 */
export function onWindowedListKeyDown(e: KeyboardEvent, list: HTMLElement): void {
	const target = e.target as HTMLElement | null;
	const row = target?.closest?.<HTMLElement>(".cp-task-row") ?? null;
	const box = row?.parentElement ?? null;
	if (row === null || box === null || !box.classList.contains("cp-task-rows") || !list.contains(box)) return;
	if (e.key === "Tab") {
		if (target !== row) return;
		const rows = rowsOf(box, ".cp-task-row");
		const step = e.shiftKey ? -1 : 1;
		const to = rows.indexOf(row) + step;
		if (to >= 0 && to < rows.count) {
			const neighbour = step > 0 ? row.nextElementSibling : row.previousElementSibling;
			if (rows.element(to) === neighbour) return;
			e.preventDefault();
			e.stopPropagation();
			rows.focus(to);
			return;
		}
		// Out of the listbox. A control next (a heading's buttons) is the browser's to reach.
		const next = nextStop(list, box, step);
		if (next === null || !next.classList.contains("cp-task-rows")) return;
		const nextRows = rowsOf(next, ".cp-task-row");
		const i = step > 0 ? 0 : nextRows.count - 1;
		if (i < 0) return;
		const el = nextRows.element(i);
		if (el !== null && el === (step > 0 ? next.firstElementChild : next.lastElementChild)) return;
		e.preventDefault();
		e.stopPropagation();
		nextRows.focus(i);
		return;
	}
	if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
	// The row's own handler (onItemKeyDown) would walk the DOM order; this one walks the data.
	e.preventDefault();
	e.stopPropagation();
	const step = e.key === "ArrowDown" ? 1 : -1;
	const boxes = [...list.querySelectorAll<HTMLElement>(".cp-task-rows")];
	// Where the last key went, if focus has not arrived there yet.
	let at = boxes.indexOf(box);
	let rows = rowsOf(box, ".cp-task-row");
	let from = rows.indexOf(row);
	for (let b = 0; b < boxes.length; b++) {
		const r = rowsOf(boxes[b]!, ".cp-task-row");
		if (r.pending >= 0) {
			at = b;
			rows = r;
			from = r.pending;
			break;
		}
	}
	if (from < 0) return;
	if (from + step >= 0 && from + step < rows.count) {
		rows.focus(from + step);
		return;
	}
	for (let b = at + step; b >= 0 && b < boxes.length; b += step) {
		const next = rowsOf(boxes[b]!, ".cp-task-row");
		if (next.count > 0) {
			next.focus(step > 0 ? 0 : next.count - 1);
			return;
		}
	}
	// The first or last row of the list: focus stays where it is.
}

const itemsOf = (card: HTMLElement) => [...card.querySelectorAll<HTMLElement>(".cp-board-item")];
const firstItem = (card: HTMLElement) => itemsOf(card)[0] ?? null;
const lastItem = (card: HTMLElement) => itemsOf(card).at(-1) ?? null;

/**
 * Up, Down and Tab on an item of a windowed board column (`.cp-board-col-body`). The column's items are each
 * card's task, then its nested subtasks while expanded; Up and Down walk them in that order, drawing a card
 * that is not drawn. Alt+Arrow (a move) is the board's and is left alone.
 */
export function onWindowedColumnKeyDown(e: KeyboardEvent, body: HTMLElement): void {
	if (e.altKey) return;
	const target = e.target as HTMLElement | null;
	const item = target?.closest?.<HTMLElement>(".cp-board-item") ?? null;
	const card = item?.closest<HTMLElement>(".cp-board-card") ?? null;
	const cards = card?.parentElement ?? null;
	const handle = virtualHandle(cards);
	if (item === null || card === null || cards === null || handle === undefined || !body.contains(cards)) return;
	const inCard = itemsOf(card);
	const k = inCard.indexOf(item);
	if (e.key === "Tab") {
		if (target !== item) return;
		const step = e.shiftKey ? -1 : 1;
		// Inside the card the browser's order is right.
		if (k + step >= 0 && k + step < inCard.length) return;
		const to = handle.indexOfElement(card) + step;
		if (to < 0 || to >= handle.count) return;
		const neighbour = step > 0 ? card.nextElementSibling : card.previousElementSibling;
		if (handle.elementAt(to) === neighbour) return;
		e.preventDefault();
		e.stopPropagation();
		handle.focusIndex(to, step > 0 ? firstItem : lastItem);
		return;
	}
	if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
	e.preventDefault();
	e.stopPropagation();
	// A key sent to a card that is not drawn yet: wait for it (it is drawn and focused before the next event).
	if (handle.pendingKey !== null) return;
	const step = e.key === "ArrowDown" ? 1 : -1;
	const next = inCard[k + step];
	if (next !== undefined) {
		next.focus();
		return;
	}
	const to = handle.indexOfElement(card) + step;
	if (to >= 0 && to < handle.count) handle.focusIndex(to, step > 0 ? firstItem : lastItem);
}
