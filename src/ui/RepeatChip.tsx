import { describeEnd, describeRule, versionAt } from "../domain/recurrence";
import { isActiveSeries } from "../domain/tasks";
import type { LocalDate, Task } from "../domain/types";
import { Icon } from "./common";
import type { UiHost } from "./host";
import { withTime } from "./repeat";

/**
 * The purple repeat chip of a row or a card: the repeat icon and the short rule
 * text ("every Fri"). Only an open series has one: a stopped series is a completed task like any other, and a
 * task that does not repeat looks exactly as before. The title adds the end ("every Fri · ends after 10 times").
 * `today` is the row's or card's own day (its `ctx.today`, which its memo compares).
 */
export function RepeatChip({ host, task, today }: { host: UiHost; task: Task; today: LocalDate }) {
	if (!isActiveSeries(task)) return null;
	const rec = task.recurrence;
	// The rule in force today, not a later version that has not started.
	const text = describeRule(rec, today);
	const full = withTime(text, versionAt(rec, today).rule);
	const end = describeEnd(rec, today);
	return (
		<span class="cp-meta-repeat" title={end === null ? `Repeats ${full}` : `Repeats ${full} · ${end}`}>
			<Icon host={host} icon="repeat" />
			<span class="cp-meta-repeat-text">{text}</span>
		</span>
	);
}
