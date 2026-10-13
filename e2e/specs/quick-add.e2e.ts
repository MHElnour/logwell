// NOT RUN. These specs were written in a cloud session that cannot start
// Obsidian. They typecheck (`npx tsc -p e2e/tsconfig.json`) but have never
// executed. Run `npm run e2e` locally and fix what the real app shows.
// Quick Add against the real vault and Obsidian's suggester: `[[note]]` matches and Enter in the suggester. The
// chips, lists, manual values, tags and keys are in tests/ui/quick-add.test.tsx.
import { browser, expect } from "@wdio/globals";
import {
	allTasks,
	closeQuickAdd,
	createCategory,
	freshDatabase,
	openQuickAdd,
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
