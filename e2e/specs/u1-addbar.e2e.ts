// NOT RUN. These specs were written in a cloud session that cannot start
// Obsidian. They typecheck (`npx tsc -p e2e/tsconfig.json`) but have never
// executed. Run `npm run e2e` locally and fix what the real app shows.
// The add bar, the date popover and the more menu in the real
// app. They check what happy-dom cannot: real focus, Obsidian's Escape handling, the Quick Add
// modal's close(), and Enter/Escape not leaking out of a popover.
//
// Row selectors follow the task row: `.cp-task-row[data-task-id]` with a
// `.cp-task-checkbox.cp-pri-N` and `.is-selected` on the selected row.
import { browser, expect } from "@wdio/globals";
import {
	MOD_KEY,
	allTasks,
	appToday,
	closeQuickAdd,
	createTask,
	focusedElement,
	freshDatabase,
	getTask,
	openQuickAdd,
	plusDays,
	showInbox,
	visibleTasksSection,
} from "../helpers";

const addInput = (section: WebdriverIO.Element) => section.$('.cp-add-bar input[aria-label="Add task"]');
const dateTool = (scope: WebdriverIO.Element) => scope.$('.cp-qa-tool[aria-label="Date"]');
const moreTool = (scope: WebdriverIO.Element) => scope.$('.cp-qa-tool[aria-label="Priority, list, tags and note"]');

async function onlyTask(): Promise<Record<string, unknown>> {
	let tasks: Record<string, unknown>[] = [];
	await browser.waitUntil(
		async () => {
			tasks = await allTasks();
			return tasks.length > 0;
		},
		{ timeout: 5000, timeoutMsg: "no task was saved" },
	);
	expect(tasks).toHaveLength(1);
	return tasks[0]!;
}

async function openInboxBar(): Promise<WebdriverIO.Element> {
	const section = await visibleTasksSection();
	await showInbox(section);
	await addInput(section).waitForExist({ timeout: 5000 });
	return section;
}

describe("Add bar: date popover", function () {
	beforeEach(async function () {
		await freshDatabase();
	});

	afterEach(async function () {
		await closeQuickAdd();
	});

	it("opens, picks a day, Escape closes only the popover, and Enter still saves with that date", async function () {
		const section = await openInboxBar();
		const leavesBefore = await browser.executeObsidian(({ app }) => app.workspace.getLeavesOfType("checkpoint-app").length);
		await addInput(section).setValue("Dentist");
		await dateTool(section).click();
		const pop = section.$(".cp-add-bar .cp-date-pop");
		await pop.waitForDisplayed({ timeout: 3000 });
		await expect(dateTool(section)).toHaveAttribute("aria-expanded", "true");
		const today = await appToday();
		const target = plusDays(today, 3);
		await pop.$(`.cp-cal-day[data-date="${target}"]`).click();
		await expect(pop.$(".cp-cal-day.is-picked")).toHaveAttribute("data-date", target);

		await browser.keys("Escape");
		await expect(pop).not.toExist();
		// Only the popover closed: the tab, the add bar and the typed text are still there.
		const leavesAfter = await browser.executeObsidian(({ app }) => app.workspace.getLeavesOfType("checkpoint-app").length);
		expect(leavesAfter).toBe(leavesBefore);
		await expect(addInput(section)).toHaveValue("Dentist");

		await addInput(section).click();
		await browser.keys("Enter");
		const task = await onlyTask();
		expect(task.title).toBe("Dentist");
		expect(task.scheduled).toEqual({ kind: "date", date: target });
	});

	it("Enter inside the popover does not save", async function () {
		const section = await openInboxBar();
		await addInput(section).setValue("Not yet");
		await dateTool(section).click();
		const pop = section.$(".cp-add-bar .cp-date-pop");
		await pop.waitForDisplayed({ timeout: 3000 });
		await pop.$(".cp-pop-row[data-row='time']").click();
		await browser.keys(["1", "9", "0", "0"]); // focus is in the time input
		await browser.keys("Enter");
		await browser.pause(500);
		expect(await allTasks()).toHaveLength(0);
		await expect(pop).toExist();
	});

	it("the Quick Add modal: Escape closes the popover first, then the modal", async function () {
		const modal = await openQuickAdd();
		await dateTool(modal).click();
		await modal.$(".cp-date-pop").waitForDisplayed({ timeout: 3000 });
		await browser.keys("Escape");
		await expect(modal.$(".cp-date-pop")).not.toExist();
		await expect(modal).toExist(); // the modal is still open
		await browser.keys("Escape");
		await browser.waitUntil(async () => !(await browser.$(".checkpoint-quick-add-modal").isExisting()), {
			timeout: 3000,
			timeoutMsg: "the second Escape did not close the modal",
		});
	});

	it("the Quick Add modal saves with a quick pick and the date popover's tool is labeled", async function () {
		const modal = await openQuickAdd();
		await expect(dateTool(modal)).toBeDisplayed();
		await modal.$(".cp-quick-add-title").setValue("Call back");
		await dateTool(modal).click();
		await modal.$(".cp-quick-btn=Tomorrow").click();
		await browser.keys("Escape");
		await modal.$(".cp-quick-add-title").click();
		await browser.keys("Enter");
		const task = await onlyTask();
		expect(task.scheduled).toEqual({ kind: "date", date: plusDays(await appToday(), 1) });
	});
});

