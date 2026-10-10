import type { HabitInput } from "../../domain/habits";
import { Icon } from "../common";
import type { UiHost } from "../host";
import { ICON } from "../icons";

// First visit: the example chips open the New habit dialog prefilled; they never create
// a habit on their own.

const daily = { kind: "daily" } as const;

const EXAMPLES: { label: string; input: HabitInput }[] = [
	{
		label: "Read 30 min a day",
		input: { name: "Read", icon: "book-open", color: "purple", timeOfDay: "evening", reminder: null, goal: { type: "quantity", target: 30, unit: "min", period: "day" }, schedule: daily },
	},
	{
		label: "Drink 8 glasses",
		input: { name: "Drink water", icon: "droplet", color: "blue", timeOfDay: "anytime", reminder: null, goal: { type: "count", target: 8, unit: "glasses", period: "day" }, schedule: daily },
	},
	{
		label: "Meditate",
		input: { name: "Meditate", icon: "flower-2", color: "pink", timeOfDay: "morning", reminder: null, goal: { type: "binary", target: 1, unit: null, period: "day" }, schedule: daily },
	},
	{
		label: "Gym 3 times a week",
		input: { name: "Gym", icon: "dumbbell", color: "orange", timeOfDay: "afternoon", reminder: null, goal: { type: "binary", target: 3, unit: null, period: "week" }, schedule: { kind: "weekly" } },
	},
];

export function EmptyHabits(props: { host: UiHost; onExample: (input: HabitInput) => void }) {
	return (
		<div class="cp-habit-empty">
			<div class="cp-habit-empty-box">
				<span class="cp-habit-empty-icon cp-hue-orange">
					<Icon host={props.host} icon={ICON.railHabits} />
				</span>
				<h3>Build a habit, one day at a time</h3>
				<p>Track things you do regularly. Tick them off, count them, or log an amount, and watch your streak grow.</p>
				<div class="cp-habit-examples">
					{EXAMPLES.map((e) => (
						<button key={e.label} type="button" onClick={() => props.onExample(e.input)}>
							{e.label}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
