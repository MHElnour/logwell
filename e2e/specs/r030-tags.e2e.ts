// Parent tags in the real app. Tasks are seeded through the app
// services; every DOM read is scoped to the visible Tasks section (background tabs keep hidden copies).
import { browser, expect } from "@wdio/globals";
import {
	createTask,
	domClick,
	flush,
	freshDatabase,
	visibleTasksSection,
} from "../helpers";

async function detachAppLeaves(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		app.workspace.detachLeavesOfType("checkpoint-app");
	});
}

async function treeLabels(section: WebdriverIO.Element): Promise<string[]> {
	const out: string[] = [];
	for (const l of await section.$$(".cp-tag-tree .cp-sidebar-label")) out.push(await l.getText());
	return out;
}

async function titlesShown(section: WebdriverIO.Element): Promise<string[]> {
	const out: string[] = [];
	for (const t of await section.$$(".cp-task-row .cp-task-title")) out.push(await t.getText());
	return out.sort();
}

describe("Parent tags (P6)", function () {
	beforeEach(async function () {
		await freshDatabase();
		await detachAppLeaves();
		await createTask("Go task", { newTags: ["Programming/Go"] });
		await createTask("Python task", { newTags: ["Programming/Python"] });
		await flush();
	});

	it("shows Programming with two children; the parent view lists both tasks and a child lists one", async function () {
		const section = await visibleTasksSection();
		await browser.waitUntil(async () => (await treeLabels(section)).length === 3, { timeout: 5000, timeoutMsg: "the tag tree did not appear" });
		expect(await treeLabels(section)).toEqual(["Programming", "Go", "Python"]);

		await domClick(section.$(".cp-tag-tree .cp-sidebar-item"));
		await browser.waitUntil(async () => (await section.$(".cp-main-title").getText()) === "@Programming", {
			timeout: 5000,
			timeoutMsg: "the parent view did not open",
		});
		expect(await titlesShown(section)).toEqual(["Go task", "Python task"]);

		const go = await section.$$(".cp-tag-tree .cp-sidebar-item");
		await domClick(go[1]!);
		await browser.waitUntil(async () => (await section.$(".cp-main-title").getText()) === "@Go", {
			timeout: 5000,
			timeoutMsg: "the child view did not open",
		});
		expect(await titlesShown(section)).toEqual(["Go task"]);
	});

	it("the fold arrow hides and shows the children", async function () {
		const section = await visibleTasksSection();
		const fold = section.$('.cp-tag-fold[data-tag-label="Programming"]');
		await fold.waitForExist({ timeout: 5000 });
		expect(await fold.getAttribute("aria-expanded")).toBe("true");
		await domClick(fold);
		await browser.waitUntil(async () => (await treeLabels(section)).length === 1, { timeout: 5000, timeoutMsg: "the tree did not fold" });
		expect(await section.$('.cp-tag-fold[data-tag-label="Programming"]').getAttribute("aria-expanded")).toBe("false");
	});
});
