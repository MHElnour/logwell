// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDIT_REPEAT_LABEL } from "../../src/app/RecurrenceService";
import { detailsDateText } from "../../src/ui/format";
import { DEADLINE_CLEARED_TEXT, requestRepeatEdit } from "../../src/ui/repeatActions";
import { type M7Mount, FRIDAY, click, lastNotice, mountM7, openDetails, q, settle, taskById, weeklyFriday } from "./m7-helpers";

// The details pane's Repeat field and its date chip.

const mounted: M7Mount[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
});
async function mount(): Promise<M7Mount> {
	const m = await mountM7();
	mounted.push(m);
	return m;
}

const create = async (m: M7Mount, title: string, extra: Record<string, unknown> = {}) =>
	(await m.h.app.tasks.create({ title, scheduled: { kind: "date", date: FRIDAY }, repeat: weeklyFriday, ...extra } as never)).task;
const field = (pane: HTMLElement) => q(pane, ".cp-repeat-field");
const button = (pane: HTMLElement) => q<HTMLButtonElement>(field(pane), ".cp-repeat-button");
const opt = (pane: HTMLElement, id: string) => q<HTMLButtonElement>(field(pane), `[data-preset="${id}"]`);
const labelOf = (pane: HTMLElement, text: string) => [...pane.querySelectorAll<HTMLElement>(".cp-field")].find((f) => f.textContent?.startsWith(text));

describe("the details date chip", () => {
	it("shows the current occurrence and the rule: Fri, Oct 9 · every Fri", async () => {
		const m = await mount();
		await create(m, "Weekly review");
		const pane = await openDetails(m, "Weekly review", false);
		expect(q(pane, ".cp-due-chip").textContent).toContain("Fri, Oct 9 · every Fri");
		expect(q(pane, ".cp-due-chip").getAttribute("aria-label")).toBe("Date and details: Fri, Oct 9 · every Fri");
	});

	it("keeps the plain text for a task that does not repeat", () => {
		expect(detailsDateText({ scheduled: { kind: "date", date: FRIDAY }, deadline: null, plannedDurationMin: null }, "Europe/Berlin", "2026-10-01")).toBe("Fri, Oct 9");
		expect(
			detailsDateText({ scheduled: null, deadline: null, plannedDurationMin: 30 }, "Europe/Berlin", "2026-10-01", {
				schedule: { kind: "date", date: FRIDAY },
				repeat: "every Fri",
			}),
		).toBe("Fri, Oct 9 · every Fri · 30m");
	});
});

