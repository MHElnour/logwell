import { useRef, useState } from "preact/hooks";
import type { BoardColumn } from "../../domain/board";
import type { ID } from "../../domain/types";
import { type DragController, type DragPoint, beginPointerDrag, createAutoScroller, hitTest, overElement } from "../drag";
import { pressedItem, useDragController } from "../useDragController";
import { virtualHandle } from "../virtual";

// Dragging a board card. The gesture is the shared src/ui/drag.ts; this file draws the ghost and the
// drop line and says where the card landed: the target column and the full sibling order after the drop. The
// write is the caller's (one TaskService.place, so one undo entry).

export interface BoardDrop {
	id: ID;
	/** The column the card was picked up in, and the one it was dropped on. */
	from: string;
	to: BoardColumn;
	/** The dragged task's siblings (same column, same parent) after the drop, itself included. */
	order: ID[];
}

interface BoardDragDeps {
	/** The `.cp-board` element: it holds the columns and the ghost. */
	root: () => HTMLElement | null;
	columns: () => BoardColumn[];
	/** The parent of a task in the store, read when the pointer goes down. */
	parentOf: (id: ID) => ID | null;
	onDrop: (drop: BoardDrop) => void;
}

/** Where the drop would land, for the highlight and the line. */
interface BoardOver {
	columnId: string;
	/** The column the card was picked up in. */
	from: string;
	/** The card or subtask the dragged one would go before; null = at the end. */
	beforeId: ID | null;
	/** Which list the end line belongs to: a column id, or the parent's id for a subtask. */
	endKey: string;
	refused: boolean;
}

interface BoardDrag {
	onPointerDown: (e: PointerEvent) => void;
	draggingId: ID | null;
	over: BoardOver | null;
}

/** The details pane floats over the board below 1200 px; a point over it is not a drop target. */
const overPane = (root: HTMLElement, p: DragPoint) => overElement(root, p, ".cp-details-pane");

/** How many of `els` the point is below the middle of: the insertion index among them. */
function insertionIndex(y: number, els: readonly HTMLElement[]): number {
	let n = 0;
	for (const el of els) {
		const r = el.getBoundingClientRect();
		if (y > r.top + r.height / 2) n++;
	}
	return n;
}

/**
 * The cards of the target column in order (the dragged one left out) and how many of them the point is below the
 * middle of. A column that draws every card is read from the DOM; a windowed one from its data, with
 * each card that is not drawn placed by its offset, so a drop far down a long column lands where it shows.
 */
function cardsAbove(y: number, els: readonly HTMLElement[], to: BoardColumn, colEl: HTMLElement, id: ID): { ids: ID[]; i: number } {
	const handle = virtualHandle(colEl.querySelector(".cp-board-cards"));
	if (handle === undefined) return { ids: els.map((el) => el.dataset.taskId!), i: insertionIndex(y, els) };
	const drawn = new Map(els.map((el) => [el.dataset.taskId!, el.getBoundingClientRect()] as const));
	const geometry = handle.geometry();
	const ids = to.cards.map((c) => c.entry.task.id).filter((x) => x !== id);
	let i = 0;
	for (const x of ids) {
		const r = drawn.get(x) ?? geometry.rectOf(x);
		if (r !== null && y > (r.top + r.bottom) / 2) i++;
	}
	return { ids, i };
}

