import { Component, type FunctionComponent, h } from "preact";
import type { ListEntry, QueryContext } from "../domain/queries";
import type { SubtaskCount } from "../domain/tasks";
import { sameDateSpec } from "../domain/time";
import type { Task } from "../domain/types";
import { notSyncedReason } from "../app/syncMarks";
import type { DbData } from "../persistence/schema";
import { focusTotalsOf } from "./focus/totals";

// Skipping the render of a row whose inputs did not change. A save re-renders the
// whole Tasks section, and at 50,000 tasks a one-row change would otherwise rebuild about 9,000 rows. The wrapper
// is a class only because Preact has no other place for `shouldComponentUpdate`; it draws no element, and
// the hooks of the inner component keep working (its own state still re-renders it).
//
// A row reads the store through `state` (its list, its tags, the focus totals), which is a new object on
// every change, so identity of `state` cannot be the test. The comparators below compare exactly the
// records a row reads. Records are immutable (a change is a new object), so identity is the right test.

/** `Inner`, skipped while `equal` says the new props change nothing it draws. */
export function memoComponent<P extends object>(Inner: FunctionComponent<P>, equal: (prev: P, next: P) => boolean): FunctionComponent<P> {
	class Memo extends Component<P> {
		override shouldComponentUpdate(next: P): boolean {
			return !equal(this.props, next);
		}
		override render(props: P) {
			return h(Inner, props);
		}
	}
	return Memo as unknown as FunctionComponent<P>;
}

/** The same row content: the task record, its place in the list and its effective schedule. */
export function sameEntry(a: ListEntry, b: ListEntry): boolean {
	return (
		a.task === b.task &&
		a.depth === b.depth &&
		a.parentTitle === b.parentTitle &&
		sameDateSpec(a.schedule, b.schedule) &&
		(a.occurrence === b.occurrence || (a.occurrence !== null && b.occurrence !== null && a.occurrence.date === b.occurrence.date))
	);
}

export function sameSubtasks(a: SubtaskCount | undefined, b: SubtaskCount | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined && a.total === b.total && a.done === b.done);
}

/** The day and zone a row's dates are shown in; the rest of the context is not read by a row. */
export function sameDay(a: QueryContext, b: QueryContext): boolean {
	return a === b || (a.today === b.today && a.zone === b.zone);
}

/** The records of `task`'s list and tags in both states are the same objects. */
export function sameLookups(prev: DbData, next: DbData, task: Task): boolean {
	if (prev.categories.get(task.categoryId) !== next.categories.get(task.categoryId)) return false;
	for (const key of task.tagKeys) if (prev.tags.get(key) !== next.tags.get(key)) return false;
	return true;
}

/** The focused time of `task` is the same in both states. */
export function sameFocusTotal(prev: DbData, next: DbData, task: Task): boolean {
	return prev === next || focusTotalsOf(prev).get(task.id) === focusTotalsOf(next).get(task.id);
}

/**
 * What the "Not synced" chip shows is the same in both states. Compared by the answer, not by the links
 * themselves: a sync rewrites the links of a list (their `modifiedAt`), and that must not redraw every row. Most
 * changes do not touch the links at all, and then this costs one comparison.
 */
export function sameSyncMark(prev: DbData, next: DbData, task: Task): boolean {
	if (prev.syncLinks === next.syncLinks) return true;
	return notSyncedReason(prev.syncLinks, task) === notSyncedReason(next.syncLinks, task);
}
