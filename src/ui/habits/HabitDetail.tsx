import { type HabitIndex, monthStats, streaks, total } from "../../domain/habits";
import { plural } from "../../domain/text";
import type { Habit, LocalDate } from "../../domain/types";
import { IconButton } from "../common";
import { useUniqueId } from "../hooks";
import type { MenuSpec, UiHost } from "../host";
import { ICON } from "../icons";
import { CheckinLog } from "./CheckinLog";
import { HabitIcon } from "./HabitRow";
import { MonthCalendar } from "./MonthCalendar";
import { runWrite } from "../writeNotice";
import { habitDialogOptions } from "./actions";
import { currentVersion, detailLine, monthOf, shiftMonth, streakText, totalText } from "./format";

// The right column of the Habits page: the selected habit's goal in words, four tiles, the
// month calendar and the check-in log.

export function HabitDetail(props: {
	host: UiHost;
	habit: Habit;
	index: HabitIndex;
	today: LocalDate;
	zone: string;
	month: string;
	onMonth: (month: string) => void;
}) {
	const { host, habit, index, today } = props;
	const titleId = useUniqueId("cp-habit-detail");
	const archived = habit.archivedAt !== null;
	const version = currentVersion(habit, today);
	const s = streaks(habit, index, today);
	const m = monthStats(habit, index, monthOf(today), today);
	const first = monthOf(habit.versions[0]!.effectiveFrom);
	// The month is shared by every habit of the page: a habit that started later than the shown month (or a month
	// after today) shows its nearest month instead of an empty one with Previous disabled.
	const thisMonth = monthOf(today);
	const month = props.month < first ? first : props.month > thisMonth ? thisMonth : props.month;

	const edit = () => void host.habitDialog(habitDialogOptions(host, { habit })).catch((err: unknown) => host.error(err));
	const remove = async () => {
		const n = host.app.habits.checkinCount(habit.id);
		const checkins = plural(n, "check-in");
		const answer = await host.choose("Delete habit?", `Delete "${habit.name}" and its ${checkins}? Archive keeps the history.`, [
			{ label: "Delete habit", value: true, warning: true },
		]);
		if (answer !== true) return;
		await runWrite(host, () => host.app.habits.delete(habit.id), `Deleted ${habit.name} and its ${checkins}.`);
	};
	const menu: MenuSpec = [
		archived
			? { title: "Restore", icon: ICON.restore, run: () => void runWrite(host, () => host.app.habits.restore(habit.id), `Restored ${habit.name}.`) }
			: { title: "Archive", icon: ICON.archive, run: () => void runWrite(host, () => host.app.habits.archive(habit.id), `Archived ${habit.name}.`) },
		"separator",
		{ title: "Delete habit…", icon: ICON.remove, warning: true, run: () => void remove() },
	];
	const shift = (by: -1 | 1) => props.onMonth(shiftMonth(month, by));
	return (
		<aside class="cp-habit-detail" aria-labelledby={titleId}>
			<div class="cp-habit-detail-head">
				<HabitIcon host={host} habit={habit} />
				<div class="cp-habit-detail-title">
					<h3 id={titleId}>{habit.name}</h3>
					<p>{detailLine(habit, today)}</p>
				</div>
				<IconButton host={host} icon={ICON.edit} label="Edit habit" onClick={edit} />
				<IconButton host={host} icon={ICON.more} label="More: archive, delete" onClick={(e) => host.showMenu(e, menu)} />
			</div>
			<div class="cp-habit-tiles">
				<div class={`cp-habit-tile${s.current > 0 ? " is-fire" : ""}`}>
					<span class="cp-habit-tile-k">Current streak</span>
					<span class="cp-habit-tile-v">
						{s.current}
						<small>{` ${streakUnit(s.current, s.unit)}`}</small>
					</span>
				</div>
				<div class="cp-habit-tile">
					<span class="cp-habit-tile-k">Best streak</span>
					<span class="cp-habit-tile-v">
						{s.best}
						<small>{` ${streakUnit(s.best, s.unit)}`}</small>
					</span>
				</div>
				<div class="cp-habit-tile">
					<span class="cp-habit-tile-k">This month</span>
					<span class="cp-habit-tile-v">
						{m.met}
						<small>{` of ${m.of} ${m.unit}`}</small>
					</span>
				</div>
				<div class="cp-habit-tile">
					<span class="cp-habit-tile-k">Total</span>
					<span class="cp-habit-tile-v">{totalText(habit, total(habit, index), today)}</span>
				</div>
			</div>
			<MonthCalendar
				host={host}
				habit={habit}
				index={index}
				month={month}
				today={today}
				weekStart={version.weekStart}
				onMonth={shift}
				canPrev={month > first}
				canNext={month < thisMonth}
			/>
			<CheckinLog host={host} habit={habit} index={index} today={today} zone={props.zone} />
		</aside>
	);
}

/** "day" for one, else "days" (weeks likewise). */
function streakUnit(n: number, unit: "days" | "weeks"): string {
	return streakText(n, unit).replace(/^\d+ /u, "");
}
