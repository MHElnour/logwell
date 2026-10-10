import { describe, expect, it } from "vitest";
import type { AppStore } from "../../src/app/store";
import { appHarness } from "./harness";

// Data and safety rule 17: the Undo button of a notice undoes exactly the write it was shown for, never a newer
// write that happens to run under the same store label.

const CONFLICT = 'Cannot undo "Edit task": other changes were made since.';

/** What a notice does: take the mark right before the write, bind its Undo right after. */
async function noticeFor(store: AppStore, label: string, write: () => Promise<unknown>): Promise<() => Promise<boolean>> {
	const mark = store.undoMark();
	await write();
	return store.undoFor(mark, label);
}

async function twoTasks() {
	const h = await appHarness();
	const a = (await h.app.tasks.create({ title: "Call the bank" })).task;
	const b = (await h.app.tasks.create({ title: "Water the plants" })).task;
	const title = (id: string) => h.app.store.state.tasks.get(id)?.title;
	return { h, store: h.app.store, a, b, title };
}

describe("#39: a notice's Undo targets its own write", () => {
	it("refuses the first notice once a newer write ran under the same label, and undoes the newer one from its own notice", async () => {
		const { h, store, a, b, title } = await twoTasks();
		const undoFirst = await noticeFor(store, "Edit task", () => h.app.tasks.update(a.id, { title: "Call the bank today" }));
		const undoSecond = await noticeFor(store, "Edit task", () => h.app.tasks.update(b.id, { title: "Water the herbs" }));

		await expect(undoFirst()).rejects.toMatchObject({ code: "UndoConflict", message: CONFLICT });
		expect(title(a.id)).toBe("Call the bank today");
		expect(title(b.id)).toBe("Water the herbs");

		await expect(undoSecond()).resolves.toBe(true);
		expect(title(b.id)).toBe("Water the plants");
		expect(title(a.id)).toBe("Call the bank today");
	});

	it("checks inside the queue: an Undo queued behind a same-label command does not revert that command", async () => {
		const { h, store, a, b, title } = await twoTasks();
		const undoFirst = await noticeFor(store, "Edit task", () => h.app.tasks.update(a.id, { title: "Call the bank today" }));
		// The second write is queued, not yet run, when the Undo is pressed.
		const second = h.app.tasks.update(b.id, { title: "Water the herbs" });
		const undo = undoFirst();
		await second;
		await expect(undo).rejects.toMatchObject({ code: "UndoConflict" });
		expect(title(a.id)).toBe("Call the bank today");
		expect(title(b.id)).toBe("Water the herbs");
	});

	it("refuses when a same-label write ran between the write and its notice", async () => {
		const { h, store, a, b, title } = await twoTasks();
		const mark = store.undoMark();
		const first = h.app.tasks.update(a.id, { title: "Call the bank today" });
		const second = h.app.tasks.update(b.id, { title: "Water the herbs" });
		await Promise.all([first, second]);
		// The first write's notice shows only now, after the second write ran.
		await expect(store.undoFor(mark, "Edit task")()).rejects.toMatchObject({ code: "UndoConflict" });
		expect(title(a.id)).toBe("Call the bank today");
		expect(title(b.id)).toBe("Water the herbs");
	});

	it("refuses after the entry is gone (undone with the global command), even when a newer same-label write follows", async () => {
		const { h, store, a, b, title } = await twoTasks();
		const undoFirst = await noticeFor(store, "Edit task", () => h.app.tasks.update(a.id, { title: "Call the bank today" }));
		await store.undo();
		await h.app.tasks.update(b.id, { title: "Water the herbs" });
		await expect(undoFirst()).rejects.toMatchObject({ code: "UndoConflict" });
		expect(title(b.id)).toBe("Water the herbs");
	});

	it("label-only undo checks inside the queue too: it does not revert a command queued before it", async () => {
		const { h, store, a, b, title } = await twoTasks();
		await h.app.tasks.update(a.id, { title: "Call the bank today" });
		const second = h.app.tasks.delete(b.id);
		const undo = store.undoIfLatest("Edit task");
		await second;
		await expect(undo).rejects.toMatchObject({ code: "UndoConflict" });
		expect(title(a.id)).toBe("Call the bank today");
		expect(title(b.id)).toBeUndefined();
	});
});
