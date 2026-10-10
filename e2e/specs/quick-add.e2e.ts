// NOT RUN. These specs were written in a cloud session that cannot start
// Obsidian. They typecheck (`npx tsc -p e2e/tsconfig.json`) but have never
// executed. Run `npm run e2e` locally and fix what the real app shows.
// Quick Add end to end: dismissed chips, unresolved lists, manual values, note matches, new tags and keys; the
// last specs check what jsdom cannot: the real suggester, Escape and Enter.
import { browser, expect } from "@wdio/globals";
import {
	allTasks,
	categoryCount,
	closeQuickAdd,
	createCategory,
	freshDatabase,
	openQuickAdd,
	setModalDate,
	tagKeys,
} from "../helpers";

const title = (modal: WebdriverIO.Element) => modal.$(".cp-quick-add-title");
const chip = (modal: WebdriverIO.Element, kind: string) => modal.$(`.cp-qa-chip[data-kind="${kind}"]`);

/** The modal has closed after a save (Quick Add closes unless "keep open" is on). */
async function modalClosed(): Promise<void> {
	await browser.waitUntil(async () => !(await browser.$(".checkpoint-quick-add-modal").isExisting()), {
		timeout: 5000,
		timeoutMsg: "Quick Add did not close after saving",
	});
}

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

