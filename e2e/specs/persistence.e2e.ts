import { browser, expect } from "@wdio/globals";
import {
	conflictCount,
	createTask,
	DB_PATH,
	flush,
	freshDatabase,
	getTask,
	pause,
	readVaultFile,
	reloadCount,
} from "../helpers";

// The write protocol inside real Obsidian: reloads, conflict copies, damage and renames.
describe("Persistence in Obsidian", function () {
	beforeEach(async function () {
		await freshDatabase();
	});

	it("ignores its own write: no reload, no conflict", async function () {
		const before = await conflictCount();
		const id = await createTask("Self-write check");
		await flush();
		await pause(1500); // let the vault modify event arrive
		expect(await reloadCount()).toBe(0);
		expect(await conflictCount()).toBe(before);
		expect(await readVaultFile(DB_PATH)).toContain(id);
	});

	it("reloads silently on an external fast-forward edit (B39)", async function () {
		const conflictsBefore = await conflictCount();
		const id = await createTask("Original title");
		await flush();
		await browser.executeObsidian(
			async ({ app }, dbPath, taskId) => {
				const file = app.vault.getFileByPath(dbPath);
				if (file === null) throw new Error("missing db");
				await app.vault.process(file, (text) => {
					const db = JSON.parse(text);
					const task = db.tasks.find((t: { id: string }) => t.id === taskId);
					task.title = "Edited elsewhere";
					task.modifiedAt = new Date().toISOString();
					db.history = [...db.history, db.revision].slice(-50);
					db.baseRevision = db.revision;
					db.revision = "r-external0001";
					db.writtenBy = "d-other-device";
					return JSON.stringify(db);
				});
			},
			DB_PATH,
			id,
		);
		await browser.waitUntil(async () => (await getTask(id))?.title === "Edited elsewhere", {
			timeout: 5000,
			timeoutMsg: "external edit was not loaded",
		});
		expect(await conflictCount()).toBe(conflictsBefore);
	});

	it("keeps a conflict copy when an external edit forks from pending changes (B40)", async function () {
		const before = await conflictCount();
		await browser.executeObsidian(
			async ({ app, plugins }, dbPath) => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const session = (plugins as any).logwell.session;
				// A local change that is still pending (not flushed) ...
				await session.app.tasks.create({ title: "Pending local change" });
				// ... while another device writes a different revision.
				const file = app.vault.getFileByPath(dbPath);
				if (file === null) throw new Error("missing db");
				await app.vault.process(file, (text) => {
					const db = JSON.parse(text);
					db.baseRevision = db.revision;
					db.history = [...db.history, db.revision].slice(-50);
					db.revision = "r-fork00000001";
					db.writtenBy = "d-other-device";
					db.tasks.push({
						id: "f0f0f0f0-0000-4000-8000-000000000001",
						title: "From the other device",
						categoryId: "inbox",
						status: "open",
						sortKey: "z",
						createdAt: new Date().toISOString(),
						modifiedAt: new Date().toISOString(),
					});
					return JSON.stringify(db);
				});
			},
			DB_PATH,
		);
		await browser.waitUntil(async () => (await conflictCount()) === before + 1, {
			timeout: 5000,
			timeoutMsg: "no conflict copy was written",
		});
		expect(await getTask("f0f0f0f0-0000-4000-8000-000000000001")).not.toBeNull();
	});

	it("opens read-only on git merge markers and restores a backup (B37)", async function () {
		await createTask("Before the merge");
		await flush();
		await browser.executeObsidian(async ({ app }, dbPath) => {
			const file = app.vault.getFileByPath(dbPath);
			if (file === null) throw new Error("missing db");
			await app.vault.process(file, (text) => {
				const [header, ...rest] = text.split("\n");
				return ["<<<<<<< HEAD", header, "=======", header.replace(/"revision":"[^"]+"/, '"revision":"r-theirs000001"'), ">>>>>>> other", ...rest].join("\n");
			});
		}, DB_PATH);
		await browser.waitUntil(
			async () =>
				browser.executeObsidian(({ plugins }) => {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					return (plugins as any).logwell.session.store.readOnlyState?.reason === "damaged";
				}),
			{ timeout: 5000, timeoutMsg: "database did not become read-only" },
		);
		// Nothing is written while read-only: the markers are still in the file.
		expect(await readVaultFile(DB_PATH)).toContain("<<<<<<< HEAD");
		await browser.executeObsidian(async ({ plugins }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await (plugins as any).logwell.session.restoreRecovered();
		});
		const restored = await readVaultFile(DB_PATH);
		expect(restored).not.toContain("<<<<<<<");
		expect(restored).toContain("Before the merge");
	});

	it("follows a rename of the database file", async function () {
		await browser.executeObsidian(async ({ app }, dbPath) => {
			const file = app.vault.getFileByPath(dbPath);
			if (file === null) throw new Error("missing db");
			await app.fileManager.renameFile(file, "Notes/Renamed.cpbase");
		}, DB_PATH);
		await browser.waitUntil(
			async () =>
				browser.executeObsidian(({ plugins }) => {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					return (plugins as any).logwell.settings.activeDatabasePath === "Notes/Renamed.cpbase";
				}),
			{ timeout: 5000, timeoutMsg: "active database path did not follow the rename" },
		);
	});
});
