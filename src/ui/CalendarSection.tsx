import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ViewGroup } from "../app/views";
import { type CalendarContext, monthGrid, weekDays } from "../domain/calendar";
import { type ListEntry, type QueryContext, type TaskFilter, emptyFilter, entryOf, filterTasks } from "../domain/queries";
import { indexOccurrenceRecords } from "../domain/recurrence";
import { compareTasksBySortKey } from "../domain/tasks";
import type { ID, LocalDate, Task } from "../domain/types";
import type { DbData } from "../persistence/schema";
import { CalendarHeader } from "./calendar/CalendarHeader";
import { useCalDnd } from "./calendar/dnd";
import { MonthView } from "./calendar/MonthView";
import { WeekView } from "./calendar/WeekView";
import { type CalendarMode, monthTitle, shiftAnchor, weekTitle } from "./calendar/format";
import { IconButton } from "./common";
import { useActiveMemo, useStableCallback, useSubtaskCounts, useUniqueId } from "./hooks";
import type { UiHost } from "./host";
import { DetailsPane } from "./TaskDetails";
import { TaskList } from "./TaskList";
import { ScopeMenuButton } from "./ViewMenu";

// The calendar section. The layout comes from src/domain/calendar.ts; this file only
// feeds it the filtered tasks and draws the result. Nothing here keeps a copy of task data: an
// edit made in the details form changes the store and the next render moves the entry.

export interface CalendarSectionState {
	mode: CalendarMode;
	/** Any date in the visible week or month. */
	anchor: LocalDate;
	/** Set by the view menu: lists, tags and "Show completed" (status "all"); the default status is "open". */
	filter: TaskFilter;
	selectedId: ID | null;
	unscheduledOpen: boolean;
	/** The week's all-day row shows every entry instead of three per day. Kept here so it survives section switches. */
	allDayExpanded: boolean;
}

export function initialCalendarState(today: LocalDate): CalendarSectionState {
	return { mode: "week", anchor: today, filter: emptyFilter("open"), selectedId: null, unscheduledOpen: false, allDayExpanded: false };
}

/**
 * The current instant to the minute. Read on every render while the section is shown, so any
 * re-render sees the clock; the timers only make sure one happens on every minute boundary for the
 * now line and "past". A hidden section keeps its last value and runs no timer: nobody sees it, and
 * becoming visible re-renders, which reads the clock again (the immediate update on resume).
 */
function useNowIso(host: UiHost, visible: boolean): string {
	const [, setTick] = useState(0);
	const last = useRef<string | null>(null);
	useEffect(() => {
		if (!visible) return;
		const bump = () => setTick((n) => n + 1);
		let interval: number | undefined;
		// Align to the next minute boundary, then tick every 60 s.
		const first = window.setTimeout(
			() => {
				bump();
				interval = window.setInterval(bump, 60_000);
			},
			60_000 - (host.app.clock.now().getTime() % 60_000),
		);
		return () => {
			window.clearTimeout(first);
			if (interval !== undefined) window.clearInterval(interval);
		};
	}, [host, visible]);
	if (visible || last.current === null) last.current = `${host.app.clock.now().toISOString().slice(0, 16)}:00.000Z`;
	return last.current;
}

const NO_TASKS: readonly Task[] = [];

