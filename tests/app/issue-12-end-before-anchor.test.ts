import { describe, expect, it } from "vitest";
import { isDomainError } from "../../src/domain/errors";
import { repeatEndProblem } from "../../src/domain/recurrence";
import type { Recurrence, RepeatRule } from "../../src/domain/types";
import { rule } from "../domain/recurrence-fixtures";
import { type AppHarness, appHarness } from "./harness";

// Repeating tasks rule 19 (#12): an end before the start is refused. A series whose end comes before its first
// occurrence would be ended (completed, without Undo) by the hourly sweep right after it is written, so every writer
// refuses it: Quick Add's create, the picker's setRepeat, and the picker itself. Europe/Berlin; 2026-10-05 is a Monday.

const NOW = "2026-10-05T10:00:00.000Z";
const ENDS_BEFORE = "The repeat ends before its first date.";
const friday: RepeatRule = rule({ freq: "weekly", weekdays: ["FR"] });

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

const series = (anchor: string, r: RepeatRule): Pick<Recurrence, "anchor" | "versions"> => ({ anchor, versions: [{ effectiveFrom: anchor, rule: r }] });

describe("repeatEndProblem: one check for the picker, Quick Add and the services", () => {
	it("accepts never, a count of 1 to 999 and a date on or after the first occurrence", () => {
		expect(repeatEndProblem({ kind: "never" }, series("2026-10-05", rule()))).toBeNull();
		expect(repeatEndProblem({ kind: "count", count: 1 })).toBeNull();
		expect(repeatEndProblem({ kind: "count", count: 999 })).toBeNull();
		expect(repeatEndProblem({ kind: "date", date: "2026-10-05" }, series("2026-10-05", rule()))).toBeNull();
		expect(repeatEndProblem({ kind: "date", date: "2026-10-09" }, series("2026-10-05", friday))).toBeNull();
		expect(repeatEndProblem({ kind: "date", date: "2026-12-01" })).toBeNull();
	});

	it("refuses a count out of range, a date that is not one, a date before the anchor or before the first occurrence", () => {
		expect(repeatEndProblem({ kind: "count", count: 0 })).toBe("End after 1 to 999 times.");
		expect(repeatEndProblem({ kind: "count", count: 1.5 })).toBe("End after 1 to 999 times.");
		expect(repeatEndProblem({ kind: "count", count: 1000 })).toBe("End after 1 to 999 times.");
		expect(repeatEndProblem({ kind: "date", date: "2026-02-30" })).toBe("The end date is not valid.");
		expect(repeatEndProblem({ kind: "date", date: "2026-10-04" }, series("2026-10-05", rule()))).toBe(ENDS_BEFORE);
		// Every Friday from Monday Oct 5, ending Wednesday Oct 7: no occurrence at all.
		expect(repeatEndProblem({ kind: "date", date: "2026-10-07" }, series("2026-10-05", friday))).toBe(ENDS_BEFORE);
		// Every 15th from Oct 5, ending Oct 14.
		expect(repeatEndProblem({ kind: "date", date: "2026-10-14" }, series("2026-10-05", rule({ freq: "monthly", monthly: { kind: "day", day: 15 } })))).toBe(ENDS_BEFORE);
	});
});

