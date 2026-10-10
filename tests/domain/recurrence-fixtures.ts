import type { OccurrenceRecord, Recurrence, RepeatEnd, RepeatRule, Task } from "../../src/domain/types";

export const rule = (patch: Partial<RepeatRule> = {}): RepeatRule => ({
	freq: "daily",
	interval: 1,
	weekdays: null,
	monthly: null,
	afterCompletion: false,
	time: null,
	tz: null,
	...patch,
});

/** A series from `anchor`; `rules` is one rule (in force from the anchor) or [effectiveFrom, rule] pairs. */
export function series(
	anchor: string,
	rules: RepeatRule | [string, RepeatRule][],
	end: RepeatEnd = { kind: "never" },
	endedAt: string | null = null,
): Recurrence {
	const versions = Array.isArray(rules) ? rules.map(([effectiveFrom, r]) => ({ effectiveFrom, rule: r })) : [{ effectiveFrom: anchor, rule: rules }];
	return { anchor, versions, end, endedAt };
}

export function repeating(recurrence: Recurrence | null, patch: Partial<Task> = {}): Task {
	return {
		id: "t1",
		title: "Gym",
		descriptionNote: null,
		categoryId: "inbox",
		tagKeys: [],
		parentId: null,
		sectionId: null,
		scheduled: null,
		deadline: null,
		plannedDurationMin: null,
		urgent: false,
		important: false,
		priority: 0,
		status: recurrence?.endedAt ? "completed" : "open",
		completedAt: recurrence?.endedAt ?? null,
		recurrence,
		sortKey: "V",
		createdAt: "2026-09-01T09:00:00.000Z",
		modifiedAt: "2026-09-01T09:00:00.000Z",
		...patch,
	};
}

export function done(date: string, completedOn: string = date, taskId = "t1"): OccurrenceRecord {
	return { taskId, occurrenceDate: date, status: "done", resolvedAt: `${completedOn}T09:00:00.000Z`, auto: false, completedOn };
}

export function skipped(date: string, auto = false, taskId = "t1"): OccurrenceRecord {
	return { taskId, occurrenceDate: date, status: "skipped", resolvedAt: `${date}T09:00:00.000Z`, auto, completedOn: null };
}

/** Every date from `from` to `to`, inclusive. */
export function dateRange(from: string, to: string): string[] {
	const out: string[] = [];
	for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
		out.push(new Date(t).toISOString().slice(0, 10));
	}
	return out;
}
