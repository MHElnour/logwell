import { describe, expect, it } from "vitest";
import type { Checkin, Habit, OccurrenceRecord, Task } from "../../src/domain/types";
import { readRecord } from "../../src/persistence/validate";
import { done, repeating, rule, series } from "../domain/recurrence-fixtures";

// Spec "Data and storage" rule 8: every real day in years 0000 to 9999 loads. Before the fix a
// repeat, end date, occurrence record, habit version or check-in in years 0000 to 0099 was
// removed on load.

const AT = "0050-01-01T09:00:00.000Z";

describe("records dated in years 0000 to 0099 load unchanged (#15)", () => {
	it("keeps a repeat anchored on 0050-01-01 with an end date and a version", () => {
		const task = repeating(series("0050-01-01", [["0050-01-01", rule()], ["0050-03-01", rule({ interval: 2 })]], { kind: "date", date: "0050-12-31" }));
		const issues: string[] = [];
		const read = readRecord("tasks", JSON.parse(JSON.stringify(task)), task.id, issues) as Task;
		expect(issues).toEqual([]);
		expect(read.recurrence).toEqual(task.recurrence);
	});

	it("keeps an occurrence record dated 0050-01-02", () => {
		const record: OccurrenceRecord = done("0050-01-02");
		const issues: string[] = [];
		expect(readRecord("occurrenceRecords", { ...record }, "t1:0050-01-02", issues)).toEqual(record);
		expect(issues).toEqual([]);
	});

	it("keeps a habit version and a check-in in year 0050", () => {
		const habit: Habit = {
			id: "h-1",
			name: "Read",
			icon: null,
			color: null,
			timeOfDay: "anytime",
			reminder: null,
			archivedAt: null,
			sortKey: "a0",
			createdAt: AT,
			modifiedAt: AT,
			versions: [{ effectiveFrom: "0050-01-01", goal: { type: "binary", target: 1, unit: null, period: "day" }, schedule: { kind: "daily" }, weekStart: "MO" }],
		};
		const checkin: Checkin = { id: "c-1", habitId: "h-1", date: "0050-01-01", value: 1, note: null, createdAt: AT, modifiedAt: AT, deletedAt: null };
		const issues: string[] = [];
		expect(readRecord("habits", JSON.parse(JSON.stringify(habit)), "h-1", issues)).toEqual(habit);
		expect(readRecord("checkins", { ...checkin }, "c-1", issues)).toEqual(checkin);
		expect(issues).toEqual([]);
	});
});
