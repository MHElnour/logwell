import { describeEnd, describeRule, versionAt } from "../domain/recurrence";
import { isActiveSeries } from "../domain/tasks";
import type { LocalDate, Task } from "../domain/types";
import { Icon } from "./common";
import type { UiHost } from "./host";
import { withTime } from "./repeat";

/**
 * The repeat mark of a row or a card: the repeat icon alone. Its label says the rule ("Repeats every Fri · ends after
 * 10 times"), which a hover shows. Only an open series has one: a stopped series is a completed task like any other, and a
 * task that does not repeat looks exactly as before. `today` is the row's or card's own day (its `ctx.today`, which its
 * memo compares).
 */
export function RepeatChip({ host, task, today }: { host: UiHost; task: Task; today: LocalDate }) {
	if (!isActiveSeries(task)) return null;
	const rec = task.recurrence;
	// The rule in force today, not a later version that has not started.
	const full = withTime(describeRule(rec, today), versionAt(rec, today).rule);
	const end = describeEnd(rec, today);
	return (
		<span class="cp-meta-repeat" role="img" aria-label={end === null ? `Repeats ${full}` : `Repeats ${full} · ${end}`}>
			<Icon host={host} icon="repeat" />
		</span>
	);
}
