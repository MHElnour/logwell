import { DomainError, invalidValue } from "../domain/errors";
import type { Clock } from "../domain/ports";
import {
	completionPlan,
	explicitRule,
	indexOccurrenceRecords,
	currentOccurrence,
	effectiveSchedule,
	isSeriesEnded,
	normalizeRepeatRule,
	occurrenceRecordId,
	repeatEndProblem,
	repeatRuleProblem,
	ruleAt,
	startRecurrence,
} from "../domain/recurrence";
import { isActiveSeries, subtasksOf } from "../domain/tasks";
import { isValidLocalDate, todayIn } from "../domain/time";
import type { ID, LocalDate, OccurrenceRecord, Recurrence, RepeatEnd, RepeatRule, RepeatVersion, Task, WeekStart } from "../domain/types";
import type { SettingsPort } from "./ports";
import type { AppStore } from "./store";
import type { Tx } from "./tx";
import { recordsOfTask, requireTask } from "./txReads";
import type { WriteResult } from "./writes";

// Repeating tasks. The only writer of occurrence records and,
// with TaskService's create, schedule edit, reopen and duplicate, of `Task.recurrence`. Every method is
// one store.run under the label it returns, so the Undo notice carries the exact store label.

export const COMPLETE_OCCURRENCE_LABEL = "Complete occurrence";
export const SKIP_OCCURRENCE_LABEL = "Skip occurrence";
export const REOPEN_OCCURRENCE_LABEL = "Reopen occurrence";
export const EDIT_REPEAT_LABEL = "Edit repeat";
export const STOP_REPEATING_LABEL = "Stop repeating";
/** The maintenance sweep's label (not undoable, like the Trash purge). */
export const END_REPEAT_LABEL = "End repeat";

export interface RecurrenceResult extends WriteResult {
	/** The occurrence this write resolved (complete: the done one; skip) or reopened; null otherwise. */
	date: LocalDate | null;
	/** complete: the past occurrences skipped automatically by the catch-up. */
	autoSkipped: number;
	/** The series ended with this write (its end reached, or Stop repeating). */
	seriesEnded: boolean;
	/** setRepeat: the task's deadline was cleared, since a repeating task has none. */
	deadlineCleared: boolean;
}

/** A repeating task whose repeat still runs (`isActiveSeries`). */
function requireActiveSeries(tx: Tx, id: ID): Task & { recurrence: Recurrence } {
	const task = requireTask(tx, id);
	if (task.recurrence === null) invalidValue("This task does not repeat.");
	if (!isActiveSeries(task)) invalidValue("This repeat has ended.");
	return task;
}

/**
 * Throws InvalidValue when `end` cannot be stored (repeatEndProblem); returns its stored form. `kept`, the end already
 * stored, passes unchanged: a count above 999 from an older file is not refused on the next edit.
 */
export function requireRepeatEnd(end: RepeatEnd, kept?: RepeatEnd): RepeatEnd {
	const stored: RepeatEnd = end.kind === "date" ? { kind: "date", date: end.date } : end.kind === "count" ? { kind: "count", count: end.count } : { kind: "never" };
	if (kept !== undefined && sameValue(stored, kept)) return stored;
	const problem = repeatEndProblem(end);
	if (problem !== null) invalidValue(problem);
	return stored;
}

/**
 * Throws InvalidValue when an end date leaves `series` no occurrence (repeatEndProblem): the sweep would end it at
 * once. A count is checked by requireRepeatEnd.
 */
export function requireEndInSeries(end: RepeatEnd, series: Pick<Recurrence, "anchor" | "versions">, weekStart: WeekStart): void {
	if (end.kind !== "date") return;
	const problem = repeatEndProblem(end, series, weekStart);
	if (problem !== null) invalidValue(problem);
}

/**
 * Throws InvalidValue when the rule cannot be stored; returns its stored form. A weekly rule takes
 * `weekStart` (the setting) unless it carries its own.
 */
export function requireRepeatRule(rule: RepeatRule, weekStart: WeekStart): RepeatRule {
	const problem = repeatRuleProblem(rule);
	if (problem !== null) invalidValue(problem);
	return normalizeRepeatRule(rule, weekStart);
}

