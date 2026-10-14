import { browser, expect } from "@wdio/globals";
import { median } from "../../tests/perf/measure";
import {
	createTask,
	DB_PATH,
	flush,
	freshDatabase,
	getTask,
	markdownCount,
	readVaultFile,
} from "../helpers";

/** Opens the app on Inbox, clicks the task's row, and returns the visible Tasks section. */
async function openTaskDetails(id: string): Promise<WebdriverIO.Element> {
	await browser.executeObsidian(async ({ plugins }) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (plugins as any).logwell.openApp("tasks");
	});
	// Background tabs keep their own (hidden) app views; use the visible one.
	let section: WebdriverIO.Element | undefined;
	await browser.waitUntil(
		async () => {
			for (const el of await browser.$$(".cp-tasks")) if (await el.isDisplayed()) section = el;
			return section !== undefined;
		},
		{ timeout: 5000, timeoutMsg: "no visible Tasks section" },
	);
	await section!.$(".cp-sidebar").$(`.//*[normalize-space(text())="Inbox"]`).click();
	const row = section!.$(`.cp-task-row[data-task-id="${id}"]`);
	await row.waitForExist({ timeout: 5000 });
	await row.click();
	await section!.$(".cp-details").waitForExist({ timeout: 5000 });
	return section!;
}

// Tasks and description notes, end to end in real Obsidian.
describe("Tasks and description notes", function () {
	beforeEach(async function () {
		await freshDatabase();
	});

	it("Quick Add with a title only creates a task and no note", async function () {
		const notesBefore = await markdownCount();
		await browser.executeObsidianCommand("logwell:quick-add-task");
		const input = browser.$(".cp-quick-add-title");
		await input.waitForExist({ timeout: 5000 });
		await input.setValue("Buy milk");
		await browser.keys("Enter");
		await flush();
		const db = await readVaultFile(DB_PATH);
		expect(db).toContain('"title":"Buy milk"');
		expect(db).toMatch(/"title":"Buy milk"[^\n]*"categoryId":"inbox"/);
		expect(await markdownCount()).toBe(notesBefore);
	});

	it("a linked note renders, is not copied, and updates live", async function () {
		const id = await createTask("Plan the integration");
		await browser.executeObsidian(async ({ plugins }, taskId) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await (plugins as any).logwell.session.app.tasks.linkNote(taskId, "Plan.md");
		}, id);
		await flush();
		const db = await readVaultFile(DB_PATH);
		expect(db).toContain('"path":"Plan.md"');
		expect(db).not.toContain("Research and plan the integration");

		const section = await openTaskDetails(id);
		const preview = section.$(".cp-note-preview");
		await expect(preview).toHaveText(expect.stringContaining("Research and plan the integration"));

		const dbBefore = await readVaultFile(DB_PATH);
		await browser.executeObsidian(async ({ app }) => {
			const file = app.vault.getFileByPath("Plan.md");
			if (file === null) throw new Error("missing note");
			await app.vault.process(file, (t) => t.replace("Research and plan", "Edited live:"));
		});
		await browser.waitUntil(async () => (await preview.getText()).includes("Edited live:"), {
			timeout: 3000,
			timeoutMsg: "details did not update within 3 s",
		});
		expect(await readVaultFile(DB_PATH)).toBe(dbBefore);
	});

	it("renaming the task and the note keeps the ID; folder renames are tracked", async function () {
		const id = await createTask("Original");
		await browser.executeObsidian(async ({ plugins }, taskId) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const tasks = (plugins as any).logwell.session.app.tasks;
			await tasks.linkNote(taskId, "Projects/Plan.md");
			await tasks.update(taskId, { title: "Renamed task" });
		}, id);
		await browser.executeObsidian(async ({ app }) => {
			const file = app.vault.getFileByPath("Projects/Plan.md");
			if (file === null) throw new Error("missing note");
			await app.fileManager.renameFile(file, "Projects/Plan v2.md");
			const folder = app.vault.getFolderByPath("Projects");
			if (folder === null) throw new Error("missing folder");
			await app.fileManager.renameFile(folder, "Work");
		});
		await browser.waitUntil(
			async () => ((await getTask(id))?.descriptionNote as { path?: string } | null)?.path === "Work/Plan v2.md",
			{ timeout: 5000, timeoutMsg: "note path was not tracked through file + folder rename" },
		);
		expect((await getTask(id))?.title).toBe("Renamed task");
	});

	it("deleting the task and purging Trash leaves the note byte-identical", async function () {
		const original = await readVaultFile("Plan.md");
		const id = await createTask("To delete");
		await browser.executeObsidian(async ({ plugins }, taskId) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const tasks = (plugins as any).logwell.session.app.tasks;
			await tasks.linkNote(taskId, "Plan.md");
			await tasks.delete(taskId);
			await tasks.emptyTrash();
		}, id);
		await flush();
		expect(await getTask(id)).toBeNull();
		expect(await readVaultFile("Plan.md")).toBe(original);
	});

	it("a deleted note leaves the task usable with a missing state", async function () {
		const id = await createTask("Uses Other");
		await browser.executeObsidian(async ({ app, plugins }, taskId) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await (plugins as any).logwell.session.app.tasks.linkNote(taskId, "Notes/Other.md");
			const file = app.vault.getFileByPath("Notes/Other.md");
			if (file === null) throw new Error("missing note");
			await app.vault.delete(file);
		}, id);
		const section = await openTaskDetails(id);
		await expect(section.$(".cp-description.is-missing")).toExist();
		await browser.executeObsidian(async ({ plugins }, taskId) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await (plugins as any).logwell.session.app.tasks.complete(taskId);
		}, id);
		expect((await getTask(id))?.status).toBe("completed");
	});

	it("re-renders a 2,000-line note with embeds in under 150 ms", async function () {
		const timings = await browser.executeObsidian(async ({ app, obsidian }) => {
			const file = app.vault.getFileByPath("Notes/Big note.md");
			if (file === null) throw new Error("missing note");
			const text = await app.vault.cachedRead(file);
			const runs: number[] = [];
			// The first render warms caches; the check is about re-renders on edit.
			for (let i = 0; i < 4; i++) {
				const el = document.createElement("div");
				const component = new obsidian.Component();
				component.load();
				const start = performance.now();
				await obsidian.MarkdownRenderer.render(app, text, el, file.path, component);
				runs.push(performance.now() - start);
				component.unload();
			}
			return runs;
		});
		console.log(`MarkdownRenderer.render on Big note.md (ms): ${timings.map((t) => t.toFixed(0)).join(", ")}`);
		expect(median(timings.slice(1))).toBeLessThan(150); // median re-render
	});
});
