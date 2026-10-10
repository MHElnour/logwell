// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { type CalMount, click, mountCal, settle } from "./m3-helpers";

// Obsidian shows a tooltip for aria-label, so an element that also sets `title` showed two.
// Icon buttons keep aria-label and drop title, everywhere.

const mounted: CalMount[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
});

const both = (root: ParentNode) =>
	[...root.querySelectorAll<HTMLElement>("[aria-label][title]")].map((el) => `<${el.tagName.toLowerCase()} class="${el.className}" aria-label="${el.getAttribute("aria-label")}" title="${el.getAttribute("title")}">`);

describe("no element has both aria-label and title (F7)", () => {
	it("holds in Tasks, Calendar, Matrix and Search", async () => {
		const m = await mountCal();
		mounted.push(m);
		const cat = await m.h.app.categories.create("Work", "briefcase");
		await m.h.app.tags.create("urgent", "red");
		const parent = await m.h.app.tasks.create({
			title: "Plan trip",
			categoryId: cat.id,
			tagKeys: ["urgent"],
			urgent: true,
			scheduled: { kind: "date", date: "2026-10-01" },
			deadline: { kind: "date", date: "2026-10-05" },
		});
		await m.h.app.tasks.create({ title: "Book hotel", parentId: parent.task.id });
		await m.h.app.tasks.create({ title: "Timed", scheduled: { kind: "datetime", local: "2026-10-01T19:00", tz: "Europe/Berlin" }, plannedDurationMin: 30 });
		await settle();

		// Tasks, with the details pane and the add bar's tools.
		expect(m.root.querySelectorAll(".cp-task-row").length).toBeGreaterThan(0);
		expect(both(m.root)).toEqual([]);
		await click(m.root.querySelector(".cp-task-row"));
		expect(m.root.querySelector(".cp-details")).not.toBeNull();
		expect(both(m.root)).toEqual([]);

		for (const section of ["Calendar", "Matrix", "Search"]) {
			await click(m.root.querySelector(`.cp-rail [aria-label="${section}"]`));
			expect(both(m.root), section).toEqual([]);
		}
		// The calendar's other mode and its Unscheduled drawer.
		await click(m.root.querySelector('.cp-rail [aria-label="Calendar"]'));
		await click(m.root.querySelector(".cp-cal-unscheduled-toggle, [aria-label='Unscheduled']"));
		expect(both(m.root), "Calendar drawer").toEqual([]);
	});
});