describe("the Repeat field", () => {
	it("sits next to the Scheduled field with the rule on its button, and the Deadline field is gone", async () => {
		const m = await mount();
		await create(m, "Weekly review");
		const pane = await openDetails(m, "Weekly review");
		const labels = [...pane.querySelectorAll(".cp-details-fields > .cp-field")].map((f) => f.firstElementChild?.textContent);
		expect(labels.slice(0, 2)).toEqual(["Scheduled", "Repeat"]);
		expect(labels).not.toContain("Deadline");
		expect(button(pane).textContent).toBe("every Fri");
		// The Scheduled field shows the current occurrence and cannot be cleared.
		expect(q<HTMLInputElement>(pane, 'input[aria-label="Scheduled date"]').value).toBe(FRIDAY);
		expect(pane.querySelector('[aria-label="Clear scheduled"]')).toBeNull();
	});

	it("shows Never on a task that repeats nothing, with its Deadline field", async () => {
		const m = await mount();
		await m.h.app.tasks.create({ title: "Plain" });
		const pane = await openDetails(m, "Plain");
		expect(button(pane).textContent).toBe("Never");
		expect(labelOf(pane, "Deadline")).toBeDefined();
	});

	it("a subtask has no Repeat field (D10)", async () => {
		const m = await mount();
		const parent = await create(m, "Weekly review");
		await m.h.app.tasks.create({ title: "Inbox zero", parentId: parent.id });
		const pane = await openDetails(m, "Weekly review");
		await click(q(pane, ".cp-subtasks .cp-link-button"));
		const sub = q(m.root, ".cp-tasks .cp-details");
		expect(sub.querySelector(".cp-details-fields")).not.toBeNull();
		expect(sub.querySelector(".cp-repeat-field")).toBeNull();
	});

	it("round trip: a preset changes the rule, the Undo notice carries the label and the store undoes it", async () => {
		const m = await mount();
		const t = await create(m, "Weekly review");
		const pane = await openDetails(m, "Weekly review");
		await click(button(pane));
		await click(opt(pane, "daily"));
		expect(field(pane).querySelector(".cp-repeat-pop")).toBeNull();
		expect(taskById(m, t.id).recurrence?.versions.at(-1)?.rule).toMatchObject({ freq: "daily", interval: 1 });
		expect(button(pane).textContent).toBe("every day");
		expect(lastNotice(m)).toEqual({ message: '"Weekly review" repeats every day.', label: EDIT_REPEAT_LABEL });
		expect(lastNotice(m)?.label).toBe(m.h.app.store.undoLabel);
		await m.h.app.store.undo();
		await settle();
		expect(taskById(m, t.id).recurrence?.versions.at(-1)?.rule.freq).toBe("weekly");
	});

	it("Custom: weekly on Monday, Wednesday and Friday through the editor, with an end", async () => {
		const m = await mount();
		const t = await create(m, "Weekly review");
		const pane = await openDetails(m, "Weekly review");
		// Done with nothing changed is no edit: no new version (the stored rule carries a weekStart the editor does not build), no notice.
		const stored = JSON.stringify(taskById(m, t.id).recurrence);
		expect(taskById(m, t.id).recurrence?.versions.at(-1)?.rule.weekStart).toBeDefined();
		const setRepeat = vi.spyOn(m.h.app.recurrence, "setRepeat");
		await click(button(pane));
		await click(opt(pane, "custom"));
		await click(q(field(pane), ".cp-repeat-done"));
		expect(setRepeat).not.toHaveBeenCalled();
		expect(JSON.stringify(taskById(m, t.id).recurrence)).toBe(stored);
		expect(m.notices).toEqual([]);
		await click(button(pane));
		await click(opt(pane, "custom"));
		// Friday is already pressed: the series' own weekday is spelled out in the editor.
		for (const d of ["MO", "WE"]) await click(q(field(pane), `.cp-repeat-day[data-day="${d}"]`));
		await click(q(field(pane), '.cp-repeat-seg [data-end="count"]'));
		const times = q<HTMLInputElement>(field(pane), 'input[aria-label="Times"]');
		times.value = "8";
		times.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();
		await click(q(field(pane), ".cp-repeat-done"));
		const rec = taskById(m, t.id).recurrence!;
		expect(rec.versions.at(-1)?.rule.weekdays).toEqual(["MO", "WE", "FR"]);
		expect(rec.end).toEqual({ kind: "count", count: 8 });
		expect(lastNotice(m)?.message).toBe('"Weekly review" repeats every Mon, Wed, Fri.');
		expect(button(pane).textContent).toBe("every Mon, Wed, Fri · ends after 8 times");
	});

	it("Never stops it repeating: a plain task on its current date", async () => {
		const m = await mount();
		const t = await create(m, "Weekly review");
		const pane = await openDetails(m, "Weekly review");
		await click(button(pane));
		await click(opt(pane, "never"));
		const after = taskById(m, t.id);
		expect(after.recurrence).toBeNull();
		expect(after.scheduled).toEqual({ kind: "date", date: FRIDAY });
		expect(lastNotice(m)).toEqual({ message: '"Weekly review" no longer repeats.', label: EDIT_REPEAT_LABEL });
	});

	it("makes a plain task repeat; its deadline is cleared and the notice says so (decision 9)", async () => {
		const m = await mount();
		const t = (await m.h.app.tasks.create({ title: "Report", scheduled: { kind: "date", date: FRIDAY }, deadline: { kind: "date", date: "2026-10-12" } })).task;
		const pane = await openDetails(m, "Report");
		await click(button(pane));
		await click(opt(pane, "weekly"));
		const after = taskById(m, t.id);
		expect(after.deadline).toBeNull();
		expect(after.scheduled).toBeNull();
		expect(after.recurrence?.anchor).toBe(FRIDAY);
		expect(lastNotice(m)?.message).toBe(`"Report" repeats every Fri. ${DEADLINE_CLEARED_TEXT}`);
		expect(DEADLINE_CLEARED_TEXT).toBe("The deadline was cleared: a repeating task has no deadline.");
		expect(pane.querySelector('input[aria-label="Deadline date"]')).toBeNull();
	});

	it("shows no notice when the write changed nothing", async () => {
		const m = await mount();
		await create(m, "Weekly review");
		const pane = await openDetails(m, "Weekly review");
		await click(button(pane));
		await click(opt(pane, "weekly"));
		expect(m.notices).toEqual([]);
	});

	it("opens its picker when a row menu asks for it (Edit repeat…)", async () => {
		const m = await mount();
		const t = await create(m, "Weekly review");
		const pane = await openDetails(m, "Weekly review", false);
		expect(pane.querySelector(".cp-details-fields")).toBeNull();
		requestRepeatEdit(t.id);
		await settle();
		expect(pane.querySelector(".cp-details-fields")).not.toBeNull();
		expect(field(pane).querySelector(".cp-repeat-pop")).not.toBeNull();
	});

	it("refuses to clear the date of a repeating task", async () => {
		const m = await mount();
		const t = await create(m, "Weekly review");
		const pane = await openDetails(m, "Weekly review");
		const date = q<HTMLInputElement>(pane, 'input[aria-label="Scheduled date"]');
		date.value = "";
		date.dispatchEvent(new Event("change", { bubbles: true }));
		await settle();
		expect(taskById(m, t.id).recurrence).not.toBeNull();
		expect(m.host.messages).toContain("Change the repeat instead of clearing the date.");
		expect(q<HTMLInputElement>(pane, 'input[aria-label="Scheduled date"]').value).toBe(FRIDAY);
	});
});
