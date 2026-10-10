import { type HabitIndex, monthCells } from "../../domain/habits";
import type { Habit, LocalDate, WeekStart } from "../../domain/types";
import { IconButton } from "../common";
import type { UiHost } from "../host";
import { ICON } from "../icons";
import { weekdayInitials } from "../format";
import { cellClass, cellLabel, monthTitle } from "./format";

// The History month calendar of the selected habit. Goal met, some progress, missed; the
// arrows step a month. The day number is visible and the status is screen-reader text (no aria-label: Obsidian would show a tooltip on every cell), so a screen reader reads "Oct 4, goal met".

export function MonthCalendar(props: {
	host: UiHost;
	habit: Habit;
	index: HabitIndex;
	month: string;
	today: LocalDate;
	weekStart: WeekStart;
	onMonth: (by: -1 | 1) => void;
	canPrev: boolean;
	canNext: boolean;
}) {
	const { host, habit, index, month, today } = props;
	const rows = monthCells(habit, index, month, today, props.weekStart);
	const initials = weekdayInitials(props.weekStart);
	return (
		<div class="cp-habit-history">
			<div class="cp-habit-sec-head">
				<h4>History</h4>
				<span class="cp-habit-month-nav">
					<IconButton host={host} icon={ICON.calPrev} label="Previous month" disabled={!props.canPrev} onClick={() => props.onMonth(-1)} />
					<span class="cp-habit-month-title">{monthTitle(month)}</span>
					<IconButton host={host} icon={ICON.calNext} label="Next month" disabled={!props.canNext} onClick={() => props.onMonth(1)} />
				</span>
			</div>
			<div class="cp-habit-cal">
				{initials.map((d, i) => (
					<span key={i} class="cp-habit-wd" aria-hidden="true">
						{d}
					</span>
				))}
				{rows.flat().map((c, i) =>
					c.date === null || c.status === null ? (
						<span key={`b${i}`} class="cp-habit-cell is-blank" />
					) : (
						<span
							key={c.date}
							class={`cp-habit-cell is-${cellClass(c.status)}${c.date === today ? " is-today" : ""}`}
						>
							{Number(c.date.slice(8, 10))}
							<span class="cp-sr-only">{cellLabel(c.date, c.status)}</span>
						</span>
					),
				)}
			</div>
			<div class="cp-habit-legend" aria-hidden="true">
				<span>
					<i class="is-met" />
					Goal met
				</span>
				<span>
					<i class="is-part" />
					Some progress
				</span>
				<span>
					<i class="is-miss" />
					Missed
				</span>
			</div>
		</div>
	);
}
