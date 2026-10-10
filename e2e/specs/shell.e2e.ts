import { browser, expect } from "@wdio/globals";
import { freshDatabase, DB_PATH } from "../helpers";

// The .cpbase file type and the app shell inside real Obsidian.
describe("App shell and .cpbase file type", function () {
	before(async function () {
		await freshDatabase();
	});

	it("loads the plugin", async function () {
		const loaded = await browser.executeObsidian(({ plugins }) => "logwell" in plugins);
		expect(loaded).toBe(true);
	});

	it("crypto.randomUUID is available in the renderer (spec §2)", async function () {
		const id = await browser.execute(() => crypto.randomUUID());
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	it("shows Checkpoint.cpbase in the file explorer (registered extension)", async function () {
		const item = browser.$(`.nav-file-title[data-path="${DB_PATH}"]`);
		await expect(item).toExist();
	});

	it("opens the app when the database file is opened", async function () {
		await browser.executeObsidian(async ({ app }, p) => {
			const file = app.vault.getFileByPath(p);
			if (file === null) throw new Error("database file missing");
			await app.workspace.getLeaf("tab").openFile(file);
		}, DB_PATH);
		const viewType = await browser.executeObsidian(({ app }) => app.workspace.getMostRecentLeaf()?.view.getViewType());
		expect(viewType).toBe("checkpoint-app");
	});
});
