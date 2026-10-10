import type { MutableRef } from "preact/hooks";
import { useEffect, useRef } from "preact/hooks";
import type { DragController } from "./drag";

/** The controller of the drag in progress, or null. Unmounting mid-drag cancels it, which removes the ghost and every listener. */
export function useDragController(): MutableRef<DragController | null> {
	const controller = useRef<DragController | null>(null);
	useEffect(() => () => controller.current?.cancel(), []);
	return controller;
}

/** The `selector` element a press landed on, or null when it landed on an input, button or link inside it (those keep their click). */
export function pressedItem(e: PointerEvent, selector: string): HTMLElement | null {
	const target = e.target as HTMLElement | null;
	const item = target?.closest<HTMLElement>(selector) ?? null;
	return item === null || target?.closest("input, button, a") != null ? null : item;
}
