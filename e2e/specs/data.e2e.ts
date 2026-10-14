import { browser, expect } from "@wdio/globals";
import { conflictCount, createTask, DB_PATH, flush, freshDatabase, getTask, readVaultFile } from "../helpers";

// Backup export and import, and compare-and-swap saves, in real Obsidian.
describe("Data portability and write safety", function () {
	beforeEach(async function () {
		await freshDatabase();
	});

	it("export, then Replace-all import into a new database, reproduces every record", async function () {
		const id = await createTask("Exported task", { urgent: true });
		await flush();
		const result = await browser.executeObsidian(async ({ app, plugins }, taskId) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const plugin = (plugins as any).logwell;
			const exported: string = plugin.session.app.data.exportJson();
			// A second, empty database: copy the seed with a new dbId and no tasks.
			const seed = await app.vault.adapter.read("Checkpoint.cpbase");
			const empty = JSON.parse(seed);
			empty.dbId = crypto.randomUUID();
			empty.tasks = [];
			await app.vault.create("Second.cpbase", JSON.stringify(empty));
			await plugin.setActiveDatabase("Second.cpbase");
			await plugin.ready();
			const preview = plugin.session.app.data.previewImport(exported);
			if (!preview.ok) throw new Error(preview.message);
			await plugin.session.app.data.importReplace(preview.preview);
			await plugin.session.store.flush();
			return plugin.session.app.store.state.tasks.has(taskId) as boolean;
		}, id);
		expect(result).toBe(true);
		expect((await getTask(id))?.urgent).toBe(true);
		expect(await readVaultFile("Second.cpbase")).toContain(id);
	});

	it("an external write that lands before a pending save is never overwritten", async function () {
		const before = await conflictCount();
		await browser.executeObsidian(async ({ app, plugins }, dbPath) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const session = (plugins as any).logwell.session;
			await session.app.tasks.create({ title: "Pending local edit" });
			// Another writer (git pull) replaces the file on disk, bypassing the vault...
			const text = await app.vault.adapter.read(dbPath);
			const db = JSON.parse(text);
			db.baseRevision = db.revision;
			db.history = [...db.history, db.revision].slice(-50);
			db.revision = "r-gitpull00001";
			db.writtenBy = "d-other-device";
			db.tasks.push({
				id: "a1a1a1a1-0000-4000-8000-000000000001",
				title: "Pulled from git",
				categoryId: "inbox",
				status: "open",
				sortKey: "z",
				createdAt: new Date().toISOString(),
				modifiedAt: new Date().toISOString(),
			});
			await app.vault.adapter.write(dbPath, JSON.stringify(db));
			// ...and our save runs before the modify event is handled.
			await session.store.flush();
		}, DB_PATH);
		await browser.pause(1500);
		// The pulled task must survive on disk, and our pending edit must be kept somewhere.
		expect(await readVaultFile(DB_PATH)).toContain("Pulled from git");
		expect(await conflictCount()).toBe(before + 1);
	});
});
