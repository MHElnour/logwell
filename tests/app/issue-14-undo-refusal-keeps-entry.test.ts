import { describe, expect, it } from "vitest";
import { appHarness, makeReadOnly } from "./harness";

// Data and safety rule 17: a refusal while read-only keeps the undo entry; a conflict drops it, since the
// record can never match again, and the next undo takes the one before it.

describe("#14: a refused undo and its entry", () => {
	it("keeps the entry when the database is read-only, however often Undo is pressed", async () => {
		const h = await appHarness();
		await h.app.tasks.create({ title: "Call the bank" });
		await makeReadOnly(h);
		const store = h.app.store;
		await expect(store.undo()).rejects.toMatchObject({ code: "ReadOnly" });
		await expect(store.undo()).rejects.toMatchObject({ code: "ReadOnly" });
		expect(store.canUndo).toBe(true);
		expect(store.undoLabel).toBe("Create task");
	});

	it("resolves null for an empty history, also while read-only", async () => {
		const h = await appHarness();
		await makeReadOnly(h);
		await expect(h.app.store.undo()).resolves.toBeNull();
	});

	it("drops the entry on a conflict, so the next undo takes the one before it", async () => {
		const h = await appHarness();
		const store = h.app.store;
		const { task } = await h.app.tasks.create({ title: "Call the bank" });
		await h.app.tasks.update(task.id, { title: "Call the bank today" });
		// A write that is not a user action (no undo entry) replaces the record.
		await store.run(
			"Maintenance",
			(tx) => {
				const t = tx.get("tasks", task.id)!;
				tx.put("tasks", { ...t, title: "Changed outside" });
			},
			{ undoable: false },
		);
		await expect(store.undo()).rejects.toMatchObject({ code: "UndoConflict" });
		expect(store.state.tasks.get(task.id)?.title).toBe("Changed outside");
		expect(store.undoLabel).toBe("Create task");
	});
});