describe("Quick Add natural language", function () {
	beforeEach(async function () {
		await freshDatabase();
	});

	afterEach(async function () {
		await closeQuickAdd();
	});

	it("AS-07: dismissing the date chip keeps 'Call mom tomorrow' and no schedule", async function () {
		const modal = await openQuickAdd();
		await title(modal).setValue("Call mom tomorrow");
		await chip(modal, "scheduled").waitForExist({ timeout: 5000 });
		await expect(modal.$(".cp-qa-mirror mark.cp-qa-span")).toHaveText("tomorrow");
		await chip(modal, "scheduled").$(".cp-qa-chip-remove").click();
		await expect(chip(modal, "scheduled")).not.toExist();
		await browser.keys("Enter");
		await modalClosed();
		const task = await onlyTask();
		expect(task.title).toBe("Call mom tomorrow");
		expect(task.scheduled).toBeNull();
	});

	it("B3: a dismissed span is not recognized again while typing more", async function () {
		const modal = await openQuickAdd();
		await title(modal).setValue("Call mom tomorrow");
		await chip(modal, "scheduled").$(".cp-qa-chip-remove").click();
		await title(modal).addValue(" please call");
		await browser.pause(300);
		await expect(modal.$(".cp-qa-chip")).not.toExist();
	});

	it("AS-08 and B2: '#Hobbies' without that category blocks Enter, then Inbox saves", async function () {
		const before = await categoryCount();
		const modal = await openQuickAdd();
		await title(modal).setValue("Read #Hobbies");
		await chip(modal, "category").waitForExist({ timeout: 5000 });
		await browser.keys("Enter");
		const select = modal.$(".cp-qa-panel select");
		await select.waitForExist({ timeout: 5000 });
		await expect(select).toBeFocused();
		expect(await select.getValue()).toBe("inbox");
		expect(await allTasks()).toHaveLength(0);
		await browser.keys("Enter");
		await modalClosed();
		const task = await onlyTask();
		expect(task.title).toBe("Read");
		expect(task.categoryId).toBe("inbox");
		expect(await categoryCount()).toBe(before);
	});

	it("C3: Escape closes the chip picker first, and only a second Escape closes the modal", async function () {
		const modal = await openQuickAdd();
		await title(modal).setValue("Read #Hobbies");
		await browser.keys("Enter");
		await modal.$(".cp-qa-panel select").waitForExist({ timeout: 5000 });
		await browser.keys("Escape");
		await expect(modal.$(".cp-qa-panel")).not.toExist();
		await expect(modal).toExist();
		await browser.keys("Escape");
		await modalClosed();
		expect(await allTasks()).toHaveLength(0);
	});

	it("B4: a manual date stays; 'next friday' shows 'Replace date?' and is only applied when accepted", async function () {
		let modal = await openQuickAdd();
		await setModalDate(0, "2031-01-15");
		await title(modal).setValue("Meet next friday");
		const c = chip(modal, "scheduled");
		await c.waitForExist({ timeout: 5000 });
		await expect(c).toHaveAttribute("data-status", "suggestion");
		await expect(c).toHaveText(expect.stringContaining("Replace date?"));
		await title(modal).click();
		await browser.keys("Enter");
		await modalClosed();
		let task = await onlyTask();
		expect(task.title).toBe("Meet next friday");
		expect(task.scheduled).toEqual({ kind: "date", date: "2031-01-15" });

		// Accepting replaces the manual date.
		modal = await openQuickAdd();
		await setModalDate(0, "2031-01-15");
		await title(modal).setValue("Meet next friday");
		await chip(modal, "scheduled").$(".cp-qa-chip-main").click();
		await expect(chip(modal, "scheduled")).toHaveAttribute("data-status", "applied");
		await title(modal).click();
		await browser.keys("Enter");
		await modalClosed();
		const tasks = await allTasks();
		expect(tasks).toHaveLength(2);
		task = tasks.find((t) => t.title === "Meet")!;
		expect(task).toBeDefined();
		expect((task.scheduled as { date: string }).date).not.toBe("2031-01-15");
	});

	it("B5: '[[Roadmap]]' matches two notes; skipping saves without a note and keeps the text", async function () {
		const modal = await openQuickAdd();
		await title(modal).setValue("Draft [[Roadmap]]");
		const c = chip(modal, "note");
		await c.waitForExist({ timeout: 5000 });
		await expect(c).toHaveAttribute("data-status", "collision");
		await expect(c).toHaveText(expect.stringContaining("2 matches"));
		// The cursor is right after the closed link, so no suggester opens (tokenAtCursor is null there);
		// Enter in the title saves.
		await browser.keys("Enter");
		await modalClosed();
		const task = await onlyTask();
		expect(task.descriptionNote).toBeNull();
		expect(task.title).toBe("Draft [[Roadmap]]");
	});

	it("B5: choosing one of the matches links that note", async function () {
		const modal = await openQuickAdd();
		await title(modal).setValue("Draft [[Roadmap]]");
		await chip(modal, "note").$(".cp-qa-chip-main").click();
		const select = modal.$(".cp-qa-panel select");
		await select.waitForExist({ timeout: 5000 });
		await select.selectByAttribute("value", "Projects/Roadmap.md");
		await modal.$(".cp-qa-panel .cp-qa-apply").click();
		await title(modal).click();
		await browser.keys("Enter");
		await modalClosed();
		const task = await onlyTask();
		expect((task.descriptionNote as { path: string }).path).toBe("Projects/Roadmap.md");
		expect(task.title).toBe("Draft");
	});

	it("TAG-02: '@newtag' shows 'New tag: newtag' and saving creates it once", async function () {
		const modal = await openQuickAdd();
		await title(modal).setValue("Read @newtag");
		const c = chip(modal, "tag");
		await c.waitForExist({ timeout: 5000 });
		await expect(c).toHaveText(expect.stringContaining("New tag: newtag"));
		await browser.keys("Enter");
		await modalClosed();
		const task = await onlyTask();
		expect(task.tagKeys).toEqual(["newtag"]);
		expect(task.title).toBe("Read");
		expect(await tagKeys()).toEqual(["newtag"]);
	});

	it("TAG-02: dismissing the chip keeps '@newtag' in the title and creates no tag", async function () {
		const modal = await openQuickAdd();
		await title(modal).setValue("Read @newtag");
		await chip(modal, "tag").$(".cp-qa-chip-remove").click();
		// Dismissing moves focus back to the title after the next render.
		await expect(title(modal)).toBeFocused();
		await browser.keys("Enter");
		await modalClosed();
		const task = await onlyTask();
		expect(task.title).toBe("Read @newtag");
		expect(await tagKeys()).toEqual([]);
	});

	it("keyboard only: type, Tab into the chips, arrows, Delete, then Enter saves", async function () {
		const modal = await openQuickAdd();
		await expect(title(modal)).toBeFocused();
		await browser.keys("Call mom tomorrow for 45m".split(""));
		await modal.$(".cp-qa-chip").waitForExist({ timeout: 5000 });
		// Tab order: title input → date tool → more tool → chips.
		await browser.keys("Tab");
		await expect(modal.$('.cp-qa-tool[data-tool="date"]')).toBeFocused();
		await browser.keys("Tab");
		await browser.keys("Tab");
		const mains = await modal.$$(".cp-qa-chip-main");
		expect(mains).toHaveLength(2);
		await expect(mains[0]!).toBeFocused();
		await browser.keys("ArrowRight");
		await expect(mains[1]!).toBeFocused();
		await browser.keys("ArrowLeft");
		await expect(mains[0]!).toBeFocused();
		// Delete dismisses the date chip ("tomorrow" stays in the title); focus moves to the next chip.
		await browser.keys("Delete");
		await expect(modal.$$(".cp-qa-chip")).toBeElementsArrayOfSize(1);
		await expect(modal.$(".cp-qa-chip-main")).toBeFocused();
		await browser.keys("Delete");
		await expect(title(modal)).toBeFocused();
		await browser.keys("Enter");
		await modalClosed();
		const task = await onlyTask();
		expect(task.title).toBe("Call mom tomorrow for 45m");
		expect(task.scheduled).toBeNull();
		expect(task.plannedDurationMin).toBeNull();
	});

	it("B4 of the suggester: Enter picks the suggestion and does not save; the next Enter saves", async function () {
		const study = await createCategory("Study");
		const modal = await openQuickAdd();
		await browser.keys("Read #Stu".split(""));
		await browser.$(".suggestion-container").waitForExist({ timeout: 5000 });
		await browser.keys("Enter");
		await expect(title(modal)).toHaveValue("Read #Study");
		expect(await allTasks()).toHaveLength(0);
		await expect(chip(modal, "category")).toHaveAttribute("data-status", "applied");
		// The pick has settled when the suggestion popover is gone and the title has the focus. Obsidian answers the
		// pick's input event with a late lookup; a second Enter sent before that must not be read as a pick.
		await browser.waitUntil(
			async () =>
				!(await browser.$(".suggestion-container").isExisting()) &&
				(await browser.execute(() => document.activeElement?.classList.contains("cp-quick-add-title") === true)),
			{ timeout: 5000, timeoutMsg: "the suggester did not settle after the pick" },
		);
		await browser.keys("Enter");
		await modalClosed();
		const task = await onlyTask();
		expect(task.categoryId).toBe(study);
		expect(task.title).toBe("Read");
	});
});
