import type { MutableRef } from "preact/hooks";
import { useLayoutEffect, useMemo, useRef } from "preact/hooks";
import { type CalendarContext, type DayHours, type TimedSegment, layoutWeek } from "../../domain/calendar";
import { plural } from "../../domain/text";
import { pad2 } from "../../domain/time";
import type { ID, LocalDate, Task } from "../../domain/types";
import type { DbData } from "../../persistence/schema";
import { Icon } from "../common";
import { useUniqueId } from "../hooks";
import type { UiHost } from "../host";
import { ICON } from "../icons";
import type { CalDnd } from "./dnd";
import { EntryButton, RepeatMark, describeAllDay, describeTimed, isSelectedEntry } from "./entries";
import { fmtDay, fmtDom, fmtDow } from "./format";
import { ALLDAY_LIMIT, SHORT_BLOCK_MIN, initialScrollTop, nowMinutes } from "./geometry";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** The overlay of a skipped or repeated hour, placed by minute like a block. */
function HourMark({ day, hours }: { day: LocalDate; hours: DayHours | undefined }) {
	if (hours === undefined) return null;
	return (
		<>
			{hours.skipped !== null && (
				<div
					class="cp-cal-skipped"
					data-date={day}
					style={{ "--cp-start": String(hours.skipped.startMin), "--cp-len": String(hours.skipped.endMin - hours.skipped.startMin) }}
				>
					<span class="cp-sr-only">Skipped (daylight saving)</span>
				</div>
			)}
			{hours.repeated !== null && (
				<div
					class="cp-cal-repeated"
					data-date={day}
					style={{ "--cp-start": String(hours.repeated.startMin), "--cp-len": String(hours.repeated.endMin - hours.repeated.startMin) }}
				>
					<span class="cp-cal-repeated-mark" aria-hidden="true">
						×2
					</span>
					<span class="cp-sr-only">Repeated hour</span>
				</div>
			)}
		</>
	);
}

/** Either half of a block that runs past midnight: resizing it would cut the task at the day end, so it has no handle. */
const crossesMidnight = (seg: TimedSegment) => seg.continued || seg.endMin - seg.startMin < seg.durationMin;

/** The drop-target class of a day column (area "grid") or an all-day cell (area "allday") while dragging. */
function dropClass(ghost: CalDnd["ghost"], date: LocalDate, area: "grid" | "allday"): string {
	if (ghost === null) return "";
	if (ghost.kind === "slot") return area === "grid" && ghost.colDate === date ? " is-drop-target" : "";
	if (ghost.kind === "cell") return area === "allday" && ghost.area === "allday" && ghost.date === date ? " is-drop-target" : "";
	return ghost.area === area && ghost.date === date ? " is-drop-refused" : "";
}

