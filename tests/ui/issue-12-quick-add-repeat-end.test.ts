import { describe, expect, it } from "vitest";
import { QuickAddModel } from "../../src/ui/quickadd/QuickAddModel";
import { draftOf, draftProblem } from "../../src/ui/repeat";
import { appHarness } from "../app/harness";

// Repeating tasks rule 19 (#12): a typed repeat end is saved with the repeat, follows it under a repeat picked by hand,
// and goes with the date popover's Clear. Europe/Berlin, Wednesday 2026-10-07.

async function model() {
	const h = await appHarness();
	h.clock.set("2026-10-07T08:00:00.000Z");
	const m = new QuickAddModel(
		{
			app: h.app,
			preset: {},
			locale: () => "en",
			resolveNote: () => [],
			onSaved: () => undefined,
			onError: (e) => {
				throw e;
			},
			keepOpen: () => true,
			onClose: () => undefined,
		},
		() => undefined,
	);
	return { h, m };
}

const weekly = { freq: "weekly" as const, interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null };

describe("Quick Add repeat end (#12)", () => {
	it("saves the typed end with the repeat", async () => {
		const { h, m } = await model();
		m.setInput("Pills every day until Dec 1");
		expect(m.repeatValue()?.end).toEqual({ kind: "date", date: "2026-12-01" });
		expect(await m.submit()).toBe("saved");
		const task = [...h.app.store.state.tasks.values()][0]!;
		expect(task.title).toBe("Pills");
		expect(task.recurrence).toMatchObject({ anchor: "2026-10-07", end: { kind: "date", date: "2026-12-01" } });
	});

	it("saves a count end", async () => {
		const { h, m } = await model();
		m.setInput("Pills every day for 5 times");
		expect(await m.submit()).toBe("saved");
		expect([...h.app.store.state.tasks.values()][0]!.recurrence?.end).toEqual({ kind: "count", count: 5 });
	});

	it("using the end chip under a repeat picked by hand brings back the typed repeat with its end", async () => {
		const { m } = await model();
		m.setInput("Pills every day until Dec 1");
		m.setRepeat({ rule: weekly, end: { kind: "never" } });
		expect(m.repeatValue()?.rule.freq).toBe("weekly");
		const end = m.result.chips.find((c) => c.kind === "repeatEnd")!;
		expect(end.status).toBe("suggestion");
		m.accept(end);
		expect(m.repeatValue()).toMatchObject({ rule: { freq: "daily" }, end: { kind: "date", date: "2026-12-01" } });
	});

	it("an invalid end blocks saving with the shared message", async () => {
		const { h, m } = await model();
		m.setInput("Gym every friday until Oct 8");
		expect(await m.submit()).toBe("invalid");
		expect(m.message).toBe("The repeat ends before its first date.");
		expect(h.app.store.state.tasks.size).toBe(0);
	});

	it("`for N …` counts from a date picked by hand", async () => {
		const { h, m } = await model();
		m.setDate("2026-10-20");
		m.setInput("Stretch daily for 2 weeks");
		expect(m.repeatValue()?.end).toEqual({ kind: "date", date: "2026-11-02" });
		expect(await m.submit()).toBe("saved");
		expect([...h.app.store.state.tasks.values()][0]!.recurrence).toMatchObject({ anchor: "2026-10-20", end: { kind: "date", date: "2026-11-02" } });
	});

	it("a typed end applies to a repeat picked by hand that has none", async () => {
		const { h, m } = await model();
		m.setRepeat({ rule: { ...weekly, freq: "daily" }, end: { kind: "never" } });
		m.setInput("Pills until Dec 1");
		expect(m.result.fields.deadline).toBeUndefined();
		expect(await m.submit()).toBe("saved");
		const task = [...h.app.store.state.tasks.values()][0]!;
		expect(task).toMatchObject({ title: "Pills", deadline: null, recurrence: { end: { kind: "date", date: "2026-12-01" } } });
	});

	it("the picker refuses an end before the first occurrence (a Monday task, weekly on Friday, ending Wednesday)", () => {
		const d = { ...draftOf(null, "2026-10-05"), freq: "weekly" as const, days: ["FR" as const], endKind: "date" as const, endDate: "2026-10-07" };
		expect(draftProblem(d, "2026-10-05", "MO")).toBe("The repeat ends before its first date.");
		expect(draftProblem({ ...d, endDate: "2026-10-09" }, "2026-10-05", "MO")).toBeNull();
	});

	it("Clear in the date popover keeps the end as text too", async () => {
		const { m } = await model();
		m.setInput("Pills every day until Dec 1");
		m.clearDateFields();
		expect(m.result.chips.filter((c) => c.status === "applied")).toEqual([]);
		expect(m.result.fields.deadline).toBeUndefined();
		expect(m.repeatValue()).toBeNull();
	});
});