export function useBoardDrag(deps: BoardDragDeps): BoardDrag {
	const depsRef = useRef(deps);
	depsRef.current = deps;
	const controller = useDragController();
	const [draggingId, setDraggingId] = useState<ID | null>(null);
	const [over, setOver] = useState<BoardOver | null>(null);

	const onPointerDown = (e: PointerEvent) => {
		const item = pressedItem(e, ".cp-board-item");
		if (item === null) return;
		const id = item.dataset.taskId;
		const root = depsRef.current.root();
		const fromEl = item.closest<HTMLElement>(".cp-board-col");
		if (id === undefined || root === null || fromEl === null) return;
		// A second press (the right button, another pointer) never cancels a drag in progress.
		if (controller.current?.active) return;
		const from = fromEl.dataset.column ?? "";
		const isSub = item.classList.contains("is-sub");
		// From the store, not the column's cards: a re-render during the drag may move the card.
		const parentId = depsRef.current.parentOf(id);
		const parentCardId = item.closest<HTMLElement>(".cp-board-card")?.dataset.taskId;
		// A subtask moves as itself; a parent moves with its whole card.
		const moving = isSub ? item : (item.closest<HTMLElement>(".cp-board-card") ?? item);

		let ghost: HTMLElement | null = null;
		let lastPoint: { x: number; y: number } | null = null;
		let mine: DragController | null = null;
		const scroller = createAutoScroller(() => [
			...root.querySelectorAll<HTMLElement>(".cp-board-scroll, .cp-board-col-body"),
		]);
		// The autoscroll moves the cards under a still pointer: the drop target follows the scroll.
		const onScroll = () => {
			if (lastPoint !== null) setOver(landing(lastPoint)?.over ?? null);
		};
		const clear = () => {
			root.removeEventListener("scroll", onScroll, true);
			scroller.stop();
			ghost?.remove();
			ghost = null;
			if (controller.current === mine) controller.current = null;
			setDraggingId(null);
			setOver(null);
		};

		/** The landing for a point: where, and the sibling order. Null when the point is over no column. */
		const landing = (p: { x: number; y: number }): { over: BoardOver; drop: BoardDrop | null } | null => {
			if (overPane(root, p)) return null;
			const cols = depsRef.current.columns();
			const colEl = hitTest(p, root.querySelectorAll<HTMLElement>(".cp-board-col"));
			const to = cols.find((c) => c.id === colEl?.dataset.column);
			if (colEl === null || to === undefined) return null;
			const origin = cols.find((c) => c.id === from);
			if (isSub) {
				// A nested subtask never leaves its parent's card.
				const parent = origin?.cards.find((c) => c.entry.task.id === parentCardId);
				const cardEl = [...fromEl.querySelectorAll<HTMLElement>(".cp-board-card")].find((c) => c.dataset.taskId === parentCardId);
				if (to.id !== from || parent === undefined || cardEl === undefined) {
					return { over: { columnId: to.id, from, beforeId: null, endKey: "", refused: true }, drop: null };
				}
				const els = [...cardEl.querySelectorAll<HTMLElement>(".cp-board-item.is-sub")].filter((el) => el.dataset.taskId !== id);
				const i = insertionIndex(p.y, els);
				const others = els.map((el) => el.dataset.taskId!);
				return {
					over: { columnId: to.id, from, beforeId: els[i]?.dataset.taskId ?? null, endKey: parentCardId ?? "", refused: false },
					drop: { id, from, to, order: [...others.slice(0, i), id, ...others.slice(i)] },
				};
			}
			// A subtask shown as its own card still follows its parent's section.
			if (to.id !== from && to.sectionId !== undefined && parentId !== null) {
				return { over: { columnId: to.id, from, beforeId: null, endKey: "", refused: true }, drop: null };
			}
			if (to.id !== from && !to.acceptsDrop) {
				return { over: { columnId: to.id, from, beforeId: null, endKey: "", refused: true }, drop: null };
			}
			const els = [...colEl.querySelectorAll<HTMLElement>(".cp-board-card")].filter((el) => el.dataset.taskId !== id);
			const { ids, i } = cardsAbove(p.y, els, to, colEl, id);
			// Only siblings (the same parent) are ordered against each other.
			const parentOf = new Map(to.cards.map((c) => [c.entry.task.id, c.entry.task.parentId] as const));
			const siblings = ids.filter((x) => (parentOf.get(x) ?? null) === parentId);
			const at = ids.slice(0, i).filter((x) => (parentOf.get(x) ?? null) === parentId).length;
			return {
				over: { columnId: to.id, from, beforeId: ids[i] ?? null, endKey: to.id, refused: false },
				drop: { id, from, to, order: [...siblings.slice(0, at), id, ...siblings.slice(at)] },
			};
		};

		mine = beginPointerDrag(e, item, {
			onStart() {
				// The card keeps its place (dimmed); a clone follows the pointer, because the column scrolls
				// and would clip a card moved by a transform.
				const rootRect = root.getBoundingClientRect();
				const rect = moving.getBoundingClientRect();
				ghost = moving.cloneNode(true) as HTMLElement;
				ghost.classList.remove("is-dragging", "is-selected");
				ghost.classList.add("cp-board-ghost");
				for (const attr of ["data-task-id", "role", "aria-selected", "tabindex", "id"]) ghost.removeAttribute(attr);
				for (const el of ghost.querySelectorAll("[data-task-id], [id], [tabindex]")) {
					for (const attr of ["data-task-id", "id", "tabindex", "role", "aria-selected"]) el.removeAttribute(attr);
				}
				ghost.setAttribute("aria-hidden", "true");
				ghost.style.left = `${rect.left - rootRect.left}px`;
				ghost.style.top = `${rect.top - rootRect.top}px`;
				ghost.style.width = `${rect.width}px`;
				root.appendChild(ghost);
				root.addEventListener("scroll", onScroll, true);
				setDraggingId(id);
			},
			onMove(p, origin) {
				if (ghost !== null) ghost.style.transform = `translate(${p.x - origin.x}px, ${p.y - origin.y}px)`;
				lastPoint = p;
				scroller.update(p);
				setOver(landing(p)?.over ?? null);
			},
			onDrop(p) {
				const hit = landing(p);
				clear();
				if (hit?.drop != null) depsRef.current.onDrop(hit.drop);
			},
			onCancel: clear,
		});
		if (mine !== null) controller.current = mine;
	};

	return { onPointerDown, draggingId, over };
}