function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export class RecurrenceService {
	constructor(
		private readonly store: AppStore,
		private readonly settings: SettingsPort,
		private readonly clock: Clock = store.clock,
	) {}

	/** Today in the display zone. */
	today(): LocalDate {
		return todayIn(this.settings.zone(), this.clock);
	}

	private weekStart(): WeekStart {
		return this.settings.weekStart();
	}

	private result(label: string, patch: Partial<RecurrenceResult> = {}): RecurrenceResult {
		return { wrote: true, label, date: null, autoSkipped: 0, seriesEnded: false, deadlineCleared: false, ...patch };
	}

	/** A new occurrence brings the subtasks back unchecked, in the same write. */
	private reopenSubtasks(tx: Tx, taskId: ID): void {
		for (const sub of subtasksOf(tx.all("tasks"), taskId)) {
			if (sub.status === "open") continue;
			tx.put("tasks", { ...sub, status: "open", completedAt: null, modifiedAt: tx.now });
		}
	}

	/** Ends the series now: `endedAt` and the task completed. */
	private endSeries(tx: Tx, task: Task & { recurrence: Recurrence }): void {
		tx.put("tasks", {
			...task,
			recurrence: { ...task.recurrence, endedAt: tx.now },
			status: "completed",
			completedAt: tx.now,
			modifiedAt: tx.now,
		});
	}

	/** Ends the series when the records just written reached its end. */
	private endIfReached(tx: Tx, task: Task & { recurrence: Recurrence }): boolean {
		if (!isSeriesEnded(task.recurrence, recordsOfTask(tx, task.id), this.weekStart())) return false;
		this.endSeries(tx, task);
		return true;
	}

	private putRecord(tx: Tx, taskId: ID, date: LocalDate, status: OccurrenceRecord["status"], auto: boolean, completedOn: LocalDate | null): void {
		tx.put("occurrenceRecords", { taskId, occurrenceDate: date, status, resolvedAt: tx.now, auto, completedOn });
	}

	/**
	 * The body of "Complete occurrence", for TaskService.complete to share. In fixed mode an
	 * overdue series has its earliest unresolved occurrence done and every other one before today skipped
	 * automatically (up to a count end); otherwise the current occurrence is done. Subtasks reopen.
	 */
	completeIn(tx: Tx, taskId: ID): RecurrenceResult {
		const task = requireActiveSeries(tx, taskId);
		const today = this.today();
		const plan = completionPlan(task, recordsOfTask(tx, taskId), today, this.weekStart());
		if (plan === null) {
			// The end was reached elsewhere (a synced record, an end date passed): record it now.
			this.endSeries(tx, task);
			return this.result(COMPLETE_OCCURRENCE_LABEL, { seriesEnded: true });
		}
		this.putRecord(tx, taskId, plan.done, "done", false, today);
		for (const d of plan.autoSkipped) this.putRecord(tx, taskId, d, "skipped", true, null);
		this.reopenSubtasks(tx, taskId);
		const seriesEnded = this.endIfReached(tx, task);
		return this.result(COMPLETE_OCCURRENCE_LABEL, { date: plan.done, autoSkipped: plan.autoSkipped.length, seriesEnded });
	}

	/** The current occurrence is done; an overdue fixed series skips its other past dates. */
	complete(taskId: ID): Promise<RecurrenceResult> {
		return this.store.run(COMPLETE_OCCURRENCE_LABEL, (tx) => this.completeIn(tx, taskId));
	}

	/**
	 * The current occurrence is skipped (auto false) and the series advances; after completion
	 * counts on from the skip day. Subtasks reopen for the next occurrence.
	 */
	skip(taskId: ID): Promise<RecurrenceResult> {
		return this.store.run(SKIP_OCCURRENCE_LABEL, (tx) => {
			const task = requireActiveSeries(tx, taskId);
			const date = currentOccurrence(task, recordsOfTask(tx, taskId), this.today(), this.weekStart());
			if (date === null) {
				this.endSeries(tx, task);
				return this.result(SKIP_OCCURRENCE_LABEL, { seriesEnded: true });
			}
			// A manual skip keeps the day it was skipped; after completion counts from it.
			this.putRecord(tx, taskId, date, "skipped", false, this.today());
			this.reopenSubtasks(tx, taskId);
			const seriesEnded = this.endIfReached(tx, task);
			return this.result(SKIP_OCCURRENCE_LABEL, { date, seriesEnded });
		});
	}

	/**
	 * Removes the record of `date`; that date is unresolved again and may become the current overdue
	 * occurrence. A series that had ended because its end was reached (count or date) opens again when
	 * the removal makes room; one stopped with "Stop repeating" stays stopped.
	 */
	reopen(taskId: ID, date: LocalDate): Promise<RecurrenceResult> {
		return this.store.run(REOPEN_OCCURRENCE_LABEL, (tx) => {
			const task = requireTask(tx, taskId);
			const id = occurrenceRecordId(taskId, date);
			const record = tx.get("occurrenceRecords", id);
			if (record === undefined) throw new DomainError("NotFound", "That occurrence is not done or skipped.");
			const rec = task.recurrence;
			// A record before the series' start that no longer counts (a fixed series never generates the
			// date; after completion ignores records resolved before a move) is history: reopening it would
			// only delete it. An after-completion record done early before the anchor still counts.
			if (rec !== null && date < rec.anchor) {
				const fixed = !rec.versions[0]!.rule.afterCompletion;
				const beforeMove = rec.anchoredAt !== undefined && record.resolvedAt <= rec.anchoredAt;
				if (fixed || beforeMove) invalidValue("That occurrence is before the series' start date.");
			}
			const ws = this.weekStart();
			const exhausted = rec !== null && rec.endedAt !== null && isSeriesEnded({ ...rec, endedAt: null }, recordsOfTask(tx, taskId), ws);
			tx.remove("occurrenceRecords", id);
			if (rec !== null && exhausted && !isSeriesEnded({ ...rec, endedAt: null }, recordsOfTask(tx, taskId), ws)) {
				tx.put("tasks", { ...task, recurrence: { ...rec, endedAt: null }, status: "open", completedAt: null, modifiedAt: tx.now });
			}
			return this.result(REOPEN_OCCURRENCE_LABEL, { date });
		});
	}

	/**
	 * On a task that does not repeat, `rule` makes it repeat: the anchor is its
	 * scheduled date, else `from`, else today; `scheduled` becomes null and a deadline is cleared in the
	 * same write. On a repeating task, `rule` adds a version from `from` (default today, never before the
	 * anchor): a version on the same date is replaced and later ones are dropped, past records stay.
	 * `end` replaces the end when given; an ended series opens again unless its end is still reached.
	 * `rule` null turns a repeating task into a plain one scheduled at its current occurrence (records kept).
	 * A subtask cannot repeat.
	 */
	setRepeat(taskId: ID, rule: RepeatRule | null, from?: LocalDate, end?: RepeatEnd): Promise<RecurrenceResult> {
		return this.store.run(EDIT_REPEAT_LABEL, (tx) => {
			const task = requireTask(tx, taskId);
			if (from !== undefined && !isValidLocalDate(from)) invalidValue("The start date is not valid.");
			const rec = task.recurrence;
			const today = this.today();
			const requested = from ?? today;
			const eff = rec === null || requested > rec.anchor ? requested : rec.anchor;
			// An edited weekly rule keeps the week start of the rule it replaces (the editor does not
			// carry it), so "Done" with no change after a settings change moves nothing; a new series takes
			// the setting.
			const weekStart = rule?.weekStart ?? (rec === null ? undefined : ruleAt(rec, eff).weekStart) ?? this.weekStart();
			const stored = rule === null ? null : requireRepeatRule(rule, weekStart);
			const storedEnd = end === undefined ? undefined : requireRepeatEnd(end, rec?.end);
			if (stored !== null && task.parentId !== null) invalidValue("A subtask cannot repeat.");
			if (rec === null) {
				if (stored === null) return this.result(EDIT_REPEAT_LABEL, { wrote: false });
				const started = startRecurrence(task.scheduled, stored, storedEnd, from ?? today, this.settings.zone(), this.weekStart()).recurrence;
				requireEndInSeries(started.end, started, this.weekStart());
				// Records from an earlier time the task repeated are history: after completion starts afresh
				// (anchoredAt) and a count end counts from now (countFrom).
				const recurrence = recordsOfTask(tx, taskId).length > 0 ? { ...started, anchoredAt: tx.now, countFrom: tx.now } : started;
				tx.put("tasks", {
					...task,
					recurrence,
					scheduled: null,
					deadline: null,
					status: "open",
					completedAt: null,
					modifiedAt: tx.now,
				});
				return this.result(EDIT_REPEAT_LABEL, { deadlineCleared: task.deadline !== null });
			}
			const records = recordsOfTask(tx, taskId);
			if (stored === null) {
				const ctx = { today, zone: this.settings.zone(), upcomingDays: 0, weekStart: this.weekStart() };
				tx.put("tasks", { ...task, recurrence: null, scheduled: effectiveSchedule(task, records, ctx), modifiedAt: tx.now });
				return this.result(EDIT_REPEAT_LABEL);
			}
			// The rule in force on `eff` compared in explicit form ("the anchor's weekday" spelled out, the
			// week start taken from it when the edit has none), so the picker's explicit copy of an implicit
			// rule is no change: no new version, and an end-only edit changes only the end.
			// An edit back to the rule before `eff` (A → B → A on one day) drops the version on `eff`.
			const sameRule = (other: RepeatRule): boolean => {
				const asEdited = rule?.weekStart === undefined ? { ...stored, weekStart: other.weekStart } : stored;
				return sameValue(normalizeRepeatRule(explicitRule(other, rec.anchor)), normalizeRepeatRule(explicitRule(asEdited, rec.anchor)));
			};
			const before = rec.versions.filter((v) => v.effectiveFrom < eff);
			const previous = before[before.length - 1];
			let versions: RepeatVersion[];
			if (sameRule(ruleAt(rec, eff))) versions = rec.versions.filter((v) => v.effectiveFrom <= eff);
			else if (previous !== undefined && sameRule(previous.rule)) versions = before;
			else versions = [...before, { effectiveFrom: eff, rule: stored }];
			// The end (new or kept) must leave the series a first date under the new rule; one its records reached ends it below.
			requireEndInSeries(storedEnd ?? rec.end, { anchor: rec.anchor, versions }, this.weekStart());
			let next: Recurrence = { ...rec, versions, end: storedEnd ?? rec.end, endedAt: null };
			const ended = isSeriesEnded(next, records, this.weekStart());
			if (ended) next = { ...next, endedAt: rec.endedAt ?? tx.now };
			if (sameValue(next, rec) && (ended || task.status === "open")) return this.result(EDIT_REPEAT_LABEL, { wrote: false });
			tx.put("tasks", {
				...task,
				recurrence: next,
				status: ended ? "completed" : "open",
				completedAt: ended ? (task.completedAt ?? tx.now) : null,
				modifiedAt: tx.now,
			});
			return this.result(EDIT_REPEAT_LABEL, { seriesEnded: ended && rec.endedAt === null });
		});
	}

	/** Open repeating tasks whose series the engine sees as ended (`endedAt` still null). */
	private exhausted(tasks: Iterable<Task>, records: ReadonlyMap<string, OccurrenceRecord>): (Task & { recurrence: Recurrence })[] {
		const index = indexOccurrenceRecords(records);
		const ws = this.weekStart();
		const out: (Task & { recurrence: Recurrence })[] = [];
		for (const t of tasks) {
			if (isActiveSeries(t) && isSeriesEnded(t.recurrence, index.get(t.id) ?? [], ws)) out.push(t);
		}
		return out;
	}

	/**
	 * Maintenance (on open and hourly, with the Trash purge): ends every open series that has no occurrence
	 * left, as its last write would have (`endedAt`, completed): all dates up to `end.date` resolved, a count
	 * reached by synced or imported records, or a series moved past its end date. A last occurrence still
	 * unresolved keeps the series open (overdue), so it can be completed. One run, not undoable; nothing is
	 * written when nothing is exhausted. Returns how many series it ended.
	 */
	endExhaustedSeries(): Promise<number> {
		const state = this.store.state;
		if (this.store.readOnlyState !== null || this.exhausted(state.tasks.values(), state.occurrenceRecords).length === 0) return Promise.resolve(0);
		return this.store.run(
			END_REPEAT_LABEL,
			(tx) => {
				const ended = this.exhausted(tx.all("tasks"), tx.map("occurrenceRecords"));
				for (const t of ended) this.endSeries(tx, t);
				return ended.length;
			},
			{ undoable: false },
		);
	}

	/** Ends the series now: the task is completed with its history kept. */
	stop(taskId: ID): Promise<RecurrenceResult> {
		return this.store.run(STOP_REPEATING_LABEL, (tx) => {
			const task = requireTask(tx, taskId);
			if (task.recurrence === null) invalidValue("This task does not repeat.");
			if (task.recurrence.endedAt !== null) return this.result(STOP_REPEATING_LABEL, { wrote: false });
			this.endSeries(tx, task as Task & { recurrence: Recurrence });
			return this.result(STOP_REPEATING_LABEL, { seriesEnded: true });
		});
	}
}