describe("Add bar: more menu and priority", function () {
	beforeEach(async function () {
		await freshDatabase();
	});

	afterEach(async function () {
		await closeQuickAdd();
	});

	it("a priority picked in the more menu is saved and shown on the row", async function () {
		const section = await openInboxBar();
		await addInput(section).setValue("Pay rent");
		await moreTool(section).click();
		const pop = section.$(".cp-add-bar .cp-more-pop");
		await pop.waitForDisplayed({ timeout: 3000 });
		await pop.$('button[aria-label="High priority"]').click();
		await expect(pop.$('button[aria-label="High priority"]')).toHaveAttribute("aria-pressed", "true");
		await browser.keys("Escape");
		await expect(pop).not.toExist();
		await addInput(section).click();
		await browser.keys("Enter");
		const task = await onlyTask();
		expect(task.priority).toBe(1);
		await section.$(`.cp-task-row[data-task-id="${String(task.id)}"] .cp-task-checkbox.cp-pri-1`).waitForExist({ timeout: 5000 });
	});

	it("a typed !2 is highlighted, shown as a chip, saved and shown on the row", async function () {
		const section = await openInboxBar();
		await addInput(section).setValue("Water plants !2");
		await expect(section.$(".cp-add-bar .cp-qa-mirror mark.cp-qa-tok-pri-2")).toHaveText("!2");
		await expect(section.$('.cp-add-bar .cp-qa-chip[data-kind="priority"]')).toHaveText(expect.stringContaining("Medium priority"));
		await browser.keys("Enter");
		const task = await onlyTask();
		expect(task.priority).toBe(2);
		expect(task.title).toBe("Water plants");
		await section.$(`.cp-task-row[data-task-id="${String(task.id)}"] .cp-task-checkbox.cp-pri-2`).waitForExist({ timeout: 5000 });
	});

	it("List > picks a list through the inline sub-list", async function () {
		await browser.executeObsidian(async ({ plugins }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await (plugins as any).logwell.session.app.categories.create("Study");
		});
		const section = await openInboxBar();
		await addInput(section).setValue("Read chapter 3");
		await moreTool(section).click();
		const pop = section.$(".cp-add-bar .cp-more-pop");
		await pop.$(".cp-pop-row[data-row='list']").click();
		await pop.$(".cp-pop-choice=Study").click();
		await expect(pop.$(".cp-pop-row[data-row='list'] .cp-pop-val")).toHaveText("Study");
		await browser.keys("Escape");
		await addInput(section).click();
		await browser.keys("Enter");
		const task = await onlyTask();
		const categories = await browser.executeObsidian(({ plugins }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return (plugins as any).logwell.session.app.categories.list().map((c: { id: string; name: string }) => [c.id, c.name]);
		});
		const study = (categories as [string, string][]).find(([, name]) => name === "Study");
		expect(task.categoryId).toBe(study?.[0]);
	});
});

