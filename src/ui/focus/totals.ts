import { taskFocusTotals } from "../../domain/focus";
import type { ID, FocusSession } from "../../domain/types";
import type { DbData } from "../../persistence/schema";

// Task focus totals, computed once per version of the focus-session map. A transaction
// copies a collection only when it changes it, so an untouched map keeps its identity and the rows
// of a list share one result instead of each summing every session.

const cache = new WeakMap<ReadonlyMap<ID, FocusSession>, Map<ID, number>>();

export function focusTotalsOf(state: Pick<DbData, "focusSessions">): ReadonlyMap<ID, number> {
	let totals = cache.get(state.focusSessions);
	if (totals === undefined) {
		totals = taskFocusTotals(state.focusSessions.values());
		cache.set(state.focusSessions, totals);
	}
	return totals;
}
