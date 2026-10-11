import { useMemo, useState } from "preact/hooks";
import type { HabitIndex } from "../../domain/habits";
import type { Habit, LocalDate } from "../../domain/types";
import { IconButton } from "../common";
import { formatDate } from "../format";
import type { UiHost } from "../host";
import { ICON } from "../icons";
import { runWrite } from "../writeNotice";
import { checkinText, checkinWhen, hasAmount, newestFirst, parseAmount, amountText } from "./format";

// The check-in log of the selected habit: newest first, 50 at a time, with Edit and Delete. A check-in
// of an archived habit is only shown: the service refuses to change it.

const PAGE = 50;

export function CheckinLog(props: { host: UiHost; habit: Habit; index: HabitIndex; today: LocalDate; zone: string }) {
	const { host, habit, today } = props;
	const [shown, setShown] = useState(PAGE);
	const all = useMemo(() => [...props.index.active(habit.id)].sort(newestFirst), [props.index, habit.id]);
	const editable = habit.archivedAt === null;
	const edit = async (id: string, current: number) => {
		const answer = await host.prompt("Edit check-in", [{ key: "value", label: "Amount", value: amountText(current) }], "Save");
		if (answer === null) return;
		const value = parseAmount(answer.value ?? "");
		if (value === null) {
			host.notify("Enter an amount above 0.");
			return;
		}
		await runWrite(host, () => host.app.habits.editCheckin(id, { value }), "Edited the check-in.");
	};
	return (
		<div class="cp-habit-checkins">
			<div class="cp-habit-sec-head">
				<h4>Check-ins</h4>
			</div>
			{all.length === 0 ? (
				<p class="cp-habit-none">No check-ins yet.</p>
			) : (
				<ul class="cp-habit-log">
					{all.slice(0, shown).map((c) => (
						<li key={c.id} class="cp-habit-entry">
							<span class="cp-habit-entry-day">{formatDate(c.date, today)}</span>
							<span class="cp-habit-entry-value">
								{checkinText(habit, c, today)}
								<small>{checkinWhen(c, props.zone)}</small>
							</span>
							{editable && (
								<span class="cp-habit-entry-actions">
									<IconButton
										host={host}
										icon={ICON.edit}
										label="Edit check-in"
										disabled={!hasAmount(habit, c, today)}
										onClick={() => void edit(c.id, c.value)}
									/>
									<IconButton
										host={host}
										icon={ICON.remove}
										label="Delete check-in"
										onClick={() => void runWrite(host, () => host.app.habits.deleteCheckin(c.id), "Deleted the check-in.")}
									/>
								</span>
							)}
						</li>
					))}
				</ul>
			)}
			{all.length > shown && (
				<button type="button" class="cp-habit-more" onClick={() => setShown(shown + PAGE)}>
					Show more
				</button>
			)}
		</div>
	);
}
