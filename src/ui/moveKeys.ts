import type { RefObject } from "preact";
import { useEffect } from "preact/hooks";
import { useStableCallback } from "./hooks";

// Alt+Arrow moves of a focused card on the board and the matrix. Obsidian's global hotkeys (Alt+Left/Right =
// back/forward on Windows and Linux) run before the page sees the key, so CheckpointView registers the four
// combinations on the view's Scope and hands them to the focused card with an event. No obsidian import.

/** Keydown events the Scope already turned into a move, so the page's own key handler skips them. */
export const routedMoves = new WeakSet<Event>();

/**
 * True when the key was consumed: a card matching `selector` has focus in `container` and answered. The card's
 * handler reports in `detail.acted`; when it did not act, the caller returns true to the Scope, so Obsidian's
 * default for the key still runs.
 */
export function routeMove(container: HTMLElement, evt: KeyboardEvent, selector: string, event: string): boolean {
	const focused = container.ownerDocument.activeElement;
	if (focused === null || !focused.matches(selector) || !container.contains(focused)) return false;
	const detail: { key: string; acted: boolean } = { key: evt.key, acted: false };
	routedMoves.add(evt);
	focused.dispatchEvent(new CustomEvent(event, { bubbles: true, detail }));
	if (!detail.acted) routedMoves.delete(evt);
	return detail.acted;
}

/** Hands the Scope's move event for the card under `rootRef` (the closest `cardSelector`) to `keyMove`, which returns whether it acted. */
export function useMoveEvent(rootRef: RefObject<HTMLElement>, event: string, cardSelector: string, keyMove: (card: HTMLElement, key: string) => boolean): void {
	const latest = useStableCallback(keyMove);
	useEffect(() => {
		const root = rootRef.current;
		if (root === null) return;
		const onMove = (e: Event) => {
			const card = (e.target as HTMLElement | null)?.closest<HTMLElement>(cardSelector);
			const detail = (e as CustomEvent<{ key: string; acted?: boolean }>).detail;
			if (card != null && typeof detail?.key === "string") detail.acted = latest(card, detail.key);
		};
		root.addEventListener(event, onMove);
		return () => root.removeEventListener(event, onMove);
	}, []);
}
