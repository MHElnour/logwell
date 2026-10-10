import { describe, expect, it } from "vitest";
import { DB_PATH, descendant, harness, makeTask } from "./fixtures";

// When close() cannot keep unsaved edits anywhere, it says so
// with its own event. It is not the generic save error, which promises a retry
// that a closed store never makes.

function failConflictWrites(h: ReturnType<typeof harness>, reason = "disk full"): void {
	const write = h.fs.write.bind(h.fs);
	h.fs.write = async (path, data) => {
		if (path.includes("/conflicts/")) throw new Error(reason);
		await write(path, data);
	};
}

describe("close() with edits that cannot be kept (round 5, item 1)", () => {
	it("emits edits-lost with the reason when the file cannot be written and neither can the conflict copy", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("pending"));
		h.fs.failNextWrite((p) => p === DB_PATH);
		failConflictWrites(h);
		await expect(h.store.close()).resolves.toBeUndefined();
		const lost = h.events.filter((e) => e.type === "edits-lost");
		expect(lost).toHaveLength(1);
		expect(lost[0]).toMatchObject({ type: "edits-lost" });
		expect(lost[0]?.type === "edits-lost" && lost[0].message).toContain("disk full");
		expect(h.events.some((e) => e.type === "pending-saved-as-conflict")).toBe(false);
	});

	it("does not report 'could not be kept' as a save error (a closed store never retries)", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("pending"));
		h.fs.failNextWrite((p) => p === DB_PATH);
		failConflictWrites(h);
		await h.store.close();
		const saveErrors = h.events.filter((e) => e.type === "save-error");
		expect(saveErrors.some((e) => /could not be kept/i.test(e.message))).toBe(false);
		expect(h.scheduler.pending).toBe(0);
	});

	it("emits edits-lost when the final save throws on a concurrent change and the copy cannot be written", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("pending"));
		h.fs.files.set(DB_PATH, descendant(h.dbText(), (d) => d, "r-other0000001"));
		failConflictWrites(h);
		await expect(h.store.close()).resolves.toBeUndefined();
		const lost = h.events.filter((e) => e.type === "edits-lost");
		expect(lost).toHaveLength(1);
		expect(lost[0]?.type === "edits-lost" && lost[0].message).toContain("disk full");
	});

	it("emits no edits-lost when the conflict copy is written, or when nothing was pending", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("pending"));
		h.fs.files.delete(DB_PATH);
		await h.store.close();
		expect(h.events.filter((e) => e.type === "pending-saved-as-conflict")).toHaveLength(1);
		expect(h.events.some((e) => e.type === "edits-lost")).toBe(false);

		const clean = harness();
		await clean.store.open();
		await clean.store.close();
		expect(clean.events.some((e) => e.type === "edits-lost")).toBe(false);
	});

	it("emits no edits-lost when the final save succeeds", async () => {
		const h = harness();
		await h.store.open();
		h.addTask(makeTask("pending"));
		await h.store.close();
		expect(h.events.some((e) => e.type === "edits-lost" || e.type === "save-error")).toBe(false);
	});
});
