import type { RefObject, TargetedKeyboardEvent } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Task } from "../domain/types";
import { toggleComplete } from "./actions";
import type { MenuSpec, UiHost } from "./host";
import { reopenOccurrence } from "./repeatActions";

/**
 * Sent to a focused row when Cmd/Ctrl+Enter is pressed. The view's keymap
 * scope sends it, because Obsidian's global Mod+Enter hotkeys stop the
 * keydown before it reaches the row (see CheckpointView).
 */
export const TOGGLE_COMPLETE_EVENT = "cp-toggle-complete";

/**
 * The completion toggle of a task row or board item: the transient `is-completing` and
 * `is-just-completed` states, and the TOGGLE_COMPLETE_EVENT listener on `el`. `occurrenceDate` is set
 * for a Completed history row, where the toggle reopens that date instead.
 */
export function useCompleteToggle(
	host: UiHost,
	task: Task,
	el: RefObject<HTMLElement>,
	occurrenceDate: string | null = null,
	complete?: (task: Task) => Promise<void>,
) {
	const taskRef = useRef(task);
	taskRef.current = task;
	const occurrenceRef = useRef(occurrenceDate);
	occurrenceRef.current = occurrenceDate;
	const completeRef = useRef(complete);
	completeRef.current = complete;
	// Only styles the row while the command runs; the command itself is never delayed.
	const [completing, setCompleting] = useState(false);
	// The check animation plays only on a task the user just completed, never on mount.
	const [justCompleted, setJustCompleted] = useState(false);
	const toggle = (t = taskRef.current) => {
		const date = occurrenceRef.current;
		if (date !== null) {
			void reopenOccurrence(host, t, date);
			return;
		}
		setJustCompleted(t.status === "open");
		if (t.status === "open") setCompleting(true);
		// A dashboard block completes through its own handler (it adds the Undo notice and redraws at once).
		const run = completeRef.current;
		void (t.status === "open" && run !== undefined ? run(t) : toggleComplete(host, t)).finally(() => setCompleting(false));
	};
	useEffect(() => {
		const node = el.current;
		if (node === null) return;
		const onToggle = () => toggle();
		node.addEventListener(TOGGLE_COMPLETE_EVENT, onToggle);
		return () => node.removeEventListener(TOGGLE_COMPLETE_EVENT, onToggle);
	}, [host]);
	return { completing, justCompleted, toggle, animationEnded: () => setJustCompleted(false) };
}

/**
 * The keys of a focusable task row or board item: Up and Down move among the `itemSelector` items
 * inside the nearest `listSelector`, Cmd/Ctrl+Enter toggles, Enter or Space opens, ContextMenu or
 * Shift+F10 shows the menu under the item.
 */
export function onItemKeyDown(
	e: TargetedKeyboardEvent<HTMLElement>,
	host: UiHost,
	{ listSelector, itemSelector, toggle, open, menu }: {
		listSelector: string;
		itemSelector: string;
		toggle: () => void;
		open: () => void;
		/** Omitted where a row has no menu (a dashboard block): the menu keys then do nothing. */
		menu?: (el: HTMLElement) => MenuSpec;
	},
): void {
	const el = e.currentTarget;
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		const items = [...(el.closest(listSelector)?.querySelectorAll<HTMLElement>(itemSelector) ?? [])];
		const i = items.indexOf(el);
		items[e.key === "ArrowDown" ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0)]?.focus();
	} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
		e.preventDefault();
		toggle();
	} else if (e.key === "Enter" || e.key === " ") {
		e.preventDefault();
		open();
	} else if (menu !== undefined && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
		e.preventDefault();
		const rect = el.getBoundingClientRect();
		host.showMenu({ x: rect.left + 24, y: rect.bottom }, menu(el));
	}
}
