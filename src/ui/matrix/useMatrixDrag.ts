import { useRef, useState } from "preact/hooks";
import type { Quadrant } from "../../domain/queries";
import type { ID } from "../../domain/types";
import { type DragController, type DragPoint, beginPointerDrag, createAutoScroller, hitTest, overElement } from "../drag";
import { pressedItem, useDragController } from "../useDragController";

// Dragging a matrix card onto a quadrant. The gesture is the shared
// src/ui/drag.ts; this file only draws it and says where it landed. The drop itself is the
// caller's: one TaskService.update, so one undo entry.

interface MatrixDragDeps {
	/** The grid element: it holds the quadrant sections and the ghost. */
	grid: () => HTMLElement | null;
	/** The quadrant a task is in now, or null when it is gone. */
	quadrantOfTask: (id: ID) => Quadrant | null;
	onDrop: (id: ID, to: Quadrant) => void;
}

interface MatrixDrag {
	/** The pointerdown handler for the grid (event delegation: one per grid). */
	onPointerDown: (e: PointerEvent) => void;
	/** The card being dragged and the quadrant under the pointer. State, so a re-render keeps the classes. */
	draggingId: ID | null;
	overQuadrant: Quadrant | null;
}

/** The details pane floats over the grid below 1200 px; a point over it is not a drop target. */
const overPane = (root: HTMLElement, p: DragPoint) => overElement(root, p, ".cp-details-pane");

export function useMatrixDrag(deps: MatrixDragDeps): MatrixDrag {
	const depsRef = useRef(deps);
	depsRef.current = deps;
	const controller = useDragController();
	const [draggingId, setDraggingId] = useState<ID | null>(null);
	const [overQuadrant, setOverQuadrant] = useState<Quadrant | null>(null);

	const onPointerDown = (e: PointerEvent) => {
		const row = pressedItem(e, ".cp-task-row");
		if (row === null) return;
		const id = row.dataset.taskId;
		const grid = depsRef.current.grid();
		// A Completed history row shares its series task's id and never drags.
		if (id === undefined || row.dataset.occurrence !== undefined || grid === null) return;
		// A second press (the right button, another pointer) never cancels a drag in progress.
		if (controller.current?.active) return;

		let ghost: HTMLElement | null = null;
		let mine: DragController | null = null;
		const sections = () => [...grid.querySelectorAll<HTMLElement>(".cp-matrix-q")];
		// A long quadrant scrolls its body while the card is held near its top or bottom edge.
		// The quadrants themselves stay put, so the drop target needs no recomputing on scroll.
		const scroller = createAutoScroller(() => grid.querySelectorAll<HTMLElement>(".cp-matrix-q-body"));
		const clear = () => {
			scroller.stop();
			ghost?.remove();
			ghost = null;
			if (controller.current === mine) controller.current = null;
			setDraggingId(null);
			setOverQuadrant(null);
		};
		const quadrantAt = (p: { x: number; y: number }): Quadrant | null => {
			if (overPane(grid, p)) return null;
			const section = hitTest(p, sections());
			return (section?.dataset.quadrant as Quadrant | undefined) ?? null;
		};

		mine = beginPointerDrag(e, row, {
			onStart() {
				// The card keeps its place (dimmed); a clone follows the pointer, because the quadrant
				// scrolls and would clip a card moved by a transform.
				const gridRect = grid.getBoundingClientRect();
				const rect = row.getBoundingClientRect();
				ghost = row.cloneNode(true) as HTMLElement;
				ghost.classList.remove("is-dragging", "is-selected");
				ghost.classList.add("cp-matrix-ghost");
				for (const attr of ["data-task-id", "role", "aria-selected", "tabindex", "id"]) ghost.removeAttribute(attr);
				for (const el of ghost.querySelectorAll("[id]")) el.removeAttribute("id");
				ghost.setAttribute("aria-hidden", "true");
				ghost.style.left = `${rect.left - gridRect.left}px`;
				ghost.style.top = `${rect.top - gridRect.top}px`;
				ghost.style.width = `${rect.width}px`;
				grid.appendChild(ghost);
				setDraggingId(id);
			},
			onMove(p, origin) {
				if (ghost !== null) ghost.style.transform = `translate(${p.x - origin.x}px, ${p.y - origin.y}px)`;
				setOverQuadrant(quadrantAt(p));
				scroller.update(p);
			},
			onDrop(p) {
				const to = quadrantAt(p);
				clear();
				if (to !== null && to !== depsRef.current.quadrantOfTask(id)) depsRef.current.onDrop(id, to);
			},
			onCancel: clear,
		});
		if (mine !== null) controller.current = mine;
	};

	return { onPointerDown, draggingId, overQuadrant };
}
