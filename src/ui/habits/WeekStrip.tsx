import type { LocalDate } from "../../domain/types";
import { SrOnly } from "../common";
import { useUniqueId } from "../hooks";
import type { StripDay } from "./format";

// The week strip: the seven days ending today, each with a ring for the share of that day's
// habits that were met. A past day opens that day's list for backfilling; clicking Today, or the selected day
// again, returns to today. A future day is disabled (the strip never reaches one, but the rule stays here).

const R = 16;
const C = 2 * Math.PI * R;

function Ring(props: { share: number }) {
	return (
		<svg viewBox="0 0 38 38" aria-hidden="true">
			<circle class="cp-habit-ring-track" cx="19" cy="19" r={R} />
			<circle class="cp-habit-ring-bar" cx="19" cy="19" r={R} stroke-dasharray={C} stroke-dashoffset={C * (1 - props.share)} />
		</svg>
	);
}

export function WeekStrip(props: {
	days: StripDay[];
	today: LocalDate;
	/** The day shown; null = today. */
	selected: LocalDate | null;
	onSelect: (day: LocalDate | null) => void;
}) {
	const labelId = useUniqueId("cp-habit-week");
	const shown = props.selected ?? props.today;
	return (
		<div class="cp-habit-week" role="group" aria-labelledby={labelId}>
			<SrOnly id={labelId}>This week</SrOnly>
			{props.days.map((d) => {
				const isToday = d.date === props.today;
				const isShown = d.date === shown;
				return (
					<button
						key={d.date}
						type="button"
						class={`cp-habit-day${isToday ? " is-today" : ""}${isShown && !isToday ? " is-selected" : ""}`}
						aria-label={d.label}
						aria-pressed={isShown}
						aria-current={isToday ? "date" : undefined}
						disabled={d.date > props.today}
						onClick={() => props.onSelect(isToday || d.date === props.selected ? null : d.date)}
					>
						<span class="cp-habit-day-name">{d.name}</span>
						<span class="cp-habit-day-ring">
							<Ring share={d.share} />
							<b>{d.num}</b>
						</span>
					</button>
				);
			})}
		</div>
	);
}
