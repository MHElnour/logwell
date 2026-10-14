import { type HabitIndex, dayShare, groupHabits, isScheduled, versionAt } from "../../domain/habits";
import type { Habit, LocalDate } from "../../domain/types";
import { Icon } from "../common";
import { useUniqueId } from "../hooks";
import type { UiHost } from "../host";
import { ICON } from "../icons";
import { HabitControl } from "./HabitControl";
import { HabitIcon, HabitRow } from "./HabitRow";
import { habitsOn } from "./HabitGroups";
import { doneOn, metText, progressText } from "./format";

// Habits in Today: a block above the task list in List mode and the first column in Board mode. Only the
// Today view shows them, and only while a habit that is not archived exists. They are not tasks: they never
// count in the sidebar badge or the view's count.

interface TodayHabits {
	index: HabitIndex;
	/** Scheduled today, in time-of-day group order. */
	scheduled: Habit[];
	done: Habit[];
	open: Habit[];
	/** On their first day or later but not scheduled today. */
	off: Habit[];
	met: number;
}

function todayHabits(host: UiHost, today: LocalDate): TodayHabits | null {
	const habits = habitsOn(host.app.habits.list(), today);
	if (habits.length === 0) return null;
	const index = host.app.habits.index();
	const scheduled = groupHabits(habits.filter((h) => isScheduled(h, today))).flatMap((g) => g.habits);
	const done = scheduled.filter((h) => doneOn(h, index, today));
	const doneSet = new Set(done);
	return {
		index,
		scheduled,
		done,
		open: scheduled.filter((h) => !doneSet.has(h)),
		off: habits.filter((h) => !isScheduled(h, today)),
		met: dayShare(scheduled, index, today, today).met,
	};
}

const names = (habits: Habit[]) => habits.map((h) => h.name).join(", ");

/** List mode: the block between the add bar and the task list. */
export function TodayHabitsBlock(props: { host: UiHost; today: LocalDate }) {
	const { host, today } = props;
	const headingId = useUniqueId("cp-today-habits");
	const t = todayHabits(host, today);
	if (t === null) return null;
	const fold = [t.done.length > 0 ? `✓ ${names(t.done)} done` : "", t.off.length > 0 ? `${names(t.off)} not scheduled today` : ""].filter((p) => p !== "");
	return (
		<div class="cp-today-habits" role="group" aria-labelledby={headingId}>
			<div class="cp-today-habits-head">
				<h3 id={headingId}>
					<Icon host={host} icon={ICON.railHabits} cls="cp-today-habits-flame" />
					<span class="cp-today-habits-name">Habits</span>
					<span class="cp-today-habits-count">
						<span class="cp-sr-only"> · </span>
						{metText(t.met, t.scheduled.length)}
					</span>
				</h3>
				<button type="button" class="cp-today-habits-link" onClick={() => host.openSection("habits")}>
					Open habits
				</button>
			</div>
			{t.open.map((h) => (
				<HabitRow key={h.id} host={host} habit={h} index={t.index} date={today} today={today} compact />
			))}
			{fold.length > 0 && <div class="cp-today-habits-fold">{fold.join(" · ")}</div>}
		</div>
	);
}

/** Board mode: the first column. It is not one of the view's board columns: no drops, no keyboard moves. */
export function TodayHabitsColumn(props: { host: UiHost; today: LocalDate }) {
	const { host, today } = props;
	const titleId = useUniqueId("cp-board-habits");
	const t = todayHabits(host, today);
	if (t === null) return null;
	return (
		<section class="cp-board-col cp-board-habits" aria-labelledby={titleId}>
			<div class="cp-board-col-head">
				<h3 class="cp-board-col-title" id={titleId}>
					<Icon host={host} icon={ICON.railHabits} cls="cp-today-habits-flame" />
					<span>Habits</span>
				</h3>
				<span class="cp-board-col-count">{`${t.met} of ${t.scheduled.length}`}</span>
			</div>
			<div class="cp-board-col-body">
				<div class="cp-board-cards">
					{t.scheduled.map((h) => (
						<HabitCard key={h.id} host={host} habit={h} index={t.index} today={today} />
					))}
				</div>
				{t.scheduled.length === 0 && <p class="cp-board-empty">Nothing scheduled today</p>}
			</div>
		</section>
	);
}

function HabitCard(props: { host: UiHost; habit: Habit; index: HabitIndex; today: LocalDate }) {
	const { host, habit, index, today } = props;
	const done = doneOn(habit, index, today);
	const goal = versionAt(habit, today)?.goal;
	const text = done && goal?.type === "binary" && goal.period === "day" ? "Done" : progressText(habit, index, today);
	return (
		<div class={`cp-habit-card${done ? " is-done" : ""}`} data-habit-id={habit.id}>
			<HabitIcon host={host} habit={habit} />
			<span class="cp-habit-what">
				<span class="cp-habit-name">{habit.name}</span>
				<span class="cp-habit-card-meta">{text}</span>
			</span>
			<span class="cp-habit-ctl">
				<HabitControl host={host} habit={habit} index={index} date={today} today={today} variant="card" />
			</span>
		</div>
	);
}