/** The week grid. All geometry comes from layoutWeek; nothing is recomputed here. */
export function WeekView(props: {
	host: UiHost;
	state: DbData;
	/** Already filtered by the filter bar. */
	tasks: readonly Task[];
	days: LocalDate[];
	ctx: CalendarContext;
	labelId: string;
	selectedId: ID | null;
	onSelect: (id: ID) => void;
	/** True while the section is shown: a hidden section cannot scroll. */
	visible: boolean;
	/** The grid's scroll offset, kept by the section across mode and section switches. */
	scrollMemo: MutableRef<number | null>;
	/** The all-day row shows every entry (true) or at most three per day (false). */
	allDayExpanded: boolean;
	onAllDayExpanded: (expanded: boolean) => void;
	/** Drag and drop state; the ghost and the drop targets are drawn here. */
	dnd: CalDnd;
}) {
	const { host, state, days, ctx, dnd } = props;
	const ghost = dnd.ghost;
	const base = useUniqueId("cp-cal-week");
	const alldayLabelId = `${base}-allday`;
	const layout = useMemo(() => layoutWeek(props.tasks, days, ctx), [props.tasks, days, ctx]);
	const todayVisible = days.includes(ctx.today);
	const nowMin = nowMinutes(ctx.now, ctx.zone);

	const scrollerRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const el = scrollerRef.current;
		if (el === null || !props.visible) return;
		const top = props.scrollMemo.current ?? initialScrollTop(nowMin, todayVisible);
		props.scrollMemo.current = top;
		el.scrollTop = top;
	}, [props.visible]);

	const onScroll = () => {
		const el = scrollerRef.current;
		// A hidden section reports a zero offset; only a shown one is remembered.
		if (el !== null && props.visible) props.scrollMemo.current = el.scrollTop;
	};

	// Expanding or collapsing removes the control that was clicked; focus goes to its counterpart in
	// the same day so a keyboard user stays where they were. Held in a ref, not read from the event.
	const focusAfter = useRef<LocalDate | null>(null);
	useLayoutEffect(() => {
		const date = focusAfter.current;
		focusAfter.current = null;
		if (date === null) return;
		const cls = props.allDayExpanded ? "cp-cal-allday-less" : "cp-cal-allday-more";
		scrollerRef.current?.querySelector<HTMLElement>(`.cp-cal-allday-cell[data-date="${date}"] .${cls}`)?.focus();
	}, [props.allDayExpanded]);
	const setExpanded = (date: LocalDate, expanded: boolean) => {
		focusAfter.current = date;
		props.onAllDayExpanded(expanded);
	};

	const colorOf = (task: Task) => state.categories.get(task.categoryId)?.color;
	const headId = (date: LocalDate) => `${base}-head-${date}`;

	const block = (seg: TimedSegment) => {
		const view = describeTimed(seg);
		const { task } = seg;
		return (
			<EntryButton
				key={view.key}
				view={view}
				listColor={colorOf(seg.task)}
				selected={isSelectedEntry(view, props.selectedId)}
				extraClass={seg.endMin - seg.startMin < SHORT_BLOCK_MIN ? "is-short" : undefined}
				style={{
					"--cp-start": String(seg.startMin),
					"--cp-len": String(seg.endMin - seg.startMin),
					"--cp-col": String(seg.column),
					"--cp-cols": String(seg.columns),
				}}
				onSelect={props.onSelect}
				dragging={dnd.draggingId === task.id}
				// An occurrence is neither moved nor resized; the series changes in the details pane.
				onDragStart={view.repeat ? undefined : (e, el) => dnd.start(e, el, { kind: "timed", task, seg })}
				onResizeStart={view.repeat || crossesMidnight(seg) ? undefined : (e, el) => dnd.start(e, el, { kind: "resize", task, seg })}
			>
				<RepeatMark host={host} view={view} />
				<span class="cp-cal-entry-text">{seg.task.title}</span>
				{seg.noDuration ? <span class="cp-cal-noduration">no duration</span> : <span class="cp-cal-entry-time">{view.range}</span>}
			</EntryButton>
		);
	};

	/** One all-day cell: at most ALLDAY_LIMIT entries while collapsed, then "+k more". */
	const allDayCell = (date: LocalDate) => {
		const all = layout.allDay.get(date) ?? [];
		const hidden = props.allDayExpanded ? 0 : Math.max(0, all.length - ALLDAY_LIMIT);
		const shown = hidden > 0 ? all.slice(0, ALLDAY_LIMIT) : all;
		return (
			<>
				{shown.map((e) => {
					const view = describeAllDay(e, ctx.zone);
					return (
						<EntryButton
							key={view.key}
							view={view}
							listColor={colorOf(e.task)}
							selected={isSelectedEntry(view, props.selectedId)}
							onSelect={props.onSelect}
							dragging={dnd.draggingId === e.task.id}
							onDragStart={e.kind === "date" && !view.repeat ? (ev, el) => dnd.start(ev, el, { kind: "allday", task: e.task }) : undefined}
						>
							{view.deadline && <Icon host={host} icon={ICON.flag} />}
							<RepeatMark host={host} view={view} />
							<span class="cp-cal-entry-text">{e.task.title}</span>
						</EntryButton>
					);
				})}
				{hidden > 0 && (
					<button
						type="button"
						class="cp-cal-allday-more"
						aria-label={`Show ${plural(hidden, "more all-day item")}`}
						aria-expanded="false"
						onClick={() => setExpanded(date, true)}
					>
						+{hidden} more
					</button>
				)}
				{props.allDayExpanded && all.length > ALLDAY_LIMIT && (
					<button type="button" class="cp-cal-allday-less" aria-expanded="true" onClick={() => setExpanded(date, false)}>
						Show less
					</button>
				)}
			</>
		);
	};

	return (
		<div class="cp-cal-week" role="group" aria-labelledby={props.labelId}>
			<div class="cp-cal-scroller" ref={scrollerRef} onScroll={onScroll}>
				<div class="cp-cal-week-inner">
					<div class="cp-cal-sticky">
						<div class="cp-cal-head-row">
							<div class="cp-cal-gutter-cell" aria-hidden="true" />
							{days.map((date) => (
								<div key={date} class={`cp-cal-dayhead${date === ctx.today ? " is-today" : ""}`} data-date={date}>
									<span class="cp-cal-dow" aria-hidden="true">
										{fmtDow(date)}
									</span>
									<span class="cp-cal-dom" aria-hidden="true">
										{fmtDom(date)}
									</span>
									<span class="cp-sr-only" id={headId(date)}>
										{fmtDay(date)}
										{date === ctx.today ? ", today" : ""}
									</span>
								</div>
							))}
						</div>
						<div class={`cp-cal-allday${props.allDayExpanded ? " is-expanded" : ""}`}>
							<div class="cp-cal-gutter-cell cp-cal-allday-label" id={alldayLabelId}>
								All day
							</div>
							{days.map((date) => (
								<div
									key={date}
									class={`cp-cal-allday-cell${dropClass(ghost, date, "allday")}`}
									data-date={date}
									role="group"
									aria-labelledby={`${alldayLabelId} ${headId(date)}`}
								>
									{allDayCell(date)}
								</div>
							))}
						</div>
					</div>
					<div class="cp-cal-body">
						<div class="cp-cal-gutter" aria-hidden="true">
							{HOURS.map((h) => (
								<div key={h} class="cp-cal-hour-label">
									{pad2(h)}:00
								</div>
							))}
						</div>
						{days.map((date, i) => (
							<div key={date} class={`cp-cal-daycol${date === ctx.today ? " is-today" : ""}${dropClass(ghost, date, "grid")}`} data-date={date} role="group" aria-labelledby={headId(date)}>
								<HourMark day={date} hours={layout.hours[i]} />
								{(layout.timed.get(date) ?? []).map(block)}
								{ghost?.kind === "slot" && ghost.date === date && (
									<div
										class={`cp-cal-ghost${ghost.resize ? " is-resize" : ""}`}
										aria-hidden="true"
										style={{ "--cp-start": String(ghost.startMin), "--cp-len": String(ghost.lenMin) }}
									>
										<span class="cp-cal-ghost-time">{ghost.label}</span>
									</div>
								)}
								{date === ctx.today && <div class="cp-cal-now" aria-hidden="true" style={{ "--cp-start": String(nowMin) }} />}
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
