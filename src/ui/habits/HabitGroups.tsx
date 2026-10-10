import { type HabitIndex, dayShare, groupHabits, versionAt } from "../../domain/habits";
import type { Habit, LocalDate, TimeOfDay } from "../../domain/types";
import { Icon } from "../common";
import { useUniqueId } from "../hooks";
import type { UiHost } from "../host";
import { HabitRow } from "./HabitRow";
import { TIME_OF_DAY_ICON, TIME_OF_DAY_NAME } from "./format";

// The habits of one day under Morning, Afternoon, Evening and Anytime, each heading with "n of m".

/** The habits that exist on `date` (a habit has no rule before its first day). */
export function habitsOn(habits: Habit[], date: LocalDate): Habit[] {
	return habits.filter((h) => h.archivedAt === null && versionAt(h, date) !== null);
}

export function HabitGroups(props: {
	host: UiHost;
	/** The day's habits by time of day (`groupHabits(habitsOn(…))`). */
	groups: ReturnType<typeof groupHabits>;
	index: HabitIndex;
	date: LocalDate;
	today: LocalDate;
	/** The group that shows the "Now" badge: only on today's list. */
	now: TimeOfDay | null;
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	const { groups, ...rest } = props;
	return (
		<div class="cp-habit-groups">
			{groups.map((g) => (
				<Group key={g.timeOfDay} {...rest} timeOfDay={g.timeOfDay} habits={g.habits} />
			))}
		</div>
	);
}

function Group(props: {
	host: UiHost;
	habits: Habit[];
	timeOfDay: TimeOfDay;
	index: HabitIndex;
	date: LocalDate;
	today: LocalDate;
	now: TimeOfDay | null;
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	const { host, index, date, today } = props;
	const headingId = useUniqueId("cp-habit-group");
	const { met, scheduled } = dayShare(props.habits, index, date, today);
	return (
		<div class="cp-habit-group" role="group" aria-labelledby={headingId} data-time-of-day={props.timeOfDay}>
			<h3 class="cp-habit-group-heading" id={headingId}>
				<Icon host={host} icon={TIME_OF_DAY_ICON[props.timeOfDay]} />
				<span class="cp-habit-group-name">{TIME_OF_DAY_NAME[props.timeOfDay]}</span>
				{props.now === props.timeOfDay && <span class="cp-habit-now">Now</span>}
				<span class="cp-habit-group-count">
					<span class="cp-sr-only"> · </span>
					{`${met} of ${scheduled}`}
				</span>
			</h3>
			<div class="cp-habit-list">
				{props.habits.map((h) => (
					<HabitRow
						key={`${h.id}|${date}`}
						host={host}
						habit={h}
						index={index}
						date={date}
						today={today}
						selected={h.id === props.selectedId}
						onSelect={props.onSelect}
					/>
				))}
			</div>
		</div>
	);
}
