import { DateTime } from "luxon";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ActiveTimer } from "../domain/focus";
import { nowInstant } from "../domain/ports";
import type { QueryContext } from "../domain/queries";
import { type SubtaskCount, subtaskCounts } from "../domain/tasks";
import { formatLatin } from "../domain/time";
import type { ID, Instant } from "../domain/types";
import type { DbData } from "../persistence/schema";
import type { UiHost } from "./host";

/** Re-renders on every store change and status change. */
export function useAppState(host: UiHost): DbData {
	const store = host.app.store;
	const [, setTick] = useState(0);
	useEffect(() => {
		const bump = () => setTick((n) => n + 1);
		const offChanged = store.bus.on("changed", bump);
		const offStatus = store.bus.on("status", bump);
		return () => {
			offChanged();
			offStatus();
		};
	}, [store]);
	return store.state;
}

/** The query context, refreshed every minute so "today" rolls over at midnight. */
export function useQueryContext(host: UiHost): QueryContext {
	const [ctx, setCtx] = useState(() => host.app.queryContext());
	useEffect(() => {
		const id = window.setInterval(() => {
			const next = host.app.queryContext();
			setCtx((prev) => (prev.today === next.today && prev.zone === next.zone && prev.upcomingDays === next.upcomingDays && prev.weekStart === next.weekStart ? prev : next));
		}, 60_000);
		return () => window.clearInterval(id);
	}, [host]);
	// Settings changes re-render the whole tree; pick them up immediately.
	const fresh = host.app.queryContext();
	if (fresh.zone !== ctx.zone || fresh.upcomingDays !== ctx.upcomingDays || fresh.weekStart !== ctx.weekStart || fresh.today !== ctx.today) {
		setCtx(fresh);
	}
	return ctx;
}

/**
 * A function with a fixed identity that always calls the latest `fn`. Handed to memoized rows, so a new
 * closure on every render does not make every row render again; the call still sees the current render's state.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
	const latest = useRef(fn);
	latest.current = fn;
	const [stable] = useState(() => (...args: A): R => latest.current(...args));
	return stable;
}

const NO_SUBTASK_COUNTS: ReadonlyMap<ID, SubtaskCount> = new Map();

/**
 * The subtask counts of every task, read only while `active` and only when `tasks` changed. For the store's current
 * tasks they come from the task index, kept per change (a parent whose counts did not move keeps its count object);
 * for any other task map, from a pass over every task.
 */
export function useSubtaskCounts(host: Pick<UiHost, "app">, tasks: DbData["tasks"], active = true): ReadonlyMap<ID, SubtaskCount> {
	const app = host.app;
	return useActiveMemo(active, () => (tasks === app.store.state.tasks ? app.tasks.lists.subtaskCounts() : subtaskCounts(tasks.values())), [tasks], NO_SUBTASK_COUNTS);
}

let idSeq = 0;

/**
 * `useMemo` that recomputes only while `active`. A hidden section (the app mounts every section)
 * keeps its last value, or `idle` if it was never shown, so store changes and the clock cost
 * nothing until the section is shown again; the first visible render catches up in one pass.
 */
export function useActiveMemo<T>(active: boolean, compute: () => T, deps: readonly unknown[], idle: T): T {
	const last = useRef<{ deps: readonly unknown[]; value: T } | null>(null);
	const cur = last.current;
	if (active && (cur === null || cur.deps.length !== deps.length || cur.deps.some((d, i) => d !== deps[i]))) {
		last.current = { deps, value: compute() };
	}
	return last.current === null ? idle : last.current.value;
}

/**
 * An element ID that is unique per component instance and across app views,
 * for label/control pairs in components that can be mounted more than once.
 */
export function useUniqueId(prefix: string): string {
	const [id] = useState(() => `${prefix}-${++idSeq}`);
	return id;
}

/** Renders an Obsidian icon into a span. */
export function useIcon(host: Pick<UiHost, "setIcon">, icon: string, fallback?: string) {
	const ref = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => {
		if (ref.current !== null) {
			ref.current.empty();
			host.setIcon(ref.current, icon);
			// setIcon leaves the element empty for a name it does not know (a legacy or removed icon).
			if (fallback !== undefined && ref.current.childElementCount === 0) host.setIcon(ref.current, fallback);
		}
	}, [host, icon, fallback]);
	return ref;
}

/**
 * The focus timer for the Focus page. Re-renders on the service's `focus` event, which the host
 * fires about once per second while a timer runs, and on set-done. While the page is hidden
 * (`active` false) only a change of the timer's shape (phase, state, round, task, prompt) re-renders,
 * so a hidden section costs nothing per second.
 */
export function useFocus(host: UiHost, active = true): { timer: ActiveTimer | null; summary: { rounds: number; focusedSec: number } | null; now: Instant } {
	const focus = host.app.focus;
	const [, setTick] = useState(0);
	const shape = useRef("");
	const shapeOf = () => {
		const t = focus.timer();
		return t === null ? "none" : `${t.sessionId}|${t.phase}|${t.state}|${t.round}|${t.taskId}|${t.needsRecovery}|${t.unobserved.length}`;
	};
	// The timer as this render saw it: the subscription below re-renders only if it moved since.
	const rendered = shapeOf();
	const renderedShape = useRef(rendered);
	renderedShape.current = rendered;
	useEffect(() => {
		shape.current = shapeOf();
		if (shape.current !== renderedShape.current) setTick((n) => n + 1);
		const onFocus = () => {
			const next = shapeOf();
			const changed = next !== shape.current;
			shape.current = next;
			if (active || changed) setTick((n) => n + 1);
		};
		const offs = [focus.bus.on("focus", onFocus), focus.bus.on("set-done", onFocus)];
		return () => {
			for (const off of offs) off();
		};
	}, [focus, active]);
	return { timer: focus.timer(), summary: focus.lastSummary(), now: nowInstant(host.app.clock) };
}

/**
 * The device's wall time as "HH:mm" in the display zone, read on every render and re-rendered every 30 s
 * while the component is mounted (the "Now" badge of the Habits page moves with the clock). It
 * only re-renders when the minute changed.
 */
export function useClockTime(host: UiHost, zone: string): string {
	const read = () => formatLatin(DateTime.fromJSDate(host.app.clock.now(), { zone }), "HH:mm");
	const [, setTick] = useState(0);
	const time = read();
	const shown = useRef(time);
	shown.current = time;
	useEffect(() => {
		const id = window.setInterval(() => {
			if (read() !== shown.current) setTick((n) => n + 1);
		}, 30_000);
		return () => window.clearInterval(id);
		// `read` closes over host and zone only.
	}, [host, zone]);
	return time;
}
