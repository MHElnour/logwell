// Repeating tasks in the real app: the calendar's occurrences under the real pointer, and the CSV export written
// into the vault. Series are seeded through the app services. Every DOM read is scoped to the visible Calendar or
// Data section (background tabs keep hidden copies). The drag uses the real pointer: keep the mouse off the
// Obsidian window while this runs.
import { browser, expect } from "@wdio/globals";
import {
	appToday,
	centerOf,
	createRepeating,
	DAILY_RULE,
	domClick,
	dragPointer,
	freshDatabase,
	getTask,
	railButton,
	visibleCalendar,
	waitForNotice,
	waitForStableRect,
} from "../helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Rule {
	freq: string;
	interval: number;
	weekdays: string[] | null;
	monthly: unknown;
	afterCompletion: boolean;
}
interface Recurrence {
	anchor: string;
	versions: { effectiveFrom: string; rule: Rule }[];
	end: { kind: string };
	endedAt: string | null;
}
const recurrenceOf = async (id: string): Promise<Recurrence | null> => ((await getTask(id))?.recurrence ?? null) as Recurrence | null;

describe("Recurrence", function () {
	beforeEach(async function () {
		await freshDatabase();
	});

	it("the calendar draws the current occurrence solid and the later ones faded and dashed, and refuses a drag (D6, decision 5)", async function () {
		const today = await appToday();
		const id = await createRepeating("Calendar series", DAILY_RULE, { scheduled: { kind: "date", date: today } });
		const calendar = await visibleCalendar();
		const entries = () =>
			browser.execute((taskId) => {
				const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-calendar")).find((e) => e.offsetParent !== null);
				return Array.from(root?.querySelectorAll<HTMLElement>(`.cp-cal-entry[data-task-id="${taskId}"]`) ?? []).map((el) => ({
					date: el.closest("[data-date]")?.getAttribute("data-date") ?? "",
					classes: el.className,
					name: el.querySelector(".cp-sr-only")?.textContent ?? "",
					icon: el.querySelector(".cp-cal-repeat") !== null,
				}));
			}, id);
		await browser.waitUntil(async () => (await entries()).some((e) => e.date === today), { timeout: 6000, timeoutMsg: "no entry for today" });
		const current = (await entries()).find((e) => e.date === today)!;
		expect(current.classes).not.toContain("is-future");
		expect(current.classes).toContain("is-repeat");
		expect(current.icon).toBe(true);
		expect(current.name).toContain("repeats");
		for (const e of (await entries()).filter((x) => x.date > today)) {
			expect(e.classes).toContain("is-future");
			expect(e.name).toContain("future occurrence");
		}

		// Next week: every entry is a future occurrence.
		await domClick(calendar.$('[aria-label="Next week"]'));
		await browser.waitUntil(async () => (await entries()).length > 0 && (await entries()).every((e) => e.date > today), { timeout: 6000, timeoutMsg: "next week's entries did not render" });
		const future = (await entries())[0]!;
		const target = (await entries())[1]!;
		expect(future.classes).toContain("is-future");
		expect(target.date).not.toBe(future.date);

		// A drag from one future entry to another day changes nothing and starts no drag.
		const before = await recurrenceOf(id);
		const grab = calendar.$(`.cp-cal-allday-cell[data-date="${future.date}"] .cp-cal-entry[data-task-id="${id}"]`);
		const drop = calendar.$(`.cp-cal-allday-cell[data-date="${target.date}"]`);
		await waitForStableRect(grab);
		await dragPointer(
			() => centerOf(grab),
			() => centerOf(drop),
		);
		await browser.pause(300);
		await expect(calendar.$(".cp-cal-ghost")).not.toExist();
		expect(await recurrenceOf(id)).toEqual(before);
		expect((await getTask(id))!.scheduled).toBeNull();
	});

	it("Data > Export CSV writes eight files into a new vault folder (EXP-02, D11)", async function () {
		await createRepeating("Export me", DAILY_RULE);
		await railButton("Data").then((b) => domClick(b));
		const data = await browser.$$(".cp-data").filter((el) => el.isDisplayed());
		const button = data[0]!.$("button=Export CSV");
		await button.waitForExist({ timeout: 5000, timeoutMsg: "no Export CSV button" });
		await domClick(button);
		const notice = await waitForNotice("Exported 8 files to Logwell export");
		const folder = notice.slice(notice.indexOf("to ") + 3).trim();
		const files = await browser.executeObsidian(({ app }, path) => {
			const f = app.vault.getFolderByPath(path);
			return f === null ? [] : f.children.map((c) => c.name).sort();
		}, folder);
		expect(files).toEqual(["check-ins.csv", "focus-sessions.csv", "habits.csv", "lists.csv", "occurrences.csv", "sections.csv", "tags.csv", "tasks.csv"]);
		const tasksCsv = await browser.executeObsidian(async ({ app }, path) => app.vault.adapter.read(`${path}/tasks.csv`), folder);
		expect(tasksCsv.startsWith("\uFEFF")).toBe(true);
		expect(tasksCsv).toContain("Export me");
	});
});
