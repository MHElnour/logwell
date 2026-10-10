import { describe, expect, it } from "vitest";
import { matrixQuadrants } from "../../src/domain/matrix";
import { type QueryContext, matchesTaskDate } from "../../src/domain/queries";
import type { Task } from "../../src/domain/types";

// "Next 7 days" is today and the next six days in the filter, in task blocks and in the matrix.

const ctx: QueryContext = { today: "2026-10-14", zone: "Europe/Berlin", upcomingDays: 7, weekStart: "MO" };

function task(id: string, date: string): Task {
	return {
		id,
		title: id,
		descriptionNote: null,
		categoryId: "inbox",
		tagKeys: [],
		parentId: null,
		sectionId: null,
		scheduled: { kind: "date", date },
		deadline: null,
		plannedDurationMin: null,
		urgent: false,
		important: false,
		priority: 0,
		status: "open",
		completedAt: null,
		recurrence: null,
		sortKey: id,
		createdAt: "2026-09-01T09:00:00.000Z",
		modifiedAt: "2026-09-01T09:00:00.000Z",
	};
}

const tasks = [task("today", "2026-10-14"), task("d1", "2026-10-15"), task("d6", "2026-10-20"), task("d7", "2026-10-21")];
const groupOfTask = (id: string): string | undefined => {
	const q = matrixQuadrants(tasks, new Map(tasks.map((t) => [t.id, t])), ctx).neither;
	return q.find((g) => g.entries.some((e) => e.task.id === id))?.id;
};
const inFilter = (id: string) => matchesTaskDate(tasks.find((t) => t.id === id)!, { date: "next7", from: null, to: null }, ctx);

describe("Next 7 days means the same days everywhere (#40)", () => {
	it("today + 6 is in the matrix group and the filter", () => {
		expect(groupOfTask("d6")).toBe("next7");
		expect(inFilter("d6")).toBe(true);
	});
	it("today + 7 is in neither", () => {
		expect(groupOfTask("d7")).toBe("later");
		expect(inFilter("d7")).toBe(false);
	});
	it("today stays in the Today group and tomorrow starts Next 7 days", () => {
		expect(groupOfTask("today")).toBe("today");
		expect(groupOfTask("d1")).toBe("next7");
	});
});
