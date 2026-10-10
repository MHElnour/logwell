import { useRef, useState } from "preact/hooks";
import type { ID } from "../../domain/types";
import { type DragController, beginPointerDrag, createAutoScroller } from "../drag";
import { pressedItem, useDragController } from "../useDragController";

// Dragging a section column's header to reorder the sections. The gesture is the shared
// src/ui/drag.ts. "No section" and the "+ Add section" column are never picked up or targets: only the
// columns that carry `data-section-id` take part. The write is the caller's (one SectionService.place).

interface ColumnDragDeps {
	/** The `.cp-board` element. */
	root: () => HTMLElement | null;
	/** The section ids in column order, read at pointerdown. */
	sectionIds: () => ID[];
	/** `order` is the sections of the list after the drop, `id` included. */
	onDrop: (id: ID, order: ID[]) => void;
}

interface ColumnDrag {
	onPointerDown: (e: PointerEvent) => void;
	/** The section being dragged. */
	draggingId: ID | null;
	/** The section column the drop lands before: null = after the last one, undefined = no drag. */
	beforeId: ID | null | undefined;
}

export function useColumnDrag(deps: ColumnDragDeps): ColumnDrag {
	const depsRef = useRef(deps);
	depsRef.current = deps;
	const controller = useDragController();
	const [draggingId, setDraggingId] = useState<ID | null>(null);
	const [beforeId, setBeforeId] = useState<ID | null | undefined>(undefined);

	const onPointerDown = (e: PointerEvent) => {
		const head = pressedItem(e, ".cp-board-col-head");
		if (head === null) return;
		const col = head.closest<HTMLElement>(".cp-board-col");
		const id = col?.dataset.sectionId;
		const root = depsRef.current.root();
		if (id === undefined || root === null || controller.current?.active) return;
		const before = depsRef.current.sectionIds();
		if (before.length < 2) return;
		const scroller = createAutoScroller(() => root.querySelectorAll<HTMLElement>(".cp-board-scroll"));
		let last: { x: number; y: number } | null = null;
		let mine: DragController | null = null;

		/** The ids after a drop at x, and the section the line goes before. */
		const landing = (x: number): { order: ID[]; beforeId: ID | null } => {
			const others = [...root.querySelectorAll<HTMLElement>(".cp-board-col[data-section-id]")].filter((c) => c.dataset.sectionId !== id);
			let index = 0;
			for (const c of others) {
				const r = c.getBoundingClientRect();
				if (x > r.left + r.width / 2) index++;
			}
			const ids = others.map((c) => c.dataset.sectionId!);
			return { order: [...ids.slice(0, index), id, ...ids.slice(index)], beforeId: ids[index] ?? null };
		};
		const onScroll = () => last !== null && setBeforeId(landing(last.x).beforeId);
		const clear = () => {
			root.removeEventListener("scroll", onScroll, true);
			scroller.stop();
			if (controller.current === mine) controller.current = null;
			setDraggingId(null);
			setBeforeId(undefined);
		};
		mine = beginPointerDrag(e, head, {
			onStart() {
				root.addEventListener("scroll", onScroll, true);
				setDraggingId(id);
			},
			onMove(p) {
				last = p;
				scroller.update(p);
				setBeforeId(landing(p.x).beforeId);
			},
			onDrop(p) {
				const { order } = landing(p.x);
				clear();
				if (order.every((x, i) => x === before[i])) return;
				depsRef.current.onDrop(id, order);
			},
			onCancel: clear,
		});
		if (mine !== null) controller.current = mine;
	};

	return { onPointerDown, draggingId, beforeId };
}