export function CalendarSection(props: {
	host: UiHost;
	state: DbData;
	ctx: QueryContext;
	ui: CalendarSectionState;
	/** Functional, so several quick clicks each build on the latest state. */
	setUi: (update: (s: CalendarSectionState) => CalendarSectionState) => void;
	/** True while the section is shown (a hidden one cannot scroll). */
	visible: boolean;
}) {
	const { host, state, ctx, ui, setUi } = props;
	const nowIso = useNowIso(host, props.visible);
	const weekStart = host.settings().weekStart;
	// The occurrence records, indexed by task, let the projection place a series' occurrences.
	const records = useActiveMemo(props.visible, () => indexOccurrenceRecords(state.occurrenceRecords), [state.occurrenceRecords], new Map());
	const calCtx: CalendarContext = useActiveMemo(
		props.visible,
		() => ({ zone: ctx.zone, today: ctx.today, now: nowIso, weekStart, records }),
		[ctx.zone, ctx.today, nowIso, weekStart, records],
		{ zone: ctx.zone, today: ctx.today, now: nowIso, weekStart, records },
	);
	// Only the open Unscheduled drawer lists tasks with a subtask count.
	const subtaskCounts = useSubtaskCounts(state.tasks, props.visible && ui.unscheduledOpen);
	const titleId = useUniqueId("cp-cal-title");
	const unscheduledTitleId = useUniqueId("cp-cal-unscheduled-title");
	const scrollMemo = useRef<number | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const toggleRef = useRef<HTMLButtonElement>(null);
	const dnd = useCalDnd(host, calCtx, () => rootRef.current);
	
	// Below 1200 px the drawers float; they start under the header so its controls (the Unscheduled
	// toggle) are never covered. The header's height changes when it wraps, so follow it.
	useLayoutEffect(() => {
		const root = rootRef.current;
		const header = root?.querySelector<HTMLElement>(".cp-cal-header");
		if (root === null || root === undefined || header === null || header === undefined) return;
		const measure = () => root.style.setProperty("--cp-cal-drawer-top", `${header.offsetTop + header.offsetHeight}px`);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(header);
		observer.observe(root);
		return () => observer.disconnect();
	}, []);

	// The store holds live tasks only (the trash is separate); the view menu narrows them.
	// Only while shown: a hidden calendar must not filter thousands of tasks on every store change.
	const tasks = useActiveMemo<readonly Task[]>(
		props.visible,
		() => filterTasks(state.tasks.values(), ui.filter, "", ctx),
		// `filterTasks` reads the effective schedule: completing or skipping an occurrence changes no task, only its records.
		[state.tasks, state.occurrenceRecords, ui.filter, ctx.today, ctx.zone, ctx.weekStart],
		NO_TASKS,
	);
	const days = useMemo(() => (ui.mode === "week" ? weekDays(ui.anchor, weekStart) : []), [ui.mode, ui.anchor, weekStart]);
	const grid = useMemo(() => (ui.mode === "month" ? monthGrid(ui.anchor, weekStart) : []), [ui.mode, ui.anchor, weekStart]);

	// Open tasks without a schedule, narrowed by the same menu.
	const unscheduled = useActiveMemo<ListEntry[]>(
		props.visible,
		() => {
			// A repeating task has no schedule of its own (its dates are the series), so it is never "unscheduled".
			const list = tasks.filter((t) => t.scheduled === null && t.recurrence === null && t.status === "open").sort(compareTasksBySortKey);
			return list.map<ListEntry>((t) => entryOf(t, state.tasks, ctx));
		},
		[tasks, state.tasks, state.occurrenceRecords],
		[],
	);

	// A fixed identity, so the drawer's memoized rows are not rendered again by every render of the section.
	const select = useStableCallback((id: ID | null) => setUi((s) => ({ ...s, selectedId: id })));
	const openWeek = (date: LocalDate) => setUi((s) => ({ ...s, mode: "week", anchor: date }));

	const title = ui.mode === "week" ? weekTitle(days) : monthTitle(ui.anchor);
	const groups: ViewGroup[] = [{ key: "all", date: null, entries: unscheduled }];
	
	const closeUnscheduled = () => {
		setUi((s) => ({ ...s, unscheduledOpen: false }));
		// The toggle never unmounts, so focus can move there right away.
		toggleRef.current?.focus();
	};

	return (
		<div ref={rootRef} class={`cp-calendar${ui.selectedId !== null ? " has-details" : ""}${dnd.draggingId !== null ? " is-dragging" : ""}`}>
			<div class="cp-cal-main">
				<CalendarHeader
					host={host}
					title={title}
					titleId={titleId}
					mode={ui.mode}
					onMode={(mode) => setUi((s) => ({ ...s, mode }))}
					onStep={(step) => setUi((s) => ({ ...s, anchor: shiftAnchor(s.anchor, s.mode, step, ctx.today) }))}
					onToday={() => setUi((s) => ({ ...s, anchor: ctx.today }))}
					unscheduledOpen={ui.unscheduledOpen}
					unscheduledCount={unscheduled.length}
					onToggleUnscheduled={() => setUi((s) => ({ ...s, unscheduledOpen: !s.unscheduledOpen }))}
					toggleRef={toggleRef}
					viewMenu={<ScopeMenuButton host={host} visible={props.visible} filter={ui.filter} onChange={(update) => setUi((s) => ({ ...s, filter: update(s.filter) }))} />}
				/>
				<div class="cp-cal-content">
					{ui.mode === "week" ? (
						<WeekView
							host={host}
							state={state}
							tasks={tasks}
							days={days}
							ctx={calCtx}
							labelId={titleId}
							selectedId={ui.selectedId}
							onSelect={select}
							visible={props.visible}
							scrollMemo={scrollMemo}
							allDayExpanded={ui.allDayExpanded}
							onAllDayExpanded={(allDayExpanded) => setUi((s) => ({ ...s, allDayExpanded }))}
							dnd={dnd}
						/>
					) : (
						<MonthView
							host={host}
							state={state}
							tasks={tasks}
							grid={grid}
							month={ui.anchor.slice(0, 7)}
							ctx={calCtx}
							labelId={titleId}
							selectedId={ui.selectedId}
							onSelect={select}
							onOpenWeek={openWeek}
							dnd={dnd}
						/>
					)}
				</div>
			</div>
			{ui.unscheduledOpen && (
				<aside
					class="cp-cal-unscheduled"
					aria-labelledby={unscheduledTitleId}
					onPointerDown={(e) => {
						// A row of the drawer drags onto the grid. Controls inside a row (the checkbox) keep their click.
						const target = e.target as HTMLElement;
						const row = target.closest<HTMLElement>(".cp-task-row");
						if (row === null || target.closest("button, input, a") !== null) return;
						const task = state.tasks.get(row.getAttribute("data-task-id") ?? "");
						if (task === undefined || task.scheduled !== null || task.recurrence !== null) return;
						dnd.start(e, row, { kind: "drawer", task });
					}}
					onKeyDown={(e) => {
						// Escape closes only the drawer: the key must not reach Obsidian's handlers.
						if (e.key === "Escape") {
							e.preventDefault();
							e.stopPropagation();
							closeUnscheduled();
						}
					}}
				>
					<div class="cp-cal-unscheduled-head">
						<h3 class="cp-cal-unscheduled-title" id={unscheduledTitleId}>
							Unscheduled
						</h3>
						<IconButton host={host} icon="x" label="Close unscheduled tasks" cls="cp-cal-unscheduled-close" onClick={closeUnscheduled} />
					</div>
					<TaskList
						host={host}
						state={state}
						groups={groups}
						ctx={ctx}
						selectedId={ui.selectedId}
						showCategory={true}
						emptyText="No unscheduled tasks."
						label="Unscheduled tasks"
						subtaskCounts={subtaskCounts}
						onSelect={select}
					/>
				</aside>
			)}
			<DetailsPane host={host} state={state} ctx={ctx} selectedId={ui.selectedId} onSelect={select} />
		</div>
	);
}
