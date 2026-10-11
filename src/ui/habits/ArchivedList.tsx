import type { Habit, LocalDate } from "../../domain/types";
import type { UiHost } from "../host";
import { runWrite } from "../writeNotice";
import { HabitIcon } from "./HabitRow";
import { detailLine } from "./format";

// The archived habits: their history stays viewable. A row selects the habit for the detail; Restore
// puts it back. There is no check-in control here.

export function ArchivedList(props: { host: UiHost; habits: Habit[]; today: LocalDate; selectedId: string | null; onSelect: (id: string) => void }) {
	const { host, today } = props;
	return (
		<div class="cp-habit-list cp-habit-archived">
			{props.habits.map((h) => (
				<div
					key={h.id}
					class={`cp-habit-row is-archived${h.id === props.selectedId ? " is-selected" : ""}`}
					data-habit-id={h.id}
					onClick={() => props.onSelect(h.id)}
				>
					<HabitIcon host={host} habit={h} />
					<span class="cp-habit-what">
						<button type="button" class="cp-habit-name" aria-current={h.id === props.selectedId ? "true" : undefined}>
							{h.name}
						</button>
						<span class="cp-habit-meta">
							<span class="cp-habit-progress">{detailLine(h, today)}</span>
						</span>
					</span>
					<span class="cp-habit-ctl">
						<button
							type="button"
							class="cp-habit-restore"
							aria-label={`Restore ${h.name}`}
							onClick={(e) => {
								e.stopPropagation();
								void runWrite(host, () => host.app.habits.restore(h.id), `Restored ${h.name}.`);
							}}
						>
							Restore
						</button>
					</span>
				</div>
			))}
		</div>
	);
}
