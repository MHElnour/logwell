// Parent tags in the real app. Tasks are seeded through the app
// services; every DOM read is scoped to the visible Tasks section (background tabs keep hidden copies).
import { browser, expect } from "@wdio/globals";
import {
	clickModalButton,
	clickUndoNotice,
	closeNotices,
	createTask,
	domClick,
	flush,
	freshDatabase,
	pickMenuItem,
	restoreMenus,
	useDomMenus,
	visibleTasksSection,
	waitForNotice,
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

	it("New tag: the + beside Tags creates a tag under a parent in one write; Undo removes it (#7)", async function () {
		const section = await visibleTasksSection();
		await browser.waitUntil(async () => (await treeLabels(section)).length === 3, { timeout: 5000, timeoutMsg: "the tag tree did not appear" });
		await domClick(section.$('.cp-sidebar [aria-label="New tag"]'));
		const dialog = browser.$(".checkpoint-tag-dialog");
		await dialog.waitForExist({ timeout: 5000, timeoutMsg: "the New tag dialog did not open" });
		const create = dialog.$("button.mod-cta");
		await expect(create).toBeDisabled();
		// A name in use is refused as typed.
		await dialog.$("input.cp-new-list-name").setValue("go");
		await dialog.$(".cp-new-list-error").waitForDisplayed({ timeout: 5000 });
		await expect(dialog.$(".cp-new-list-error")).toHaveText('The name "Go" is already used by another tag.');
		await expect(create).toBeDisabled();
		await dialog.$("input.cp-new-list-name").setValue("Rust");
		await dialog.$("select.cp-tag-form-parent").selectByAttribute("value", "programming");
		await domClick(dialog.$('.cp-color-choice[aria-label="Green"]'));
		await expect(create).toBeEnabled();
		await domClick(create);
		await dialog.waitForExist({ timeout: 5000, reverse: true, timeoutMsg: "the dialog did not close on Create" });
		await browser.waitUntil(async () => (await treeLabels(section)).includes("Rust"), { timeout: 5000, timeoutMsg: "the new tag is not in the tree" });
		expect(await treeLabels(section)).toEqual(["Programming", "Go", "Python", "Rust"]);
		await waitForNotice("Created tag @Rust.");
		await clickUndoNotice();
		await browser.waitUntil(async () => !(await treeLabels(section)).includes("Rust"), { timeout: 5000, timeoutMsg: "Undo did not remove the tag" });
	});

	it("Edit: renaming a tag renames it on its tasks in one write; Undo restores it (#8)", async function () {
		const section = await visibleTasksSection();
		await browser.waitUntil(async () => (await treeLabels(section)).length === 3, { timeout: 5000, timeoutMsg: "the tag tree did not appear" });
		const wasNative = await useDomMenus();
		try {
			const go = (await section.$$(".cp-tag-tree .cp-sidebar-item"))[1]!;
			await domClick(go);
			await browser.waitUntil(async () => (await section.$(".cp-main-title").getText()) === "@Go", { timeout: 5000, timeoutMsg: "the Go view did not open" });
			await closeNotices();
			await go.click({ button: "right" });
			await pickMenuItem("Edit");
			const dialog = browser.$(".checkpoint-tag-dialog");
			await dialog.waitForExist({ timeout: 5000, timeoutMsg: "the Edit tag dialog did not open" });
			await expect(dialog.$("input.cp-new-list-name")).toHaveValue("Go");
			await dialog.$("input.cp-new-list-name").setValue("Golang");
			await domClick(dialog.$("button.mod-cta"));
			await dialog.waitForExist({ timeout: 5000, reverse: true, timeoutMsg: "the dialog did not close on Save" });
			await waitForNotice("Renamed tag @Go to @Golang.");
			// The open view follows the rename, and the task row shows the new name.
			await browser.waitUntil(async () => (await section.$(".cp-main-title").getText()) === "@Golang", { timeout: 5000, timeoutMsg: "the view did not follow" });
			await expect(section.$(".cp-task-row .cp-tag-pill")).toHaveText("@Golang");
			expect(await treeLabels(section)).toEqual(["Programming", "Golang", "Python"]);
			await clickUndoNotice();
			await browser.waitUntil(async () => (await treeLabels(section)).includes("Go"), { timeout: 5000, timeoutMsg: "Undo did not restore the name" });
			expect(await treeLabels(section)).toEqual(["Programming", "Go", "Python"]);
		} finally {
			await restoreMenus(wasNative);
		}
	});

	it("a parent is a tag: its row has the menu and takes a color (#9)", async function () {
		const section = await visibleTasksSection();
		await browser.waitUntil(async () => (await treeLabels(section)).length === 3, { timeout: 5000, timeoutMsg: "the tag tree did not appear" });
		const wasNative = await useDomMenus();
		try {
			const programming = (await section.$$(".cp-tag-tree .cp-sidebar-item"))[0]!;
			await programming.click({ button: "right" });
			await pickMenuItem("Color: purple");
			await browser.waitUntil(async () => ((await programming.$(".cp-tag-dot").getAttribute("class")) ?? "").includes("cp-tag-purple"), {
				timeout: 5000,
				timeoutMsg: "the parent did not take the color",
			});
			const color = await browser.executeObsidian(({ plugins }) => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				return ((plugins as any).logwell.session.app.store.state.tags.get("programming")?.color ?? null) as string | null;
			});
			expect(color).toBe("purple");
		} finally {
			await restoreMenus(wasNative);
		}
	});

	it("deleting a parent moves its child tags to the top level in one write; Undo brings it back (#9)", async function () {
		const section = await visibleTasksSection();
		await browser.waitUntil(async () => (await treeLabels(section)).length === 3, { timeout: 5000, timeoutMsg: "the tag tree did not appear" });
		const wasNative = await useDomMenus();
		try {
			await closeNotices();
			const programming = (await section.$$(".cp-tag-tree .cp-sidebar-item"))[0]!;
			await programming.click({ button: "right" });
			await pickMenuItem("Delete");
			await clickModalButton("Delete");
			await browser.waitUntil(async () => !(await treeLabels(section)).includes("Programming"), { timeout: 5000, timeoutMsg: "the parent was not deleted" });
			expect(await treeLabels(section)).toEqual(["Go", "Python"]);
			await waitForNotice("Deleted tag @Programming.");
			await clickUndoNotice();
			await browser.waitUntil(async () => (await treeLabels(section)).includes("Programming"), { timeout: 5000, timeoutMsg: "Undo did not restore the parent" });
			expect(await treeLabels(section)).toEqual(["Programming", "Go", "Python"]);
		} finally {
			await restoreMenus(wasNative);
		}
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