describe("TaskService.create refuses a repeat that ends before its first date", () => {
	it("an end date before the typed date writes nothing", async () => {
		const h = await setup();
		const before = h.app.store.state.tasks.size;
		await refused(h.app.tasks.create({ title: "Pills", scheduled: { kind: "date", date: "2026-10-20" }, repeat: { rule: rule(), end: { kind: "date", date: "2026-10-19" } } }), ENDS_BEFORE);
		expect(h.app.store.state.tasks.size).toBe(before);
	});

	it("without a date the anchor is today: an end yesterday is refused, today is accepted and survives the sweep", async () => {
		const h = await setup();
		await refused(h.app.tasks.create({ title: "Pills", repeat: { rule: rule(), end: { kind: "date", date: "2026-10-04" } } }), ENDS_BEFORE);
		const { task } = await h.app.tasks.create({ title: "Pills", repeat: { rule: rule(), end: { kind: "date", date: "2026-10-05" } } });
		expect(task.recurrence).toMatchObject({ anchor: "2026-10-05", end: { kind: "date", date: "2026-10-05" }, endedAt: null });
		await h.app.recurrence.endExhaustedSeries();
		expect(h.app.store.state.tasks.get(task.id)?.status).toBe("open");
	});

	it("an end on or after the anchor but before the first occurrence is refused (every Friday until Wednesday)", async () => {
		const h = await setup();
		const before = h.app.store.state.tasks.size;
		await refused(h.app.tasks.create({ title: "Gym", repeat: { rule: friday, end: { kind: "date", date: "2026-10-07" } } }), ENDS_BEFORE);
		await refused(
			h.app.tasks.create({ title: "Pay", repeat: { rule: rule({ freq: "monthly", monthly: { kind: "day", day: 15 } }), end: { kind: "date", date: "2026-10-14" } } }),
			ENDS_BEFORE,
		);
		expect(h.app.store.state.tasks.size).toBe(before);
		await h.app.recurrence.endExhaustedSeries();
		expect([...h.app.store.state.tasks.values()].filter((t) => t.status === "completed")).toEqual([]);
	});

	it("a timed date anchors on its own wall date", async () => {
		const h = await setup();
		const scheduled = { kind: "datetime" as const, local: "2026-10-08T06:45", tz: "Europe/Berlin" };
		await refused(h.app.tasks.create({ title: "Run", scheduled, repeat: { rule: rule(), end: { kind: "date", date: "2026-10-07" } } }), ENDS_BEFORE);
		const { task } = await h.app.tasks.create({ title: "Run", scheduled, repeat: { rule: rule(), end: { kind: "date", date: "2026-10-08" } } });
		expect(task.recurrence?.anchor).toBe("2026-10-08");
	});
});

describe("RecurrenceService.setRepeat refuses a repeat that ends before its first date", () => {
	it("making a dated task repeat with an end before its date is refused; the task stays as it was and the sweep leaves it", async () => {
		const h = await setup();
		const { task } = await h.app.tasks.create({ title: "Plain", scheduled: { kind: "date", date: "2026-10-20" } });
		await refused(h.app.recurrence.setRepeat(task.id, rule(), undefined, { kind: "date", date: "2026-10-15" }), ENDS_BEFORE);
		expect(h.app.store.state.tasks.get(task.id)).toMatchObject({ recurrence: null, status: "open", scheduled: { kind: "date", date: "2026-10-20" } });
		await h.app.recurrence.endExhaustedSeries();
		expect(h.app.store.state.tasks.get(task.id)?.status).toBe("open");
	});

	it("making a task repeat every Friday until Wednesday is refused", async () => {
		const h = await setup();
		const { task } = await h.app.tasks.create({ title: "Gym", scheduled: { kind: "date", date: "2026-10-05" } });
		await refused(h.app.recurrence.setRepeat(task.id, friday, undefined, { kind: "date", date: "2026-10-07" }), ENDS_BEFORE);
		expect(h.app.store.state.tasks.get(task.id)?.recurrence).toBeNull();
	});

	it("a new end before an existing series' first occurrence is refused; one after it is kept", async () => {
		const h = await setup();
		const { task } = await h.app.tasks.create({ title: "Pills", scheduled: { kind: "date", date: "2026-10-05" }, repeat: { rule: rule() } });
		await refused(h.app.recurrence.setRepeat(task.id, rule(), undefined, { kind: "date", date: "2026-10-01" }), ENDS_BEFORE);
		expect(h.app.store.state.tasks.get(task.id)?.recurrence?.end).toEqual({ kind: "never" });
		await h.app.recurrence.setRepeat(task.id, rule(), undefined, { kind: "date", date: "2026-10-10" });
		expect(h.app.store.state.tasks.get(task.id)?.recurrence?.end).toEqual({ kind: "date", date: "2026-10-10" });
	});
});
