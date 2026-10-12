// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { RepeatRule } from "../../src/domain/types";
import { type M7Mount, click, lastNotice, mountM7, openDetails, q, settle, taskById } from "./m7-helpers";

// The details pane names a yearly rule from the series' first date (#12, Repeating tasks rule 10: a rule change
// keeps the anchor). A monthly series anchored Jan 15 whose current occurrence is Oct 15 (today is Oct 1) becomes
// "yearly on Jan 15", exactly as the engine schedules it, not "on Oct 15".

const ANCHOR = "2026-01-15";
const monthly: RepeatRule = { freq: "monthly", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null };

const mounted: M7Mount[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
});

async function monthlySeries(): Promise<{ m: M7Mount; id: string; pane: HTMLElement }> {
	const m = await mountM7();
	mounted.push(m);
	const { task } = await m.h.app.tasks.create({ title: "Pay rent", scheduled: { kind: "date", date: ANCHOR }, repeat: { rule: monthly } } as never);
	// Overdue since Jan 15: completing marks Jan 15 done and skips Feb to Sep, so the current occurrence is Oct 15.
	await m.h.app.recurrence.complete(task.id);
	await settle();
	const pane = await openDetails(m, "Pay rent");
	expect(q<HTMLInputElement>(pane, 'input[aria-label="Scheduled date"]').value).toBe("2026-10-15");
	return { m, id: task.id, pane };
}

const field = (pane: HTMLElement) => q(pane, ".cp-repeat-field");
const button = (pane: HTMLElement) => q<HTMLButtonElement>(field(pane), ".cp-repeat-button");

describe("Yearly on an existing series in the details pane (#12)", () => {
	it("the preset hint, the field and the notice name the series' Jan 15; the anchor stays", async () => {
		const { m, id, pane } = await monthlySeries();
		await click(button(pane));
		expect(q(field(pane), '[data-preset="yearly"] small').textContent).toBe("on Jan 15");
		// Other presets keep naming the current occurrence.
		expect(q(field(pane), '[data-preset="monthly"] small').textContent).toBe("on the 15th");
		expect(q(field(pane), '[data-preset="weekly"] small').textContent).toBe("on Thursday");
		await click(q(field(pane), '[data-preset="yearly"]'));
		const rec = taskById(m, id).recurrence!;
		expect(rec.anchor).toBe(ANCHOR);
		expect(rec.versions.at(-1)?.rule).toMatchObject({ freq: "yearly", interval: 1, weekdays: null, monthly: null });
		expect(lastNotice(m)?.message).toBe('"Pay rent" repeats yearly on Jan 15.');
		expect(button(pane).textContent).toBe("yearly on Jan 15");
	});

	it("Custom with the years unit: the summary and the notice name Jan 15", async () => {
		const { m, id, pane } = await monthlySeries();
		await click(button(pane));
		await click(q(field(pane), '[data-preset="custom"]'));
		const interval = q<HTMLInputElement>(field(pane), 'input[aria-label="Interval"]');
		interval.value = "2";
		interval.dispatchEvent(new Event("input", { bubbles: true }));
		const unit = q<HTMLSelectElement>(field(pane), 'select[aria-label="Unit"]');
		unit.value = "yearly";
		unit.dispatchEvent(new Event("change", { bubbles: true }));
		await settle();
		expect(q(field(pane), ".cp-repeat-summary").textContent).toBe("Every 2 years on Jan 15");
		await click(q(field(pane), ".cp-repeat-done"));
		const rec = taskById(m, id).recurrence!;
		expect(rec.anchor).toBe(ANCHOR);
		expect(rec.versions.at(-1)?.rule).toMatchObject({ freq: "yearly", interval: 2 });
		expect(lastNotice(m)?.message).toBe('"Pay rent" repeats every 2 years on Jan 15.');
		expect(button(pane).textContent).toBe("every 2 years on Jan 15");
	});
});