describe("Add bar: highlight alignment", function () {
	beforeEach(async function () {
		await freshDatabase();
	});

	it("the highlight layer is exactly as wide as the typed text, with many adjacent tokens", async function () {
		const section = await visibleTasksSection();
		const bar = section.$(".cp-qa-input");
		await bar.click();
		await browser.keys("Prepare demo next friday at 2:30pm for 1h30m by oct 12 #Inbox !1".split(""));
		await browser.pause(300);
		const r = await browser.execute(() => {
			const views = Array.from(document.querySelectorAll<HTMLElement>(".cp-tasks")).filter((e) => e.offsetParent !== null);
			const root = views[0]!;
			const input = root.querySelector<HTMLInputElement>(".cp-qa-input")!;
			const run = root.querySelector<HTMLElement>(".cp-qa-mirror-text")!;
			const ctx = document.createElement("canvas").getContext("2d")!;
			const cs = getComputedStyle(input);
			ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
			return { text: ctx.measureText(input.value).width, mirror: run.getBoundingClientRect().width };
		});
		expect(Math.abs(r.mirror - r.text)).toBeLessThan(2);
	});
});

describe("Keyboard-only capture with popovers", function () {
	beforeEach(async function () {
		await freshDatabase();
	});

	it("Tab to the tool, Enter opens, arrows move, Enter picks, Escape closes, Enter saves", async function () {
		const section = await openInboxBar();
		await addInput(section).click();
		await browser.keys("Keyboard task".split(""));
		// Typing needs focus in the input; wait for it before the first Tab leaves it.
		await browser.waitUntil(async () => (await focusedElement()).label === "Add task", { timeout: 3000, timeoutMsg: "focus did not reach the Add task input" });
		await browser.keys("Tab");
		await browser.waitUntil(async () => (await focusedElement()).label === "Date", { timeout: 3000, timeoutMsg: "focus did not reach the Date tool" });
		await browser.keys("Enter");
		const pop = section.$(".cp-add-bar .cp-date-pop");
		await pop.waitForDisplayed({ timeout: 3000 });
		// Focus moved into the popover, onto today's cell.
		const today = await appToday();
		await browser.waitUntil(async () => (await focusedElement()).date === today, { timeout: 3000, timeoutMsg: "focus did not land on today" });
		// Focus moves after each re-render: wait for one arrow to land before sending the next.
		await browser.keys("ArrowRight");
		await browser.waitUntil(async () => (await focusedElement()).date === plusDays(today, 1), { timeout: 3000, timeoutMsg: "ArrowRight did not move focus" });
		await browser.keys("ArrowDown");
		await browser.waitUntil(async () => (await focusedElement()).date === plusDays(today, 8), { timeout: 3000, timeoutMsg: "ArrowDown did not move focus" });
		await browser.keys("Enter");
		await expect(pop.$(".cp-cal-day.is-picked")).toHaveAttribute("data-date", plusDays(today, 8));
		await browser.keys("Escape");
		await expect(pop).not.toExist();
		await browser.waitUntil(async () => (await focusedElement()).label === "Date", { timeout: 3000, timeoutMsg: "focus did not return to the Date tool" });
		await browser.keys(["Shift", "Tab"]);
		expect((await focusedElement()).label).toBe("Add task");
		await browser.keys("Enter");
		const task = await onlyTask();
		expect(task.title).toBe("Keyboard task");
		expect(task.scheduled).toEqual({ kind: "date", date: plusDays(today, 8) });
	});
});

describe("Row: Cmd/Ctrl+Enter on a selected row", function () {
	beforeEach(async function () {
		await freshDatabase();
	});

	it("completes the selected task", async function () {
		const id = await createTask("Complete me");
		const section = await openInboxBar();
		const row = section.$(`.cp-task-row[data-task-id="${id}"]`);
		await row.waitForExist({ timeout: 5000 });
		await row.click();
		await expect(row).toHaveElementClass("is-selected");
		await browser.execute((el) => (el as unknown as HTMLElement).focus(), await row.getElement());
		await browser.keys([MOD_KEY, "Enter"]);
		await browser.waitUntil(async () => (await getTask(id))?.status === "completed", {
			timeout: 3000,
			timeoutMsg: "Cmd/Ctrl+Enter did not complete the selected task",
		});
	});
});
