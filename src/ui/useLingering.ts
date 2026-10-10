import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ListEntry } from "../domain/queries";
import type { ID, Task } from "../domain/types";

/** How long a just-completed row stays among the open rows: the check animation (styles.css) plus a beat. */
export const LINGER_MS = 450;

const NONE: ReadonlySet<ID> = new Set();

/**
 * The held set and the timers that end each hold, for both hooks. The set keeps its identity until it changes; only
 * the timer that ends a hold asks for a render. A timer runs on `win`, the window the hook's element lives in.
 */
function useHolds(win: Window, ms: number) {
	const [, setVersion] = useState(0);
	const held = useRef<ReadonlySet<ID>>(NONE);
	const timers = useRef(new Map<ID, { win: Window; handle: number }>());

	const release = (id: ID, render: boolean) => {
		const timer = timers.current.get(id);
		if (timer !== undefined) timer.win.clearTimeout(timer.handle);
		timers.current.delete(id);
		if (!held.current.has(id)) return;
		const next = new Set(held.current);
		next.delete(id);
		held.current = next.size === 0 ? NONE : next;
		if (render) setVersion((v) => v + 1);
	};
	/** Holds `id` for `ms`, starting a full hold again when it is held already. */
	const hold = (id: ID) => {
		const old = timers.current.get(id);
		if (old !== undefined) old.win.clearTimeout(old.handle);
		timers.current.set(id, { win, handle: win.setTimeout(() => release(id, true), ms) });
		held.current = new Set(held.current).add(id);
	};

	useLayoutEffect(
		() => () => {
			for (const timer of timers.current.values()) timer.win.clearTimeout(timer.handle);
			timers.current.clear();
		},
		[],
	);
	return { held, timers, release, hold };
}

/**
 * The tasks that went from open to completed during the last `ms`. A view keeps them among its open
 * rows for that long so the check animation can play, then they move into the Completed group
 * A task seen open again is released at once, so completing it a second time starts a full
 * hold. The diff runs while rendering, once per new task map, so the held row is already in place in
 * the pass that completed it: the row never flashes into the group first, and the section renders
 * once for the change instead of once more from an effect. The held set is a ref that keeps its
 * identity until it changes; only the timer that ends a hold asks for a render.
 */
export function useLingering(tasks: ReadonlyMap<ID, Task>, active: boolean, ms = LINGER_MS): ReadonlySet<ID> {
	const { held, timers, release, hold } = useHolds(window, ms);
	const status = useRef<Map<ID, Task["status"]> | null>(null);
	const ran = useRef<{ tasks: ReadonlyMap<ID, Task>; active: boolean } | null>(null);

	// Compared once per new task map, and only while the section is shown: a hidden one takes no
	// baseline, so on becoming shown it only takes one: what was completed meanwhile is already in place.
	const seen = ran.current;
	if (seen === null || seen.tasks !== tasks || seen.active !== active) {
		ran.current = { tasks, active };
		if (!active) {
			status.current = null;
		} else {
			const last = status.current;
			const next = new Map<ID, Task["status"]>();
			for (const t of tasks.values()) {
				next.set(t.id, t.status);
				if (t.status === "open") {
					if (timers.current.has(t.id)) release(t.id, false);
				} else if (t.status === "completed" && last?.get(t.id) === "open") {
					hold(t.id);
				}
			}
			status.current = next;
		}
	}
	return held.current;
}

/**
 * `useLingering` for a dashboard block. The block shows a few open rows out of possibly tens of thousands
 * of tasks, so it does not keep a status for every task: a row is held when it was in the entries drawn last time
 * and its task is completed now. The look is made once per new `entries` array (the block draws a new one after each
 * query), while rendering, so the held row is already in place in the pass that completed it. A task shown again is
 * released at once. Timers run on `win`, the window of the block's element, since a block may sit in a pop-out window.
 */
export function useLingeringShown(entries: readonly ListEntry[], tasks: ReadonlyMap<ID, Task>, win: Window = window, ms = LINGER_MS): ReadonlySet<ID> {
	const { held, timers, release, hold } = useHolds(win, ms);
	const looked = useRef<readonly ListEntry[] | null>(null);

	if (looked.current !== entries) {
		const last = looked.current;
		looked.current = entries;
		if (held.current.size > 0 || timers.current.size > 0) {
			for (const entry of entries) {
				if (timers.current.has(entry.task.id) || held.current.has(entry.task.id)) release(entry.task.id, false);
			}
		}
		if (last !== null) {
			for (const entry of last) {
				if (tasks.get(entry.task.id)?.status === "completed") hold(entry.task.id);
			}
		}
	}
	return held.current;
}
