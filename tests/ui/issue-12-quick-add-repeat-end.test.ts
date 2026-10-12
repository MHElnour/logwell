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

	it("a typed end over a repeat picked by hand with its own end is a suggestion; using it replaces the end", async () => {
		const { h, m } = await model();
		m.setRepeat({ rule: { ...weekly, freq: "daily" }, end: { kind: "count", count: 5 } });
		m.setInput("Pills until Dec 1");
		const end = m.result.chips.find((c) => c.kind === "repeatEnd")!;
		expect(end).toMatchObject({ status: "suggestion", notice: "Replace repeat end?" });
		expect(m.result.title).toBe("Pills until Dec 1");
		expect(m.repeatValue()?.end).toEqual({ kind: "count", count: 5 });
		m.accept(end);
		expect(m.repeatValue()).toMatchObject({ rule: { freq: "daily" }, end: { kind: "date", date: "2026-12-01" } });
		expect(m.result.title).toBe("Pills");
		expect(await m.submit()).toBe("saved");
		expect([...h.app.store.state.tasks.values()][0]!.recurrence?.end).toEqual({ kind: "date", date: "2026-12-01" });
	});

	it("picking a repeat again after using a typed end forgets that use: the new pick's end wins", async () => {
		const { m } = await model();
		m.setRepeat({ rule: { ...weekly, freq: "daily" }, end: { kind: "count", count: 5 } });
		m.setInput("Pills until Dec 1");
		m.accept(m.result.chips.find((c) => c.kind === "repeatEnd")!);
		expect(m.repeatValue()?.end).toEqual({ kind: "date", date: "2026-12-01" });
		m.setRepeat({ rule: { ...weekly, freq: "daily" }, end: { kind: "count", count: 10 } });
		expect(m.repeatValue()?.end).toEqual({ kind: "count", count: 10 });
		expect(m.result.chips.find((c) => c.kind === "repeatEnd")).toMatchObject({ status: "suggestion", notice: "Replace repeat end?" });
	});

	it("picking a date again after using a typed date makes it a suggestion again", async () => {
		const { m } = await model();
		m.setInput("Call tomorrow");
		m.setDate("2026-10-20");
		const chip = m.result.chips.find((c) => c.kind === "scheduled")!;
		expect(chip.status).toBe("suggestion");
		m.accept(chip);
		expect(m.result.chips.find((c) => c.kind === "scheduled")?.status).toBe("applied");
		m.setDate("2026-10-21");
		expect(m.result.chips.find((c) => c.kind === "scheduled")).toMatchObject({ status: "suggestion", notice: "Replace date?" });
		expect(m.result.title).toBe("Call tomorrow");
	});

	it("a cleared date in a view with a preset counts from today, as the save does", async () => {
		for (const [input, end] of [
			["Stretch daily for 2 weeks", { kind: "date", date: "2026-10-20" }],
			["Stretch daily until Oct 15", { kind: "date", date: "2026-10-15" }],
		] as const) {
			const h = await appHarness();
			h.clock.set("2026-10-07T08:00:00.000Z");
			const m = new QuickAddModel(
				{ app: h.app, preset: { date: "2026-10-20" }, locale: () => "en", resolveNote: () => [], onSaved: () => undefined, onError: (e) => { throw e; }, keepOpen: () => true, onClose: () => undefined },
				() => undefined,
			);
			m.setDate("");
			m.setInput(input);
			expect(m.repeatValue()?.end, input).toEqual(end);
			expect(await m.submit(), input).toBe("saved");
			expect([...h.app.store.state.tasks.values()][0]!.recurrence, input).toMatchObject({ anchor: "2026-10-07", end });
		}
	});

	it("a typed end before the first date of a repeat picked by hand is refused and blocks saving", async () => {
		const { h, m } = await model();
		m.setRepeat({ rule: { ...weekly, weekdays: ["FR"] }, end: { kind: "never" } });
		m.setInput("Gym until Oct 8");
		expect(m.result.chips.find((c) => c.kind === "repeatEnd")).toMatchObject({ status: "invalid", notice: "The repeat ends before its first date." });
		expect(await m.submit()).toBe("invalid");
		expect(h.app.store.state.tasks.size).toBe(0);
		m.setInput("Gym until Oct 9");
		expect(await m.submit()).toBe("saved");
		expect([...h.app.store.state.tasks.values()][0]!.recurrence?.end).toEqual({ kind: "date", date: "2026-10-09" });
	});

	it("a date picked by hand after choosing a typed date's hour wins: the chip is offered again and its text stays", async () => {
		const { h, m } = await model();
		m.setInput("Call tomorrow at 5");
		const chip = m.result.chips.find((c) => c.kind === "scheduled")!;
		m.setChipDate(chip, chip.alternatives![1]!.value!);
		expect(m.result.chips.find((c) => c.kind === "scheduled")?.status).toBe("applied");
		m.setDate("2026-10-20");
		expect(m.result.chips.find((c) => c.kind === "scheduled")).toMatchObject({ status: "choice", notice: "Replace date?" });
		expect(m.result.title).toBe("Call tomorrow at 5");
		expect(await m.submit()).toBe("saved");
		// The popover showed the chosen 17:00 when the date was picked, so the hand pick keeps that time.
		expect([...h.app.store.state.tasks.values()][0]).toMatchObject({ title: "Call tomorrow at 5", scheduled: { kind: "datetime", local: "2026-10-20T17:00" } });
	});

	it("a repeat picked by hand after choosing a typed repeat's hour wins: the chip is offered again and its text stays", async () => {
		const { h, m } = await model();
		m.setInput("Gym every monday at 7");
		const chip = m.result.chips.find((c) => c.kind === "recurrence")!;
		m.setChipRule(chip, chip.alternatives![0]!.rule!);
		expect(m.result.chips.find((c) => c.kind === "recurrence")?.status).toBe("applied");
		m.setRepeat({ rule: { ...weekly, freq: "daily" }, end: { kind: "never" } });
		expect(m.result.chips.find((c) => c.kind === "recurrence")).toMatchObject({ status: "choice", notice: "Replace repeat?" });
		expect(m.result.title).toBe("Gym every monday at 7");
		expect(m.repeatValue()?.rule.freq).toBe("daily");
		expect(await m.submit()).toBe("saved");
		const task = [...h.app.store.state.tasks.values()][0]!;
		expect(task.title).toBe("Gym every monday at 7");
		expect(task.recurrence?.versions[0]?.rule).toMatchObject({ freq: "daily", time: null });
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
