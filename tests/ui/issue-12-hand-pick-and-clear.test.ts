import { describe, expect, it, vi } from "vitest";
import { QuickAddModel } from "../../src/ui/quickadd/QuickAddModel";
import { manualPills } from "../../src/ui/quickadd/manualPills";
import { draftOf, draftProblem } from "../../src/ui/repeat";
import { appHarness } from "../app/harness";

// Tasks and Quick Add rules 23 and 37, Repeating tasks rule 19 (#12): a value picked by hand wins and never leaves
// saving blocked; the date popover's Clear dismisses every typed repeat end; the pill of a repeat picked by hand shows
// the end that will be saved; the picker keeps a stored end it did not change. Europe/Berlin, Wednesday 2026-10-07.

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

const friday = { freq: "weekly" as const, interval: 1, weekdays: ["FR" as const], monthly: null, afterCompletion: false, time: null, tz: null };

describe("a hand-picked date over a typed yearly start (#12)", () => {
	it("saves at once on the picked date; the typed start is a 'Replace date?' offer, not a block", async () => {
		const { h, m } = await model();
		m.setInput("Birthday every year on May 5 at 7");
		m.setDate("2026-11-01");
		expect(m.result.blocking).toEqual([]);
		expect(m.result.chips.find((c) => c.kind === "scheduled")).toMatchObject({ status: "choice", notice: "Replace date?" });
		expect(await m.submit()).toBe("saved");
		await vi.waitFor(() => expect([...h.app.store.state.tasks.values()]).toHaveLength(1));
		const task = [...h.app.store.state.tasks.values()][0]!;
		expect(task.recurrence).toMatchObject({ anchor: "2026-11-01", versions: [{ rule: { freq: "yearly" } }] });
		// The typed start stays an offer, so its text stays in the title (Tasks and Quick Add rule 23).
		expect(task.title).toBe("Birthday May 5 at 7");
	});
});

describe("Clear in the date popover (#12)", () => {
	it("dismisses an invalid repeat end too, so the date never comes back as a deadline", async () => {
		const { m } = await model();
		m.setInput("Gym every friday until Oct 8");
		expect(m.result.chips.map((c) => `${c.kind}/${c.status}`)).toEqual(["recurrence/applied", "repeatEnd/invalid"]);
		m.clearDateFields();
		expect(m.result.chips).toEqual([]);
		expect(m.result.fields.deadline).toBeUndefined();
		expect(m.result.blocking).toEqual([]);
		expect(m.result.title).toBe("Gym every friday until Oct 8");
	});

	it("dismisses an end that waits for the repeat's time", async () => {
		const { m } = await model();
		m.setInput("Gym every monday at 9 until Dec 1");
		expect(m.result.chips.find((c) => c.kind === "repeatEnd")?.status).toBe("suggestion");
		m.clearDateFields();
		expect(m.result.chips.filter((c) => c.kind === "repeatEnd" || c.kind === "deadline")).toEqual([]);
	});
});

describe("the pill of a repeat picked by hand (#12)", () => {
	it("shows the typed end that will be saved, not only the picked value", async () => {
		const { m } = await model();
		m.setRepeat({ rule: friday, end: { kind: "never" } });
		m.setInput("Gym until Dec 1");
		expect(m.repeatValue()).toEqual({ rule: friday, end: { kind: "date", date: "2026-12-01" } });
		const pill = manualPills(m).find((p) => p.kind === "recurrence")!;
		expect(pill.label).toBe("Repeat: every Fri · ends Dec 1");
	});
});

describe("the repeat picker and a stored end (#12)", () => {
	it("keeps a stored count above 999 while it is unchanged, as the services do", () => {
		const stored = { rule: friday, end: { kind: "count" as const, count: 1500 } };
		const d = draftOf(stored, "2026-10-07");
		expect(draftProblem(d, "2026-10-07", "MO", stored.end)).toBeNull();
		expect(draftProblem({ ...d, endCount: "1501" }, "2026-10-07", "MO", stored.end)).toBe("End after 1 to 999 times.");
		expect(draftProblem(d, "2026-10-07", "MO")).toBe("End after 1 to 999 times.");
	});
});

describe("choosing a typed repeat's hour (#12)", () => {
	it("never saves by itself: a repeat's hour choice does not block saving, so Enter cannot open it", async () => {
		const { h, m } = await model();
		m.setInput("Gym every monday at 9");
		const chip = m.result.chips.find((c) => c.kind === "recurrence")!;
		expect(m.result.blocking).toEqual([]);
		expect(await m.submit()).toBe("saved");
		await vi.waitFor(() => expect([...h.app.store.state.tasks.values()]).toHaveLength(1));
		expect([...h.app.store.state.tasks.values()][0]!.recurrence).toBeNull();
		m.setInput("Gym every monday at 9");
		m.activate(m.result.chips.find((c) => c.id === chip.id)!);
		m.setChipRule(m.result.chips[0]!, chip.alternatives![1]!.rule!);
		await Promise.resolve();
		expect([...h.app.store.state.tasks.values()]).toHaveLength(1);
		expect(m.repeatValue()?.rule.time).toBe("21:00");
	});
});
