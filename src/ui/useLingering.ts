import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AppStore } from "../app/store";
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

/** What `useLingering` reads from the store: the tasks, the change count and the changes since a count. */
export type ChangeFeed = Pick<AppStore, "state" | "version" | "changesSince">;

/**
 * The tasks that went from open to completed during the last `ms`. A view keeps them among its open
 * rows for that long so the check animation can play, then they move into the Completed group.
 * A task seen open again is released at once, so completing it a second time starts a full
 * hold. The look runs while rendering, once per store change, so the held row is already in place in
 * the pass that completed it: the row never flashes into the group first, and the section renders
 * once for the change instead of once more from an effect. It reads only the tasks the store's changes
 * since the last look wrote (`changesSince`), never every task: a task is held when it was open at the
 * last look and is completed now. A change the store cannot list (a reload, a replacement of all records,
 * more changes than its feed keeps) holds nothing; it only releases held tasks that are open again. The
 * held set is a ref that keeps its identity until it changes; only the timer that ends a hold asks for a render.
 */
export function useLingering(store: ChangeFeed, tasks: ReadonlyMap<ID, Task>, active: boolean, ms = LINGER_MS): ReadonlySet<ID> {
	const { held, timers, release, hold } = useHolds(window, ms);
	// The store's change count and the tasks at the last look; null while the section is hidden.
	const ran = useRef<{ version: number; tasks: ReadonlyMap<ID, Task> } | null>(null);

	// A hidden section looks at nothing, so on becoming shown it only takes a baseline: what was completed
	// meanwhile is already in place.
	if (!active) {
		ran.current = null;
		return held.current;
	}
	const version = store.version;
	const seen = ran.current;
	if (seen === null) {
		ran.current = { version, tasks };
		return held.current;
	}
	// Nothing changed since the last look; or a render of an older task map than the store's (a re-render of this
	// section alone before the app's): the render of the current one reads the changes.
	if ((seen.version === version && seen.tasks === tasks) || tasks !== store.state.tasks) return held.current;
	ran.current = { version, tasks };
	// The same change count with other tasks: they were written without a change event.
	const changes = seen.version === version ? undefined : store.changesSince(seen.version);
	if (changes === undefined) {
		for (const id of [...timers.current.keys()]) if (tasks.get(id)?.status === "open") release(id, false);
		return held.current;
	}
	// Each task written since the last look, with its status then (the `before` of its first change).
	const before = new Map<ID, Task | undefined>();
	for (const ch of changes) if (ch.c === "tasks" && !before.has(ch.id)) before.set(ch.id, ch.before as Task | undefined);
	for (const [id, was] of before) {
		const now = tasks.get(id);
		if (now?.status === "open") {
			if (timers.current.has(id)) release(id, false);
		} else if (now?.status === "completed" && was?.status === "open") {
			hold(id);
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
