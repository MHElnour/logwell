import { useMemo } from "preact/hooks";
import { type CalendarContext, layoutMonth } from "../../domain/calendar";
import type { ID, LocalDate, Task } from "../../domain/types";
import type { DbData } from "../../persistence/schema";
import { useUniqueId } from "../hooks";
import { Icon } from "../common";
import type { UiHost } from "../host";
import { ICON } from "../icons";
import type { CalDnd } from "./dnd";
import { EntryButton, RepeatMark, describeEntry, isAllDay, isSelectedEntry } from "./entries";
import { fmtDay, fmtDom, fmtDow } from "./format";

/** Whole weeks around the month; the first three titles per day, then "+k more". */
export function MonthView(props: {
	host: UiHost;
	state: DbData;
	/** Already filtered by the filter bar. */
	tasks: readonly Task[];
	grid: LocalDate[][];
	/** YYYY-MM */
	month: string;
	ctx: CalendarContext;
	labelId: string;
	selectedId: ID | null;
	onSelect: (id: ID) => void;
	/** Opens the week of a day (the day number and "+k more"). */
	onOpenWeek: (date: LocalDate) => void;
	/** Drag and drop state. */
	dnd: CalDnd;
}) {
	const { state, ctx, dnd } = props;
	const base = useUniqueId("cp-cal-month");
	const cells = useMemo(() => layoutMonth(props.tasks, props.grid, props.month, ctx), [props.tasks, props.grid, props.month, ctx]);

	return (
		<div class="cp-cal-month" role="group" aria-labelledby={props.labelId}>
			{/* Cells carry the full date for screen readers, so the weekday row is decoration. */}
			<div class="cp-cal-month-head" aria-hidden="true">
				{(props.grid[0] ?? []).map((date) => (
					<span key={date} class="cp-cal-month-dow">
						{fmtDow(date)}
					</span>
				))}
			</div>
			<div class="cp-cal-month-grid">
				{cells.map((row) => (
					<div key={row[0]?.date} class="cp-cal-month-row">
						{row.map((c) => {
							const labelId = `${base}-${c.date}`;
							const today = c.date === ctx.today;
							return (
								<div
									key={c.date}
									class={`cp-cal-cell${c.inMonth ? "" : " is-out"}${today ? " is-today" : ""}${dnd.ghost?.kind === "cell" && dnd.ghost.area === "month" && dnd.ghost.date === c.date ? " is-drop-target" : ""}`}
									data-date={c.date}
									role="group"
									aria-labelledby={labelId}
								>
									<span class="cp-sr-only" id={labelId}>
										{fmtDay(c.date)}
										{today ? ", today" : ""}
										{c.count > 0 ? `, ${c.count} ${c.count === 1 ? "entry" : "entries"}` : ""}
									</span>
									<div class="cp-cal-cell-head">
										<button type="button" class="cp-cal-daynum" aria-label={`Open week, ${fmtDay(c.date)}`} onClick={() => props.onOpenWeek(c.date)}>
											{fmtDom(c.date)}
										</button>
										{c.count > 0 && (
											<span class="cp-cal-count" aria-hidden="true">
												{c.count}
											</span>
										)}
									</div>
									{c.shown.length > 0 && (
										<ul class="cp-cal-cell-list">
											{c.shown.map((e) => {
												const view = describeEntry(e, ctx.zone);
												return (
													<li key={view.key}>
														<EntryButton
															view={view}
															listColor={state.categories.get(e.task.categoryId)?.color}
															selected={isSelectedEntry(view, props.selectedId)}
															extraClass="is-month"
															onSelect={props.onSelect}
															dragging={dnd.draggingId === e.task.id}
															onDragStart={
																(isAllDay(e) && e.kind === "deadline") || view.repeat
																	? undefined
																	: (ev, el) => dnd.start(ev, el, { kind: "month", task: e.task })
															}
														>
															{view.deadline && <Icon host={props.host} icon={ICON.flag} />}
															<RepeatMark host={props.host} view={view} />
															{view.time !== null && <span class="cp-cal-entry-time">{view.time}</span>}
															<span class="cp-cal-entry-text">{e.task.title}</span>
														</EntryButton>
													</li>
												);
											})}
										</ul>
									)}
									{c.more > 0 && (
										<button
											type="button"
											class="cp-cal-more"
											aria-label={`+${c.more} more, open week of ${fmtDay(c.date)}`}
											onClick={() => props.onOpenWeek(c.date)}
										>
											+{c.more} more
										</button>
									)}
								</div>
							);
						})}
					</div>
				))}
			</div>
		</div>
	);
}
