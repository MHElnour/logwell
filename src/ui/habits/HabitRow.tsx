import { type HabitIndex, progressOn, streaks } from "../../domain/habits";
import type { Habit, LocalDate } from "../../domain/types";
import { Icon, hueClass } from "../common";
import type { UiHost } from "../host";
import { ICON } from "../icons";
import { HabitControl } from "./HabitControl";
import { barShare, doneOn, habitIcon, progressText, streakText } from "./format";

// One habit on the Habits page and in the Today block: icon with its color, name, streak, meta,
// reminder bell, progress bar and the control.

/** The icon square with the habit's color (the accent when it has none). */
export function HabitIcon(props: { host: UiHost; habit: Habit; cls?: string }) {
	return (
		<span class={`cp-habit-icon ${hueClass(props.habit.color)} ${props.cls ?? ""}`}>
			<Icon host={props.host} icon={habitIcon(props.habit)} fallback={ICON.railHabits} />
		</span>
	);
}

/** The streak chip: the flame and "12 days"; nothing at 0. */
function StreakChip(props: { host: UiHost; habit: Habit; index: HabitIndex; today: LocalDate }) {
	const s = streaks(props.habit, props.index, props.today);
	if (s.current <= 0) return null;
	return (
		<span class="cp-habit-streak">
			<Icon host={props.host} icon={ICON.railHabits} />
			{streakText(s.current, s.unit)}
		</span>
	);
}

function ReminderBell(props: { host: UiHost; habit: Habit }) {
	if (props.habit.reminder === null || props.habit.archivedAt !== null) return null;
	return (
		<span class="cp-habit-bell">
			<Icon host={props.host} icon={ICON.bell} />
			{props.habit.reminder.time}
		</span>
	);
}

export function HabitRow(props: {
	host: UiHost;
	habit: Habit;
	index: HabitIndex;
	/** The day the page shows: every write of the control carries it. */
	date: LocalDate;
	today: LocalDate;
	selected?: boolean;
	/** Selecting is a page thing: the Today block passes none and its name is plain text. */
	onSelect?: (id: string) => void;
	/** The Today block's rows are a little smaller. */
	compact?: boolean;
}) {
	const { host, habit, index, date, today } = props;
	const progress = progressOn(habit, index, date);
	const share = barShare(habit, index, date, progress);
	const done = doneOn(habit, index, date, progress);
	return (
		<div
			class={`cp-habit-row${props.selected === true ? " is-selected" : ""}${done ? " is-done" : ""}${props.compact === true ? " is-compact" : ""}`}
			data-habit-id={habit.id}
			onClick={props.onSelect === undefined ? undefined : () => props.onSelect?.(habit.id)}
		>
			<HabitIcon host={host} habit={habit} />
			<span class="cp-habit-what">
				{props.onSelect === undefined ? (
					<span class="cp-habit-name">{habit.name}</span>
				) : (
					<button type="button" class="cp-habit-name" aria-current={props.selected === true ? "true" : undefined}>
						{habit.name}
					</button>
				)}
				<span class="cp-habit-meta">
					<StreakChip host={host} habit={habit} index={index} today={today} />
					<span class="cp-habit-progress">{progressText(habit, index, date, progress)}</span>
					<ReminderBell host={host} habit={habit} />
				</span>
				{share !== null && (
					<span class="cp-habit-bar">
						<i style={{ width: `${Math.round(share * 100)}%` }} />
					</span>
				)}
			</span>
			<span class="cp-habit-ctl">
				<HabitControl host={host} habit={habit} index={index} date={date} today={today} />
			</span>
		</div>
	);
}
