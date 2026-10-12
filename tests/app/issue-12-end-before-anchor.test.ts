import { describe, expect, it } from "vitest";
import { isDomainError } from "../../src/domain/errors";
import { repeatEndProblem } from "../../src/domain/recurrence";
import { rule } from "../domain/recurrence-fixtures";
import { type AppHarness, appHarness } from "./harness";

// Repeating tasks rule 19 (#12): an end before the start is refused. Quick Add creates a repeating task in one
// write; a typed end before the first date would let the hourly sweep end (complete) the task it just created.

const NOW = "2026-10-05T10:00:00.000Z";

async function setup(): Promise<AppHarness> {
	const h = await appHarness();
	h.clock.set(NOW);
	return h;
}

async function refused(p: Promise<unknown>, message: string): Promise<void> {
	try {
		await p;
	} catch (err) {
		expect(isDomainError(err, "InvalidValue")).toBe(true);
		expect((err as Error).message).toBe(message);
		return;
	}
	throw new Error("expected InvalidValue");
}

describe("repeatEndProblem: one check for the picker, Quick Add and the services", () => {
	it("accepts never, a count of 1 or more and a date on or after the anchor", () => {
		expect(repeatEndProblem({ kind: "never" }, "2026-10-05")).toBeNull();
		expect(repeatEndProblem({ kind: "count", count: 1 }, "2026-10-05")).toBeNull();
		expect(repeatEndProblem({ kind: "date", date: "2026-10-05" }, "2026-10-05")).toBeNull();
		expect(repeatEndProblem({ kind: "date", date: "2026-12-01" })).toBeNull();
	});

	it("refuses a count below 1, a date that is not one, and a date before the anchor", () => {
		expect(repeatEndProblem({ kind: "count", count: 0 })).toBe("End after 1 or more times.");
		expect(repeatEndProblem({ kind: "count", count: 1.5 })).toBe("End after 1 or more times.");
		expect(repeatEndProblem({ kind: "date", date: "2026-02-30" })).toBe("The end date is not valid.");
		expect(repeatEndProblem({ kind: "date", date: "2026-10-04" }, "2026-10-05")).toBe("The end date is before the first date.");
	});
});

describe("TaskService.create refuses a repeat end before the anchor", () => {
	it("an end date before the typed date writes nothing", async () => {
		const h = await setup();
		const before = h.app.store.state.tasks.size;
		await refused(
			h.app.tasks.create({ title: "Pills", scheduled: { kind: "date", date: "2026-10-20" }, repeat: { rule: rule(), end: { kind: "date", date: "2026-10-19" } } }),
			"The end date is before the first date.",
		);
		expect(h.app.store.state.tasks.size).toBe(before);
	});

	it("without a date the anchor is today: an end yesterday is refused, today is accepted", async () => {
		const h = await setup();
		await refused(h.app.tasks.create({ title: "Pills", repeat: { rule: rule(), end: { kind: "date", date: "2026-10-04" } } }), "The end date is before the first date.");
		const { task } = await h.app.tasks.create({ title: "Pills", repeat: { rule: rule(), end: { kind: "date", date: "2026-10-05" } } });
		expect(task.recurrence).toMatchObject({ anchor: "2026-10-05", end: { kind: "date", date: "2026-10-05" }, endedAt: null });
		expect(task.status).toBe("open");
	});

	it("a timed date anchors on its own wall date", async () => {
		const h = await setup();
		await refused(
			h.app.tasks.create({
				title: "Run",
				scheduled: { kind: "datetime", local: "2026-10-08T06:45", tz: "Europe/Berlin" },
				repeat: { rule: rule(), end: { kind: "date", date: "2026-10-07" } },
			}),
			"The end date is before the first date.",
		);
		const { task } = await h.app.tasks.create({
			title: "Run",
			scheduled: { kind: "datetime", local: "2026-10-08T06:45", tz: "Europe/Berlin" },
			repeat: { rule: rule(), end: { kind: "date", date: "2026-10-08" } },
		});
		expect(task.recurrence?.anchor).toBe("2026-10-08");
	});
});
