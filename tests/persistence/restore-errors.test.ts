import { describe, expect, it } from "vitest";
import { BACKUP_ROOT, harness } from "./fixtures";

// The errors "Restore" and "Keep mine" show when the chosen file is gone or unreadable.

const SNAPSHOTS = `${BACKUP_ROOT}/db-1/snapshots`;
const CONFLICTS = `${BACKUP_ROOT}/db-1/conflicts`;

describe("restoreSnapshot and keepMine refuse a missing or unreadable file", () => {
	it("restoreSnapshot: a missing backup file", async () => {
		const h = harness();
		await h.store.open();
		await expect(h.store.restoreSnapshot(`${SNAPSHOTS}/gone.cpbase`)).rejects.toThrow("The backup file no longer exists.");
	});

	it("restoreSnapshot: an unreadable backup file", async () => {
		const h = harness();
		await h.store.open();
		h.fs.files.set(`${SNAPSHOTS}/bad.cpbase`, "not json");
		await expect(h.store.restoreSnapshot(`${SNAPSHOTS}/bad.cpbase`)).rejects.toThrow("The backup file cannot be read.");
	});

	it("keepMine: a missing conflict copy", async () => {
		const h = harness();
		await h.store.open();
		await expect(h.store.keepMine(`${CONFLICTS}/gone.cpbase`)).rejects.toThrow("The conflict copy no longer exists.");
	});

	it("keepMine: an unreadable conflict copy, which stays in the open list", async () => {
		const h = harness();
		await h.store.open();
		h.fs.files.set(`${CONFLICTS}/bad.cpbase`, "not json");
		await expect(h.store.keepMine(`${CONFLICTS}/bad.cpbase`)).rejects.toThrow("The conflict copy cannot be read.");
		expect(h.fs.files.has(`${CONFLICTS}/bad.cpbase`)).toBe(true);
	});
});
