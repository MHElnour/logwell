// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { INBOX_ID, type Task } from "../../src/domain/types";
import { deleteTask, duplicateTask } from "../../src/ui/actions";
import { type CalMount, dragTo, item, mountBoard, openBoard, settle, sidebarItem, stubBoardRects } from "./k1a-helpers";
import type { WriteResult } from "../../src/app/writes";
import type { UiHost } from "../../src/ui/host";
import { runWrite } from "../../src/ui/writeNotice";

describe("through the board", () => {
	// Data and safety rule 17, through the board: two moves run under the same store label ("Move task"); the
	// first move's notice must not undo the second.

	const mounted: CalMount[] = [];

	afterEach(() => {
		for (const m of mounted.splice(0)) m.unmount();
	});

	interface Shown {
		message: string;
		label: string;
		undo: () => Promise<boolean>;
	}

	/** Records each notice and binds its Undo the way the Obsidian host does (`store.undoFor`). */
	async function mount(): Promise<{ m: CalMount; shown: Shown[] }> {
		const m = await mountBoard();
		mounted.push(m);
		const shown: Shown[] = [];
		Object.assign(m.host, {
			notifyUndo: (message: string, label: string, mark: number) => void shown.push({ message, label, undo: m.h.app.store.undoFor(mark, label) }),
		});
		const alpha = await m.h.app.sections.create(INBOX_ID, "Alpha");
		await m.h.app.sections.create(INBOX_ID, "Beta");
		await m.h.app.tasks.create({ title: "Call the bank", sectionId: alpha.id });
		await m.h.app.tasks.create({ title: "Water the plants", sectionId: alpha.id });
		await settle();
		await openBoard(m, "Inbox");
		return { m, shown };
	}

	const taskOf = (m: CalMount, title: string): Task => [...m.h.app.store.state.tasks.values()].find((t) => t.title === title)!;
	const sectionId = (m: CalMount, name: string) => [...m.h.app.store.state.sections.values()].find((s) => s.name === name)!.id;

	describe("#39: the Undo of a task notice", () => {
		it("Delete: the notice's Undo brings the task back", async () => {
			const m = await mountBoard();
			mounted.push(m);
			const { task } = await m.h.app.tasks.create({ title: "Call the bank" });
			await expect(deleteTask(m.host, task)).resolves.toBe(true);
			expect(m.h.app.store.state.tasks.has(task.id)).toBe(false);
			await expect(m.host.undoButtons.at(-1)!()).resolves.toBe(true);
			expect(m.h.app.store.state.tasks.has(task.id)).toBe(true);
		});

		it("Duplicate: the notice's Undo removes the copy", async () => {
			const m = await mountBoard();
			mounted.push(m);
			const { task } = await m.h.app.tasks.create({ title: "Call the bank" });
			const copy = await duplicateTask(m.host, task);
			expect(m.h.app.store.state.tasks.has(copy!.id)).toBe(true);
			await expect(m.host.undoButtons.at(-1)!()).resolves.toBe(true);
			expect(m.h.app.store.state.tasks.has(copy!.id)).toBe(false);
			expect(m.h.app.store.state.tasks.has(task.id)).toBe(true);
		});
	});

	describe("#39: the Undo of a tag delete notice", () => {
		async function tagMenu(m: CalMount, name: string) {
			const row = [...m.root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((r) => r.querySelector(".cp-sidebar-label")?.textContent === name)!;
			row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
			await settle();
			const del = m.host.menus.at(-1)!.find((i) => i !== "separator" && i.title === "Delete");
			if (del === undefined || del === "separator") throw new Error("no Delete item");
			return del;
		}

		it("Delete: the notice's Undo brings the tag back on its task", async () => {
			const m = await mountBoard();
			mounted.push(m);
			const { task } = await m.h.app.tasks.create({ title: "Call the bank", newTags: ["Errands"] });
			await settle();
			m.host.choose = (async () => true) as unknown as typeof m.host.choose;
			(await tagMenu(m, "Errands")).run();
			await settle();
			expect(m.h.app.store.state.tags.has("errands")).toBe(false);
			expect(m.host.messages.at(-1)).toBe("Deleted tag @Errands.");
			await expect(m.host.undoButtons.at(-1)!()).resolves.toBe(true);
			expect(m.h.app.store.state.tags.has("errands")).toBe(true);
			expect(m.h.app.store.state.tasks.get(task.id)!.tagKeys).toEqual(["errands"]);
		});

		it("shows no notice when the tag was already gone and unused", async () => {
			const m = await mountBoard();
			mounted.push(m);
			await m.h.app.tags.create("Errands");
			await settle();
			m.host.choose = (async () => true) as unknown as typeof m.host.choose;
			const del = await tagMenu(m, "Errands");
			// Deleted elsewhere while the menu was open.
			await m.h.app.tags.delete("errands");
			const before = m.host.undoButtons.length;
			del.run();
			await settle();
			expect(m.host.undoButtons).toHaveLength(before);
			expect(m.host.messages).not.toContain("Deleted tag @Errands.");
		});
	});

	describe("#39: the Undo of a list delete notice", () => {
		it("restores the list, through the notice's own Undo", async () => {
			const m = await mountBoard();
			mounted.push(m);
			const work = await m.h.app.categories.create("Work");
			await settle();
			m.host.choose = (async () => true) as unknown as typeof m.host.choose;
			sidebarItem(m.root, "Work").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
			const del = m.host.menus.at(-1)!.find((i) => i !== "separator" && i.title === "Delete");
			if (del === undefined || del === "separator") throw new Error("no Delete item");
			del.run();
			await settle();
			expect(m.h.app.store.state.categories.has(work.id)).toBe(false);
			await expect(m.host.undoButtons.at(-1)!()).resolves.toBe(true);
			expect(m.h.app.store.state.categories.has(work.id)).toBe(true);
		});
	});

	describe("#39: the Undo of a board move notice", () => {
		it("undoes only its own move, not a newer move made the same way", async () => {
			const { m, shown } = await mount();
			const beta = sectionId(m, "Beta");
			const alpha = sectionId(m, "Alpha");
			let r = stubBoardRects(m.root);
			await dragTo(item(m.root, "Call the bank"), r.card("Call the bank"), r.columns[beta]!);
			r = stubBoardRects(m.root);
			await dragTo(item(m.root, "Water the plants"), r.card("Water the plants"), r.columns[beta]!);
			expect(shown.map((s) => s.label)).toEqual(["Move task", "Move task"]);

			await expect(shown[0]!.undo()).rejects.toMatchObject({ code: "UndoConflict" });
			expect(taskOf(m, "Call the bank").sectionId).toBe(beta);
			expect(taskOf(m, "Water the plants").sectionId).toBe(beta);

			await expect(shown[1]!.undo()).resolves.toBe(true);
			expect(taskOf(m, "Water the plants").sectionId).toBe(alpha);
			expect(taskOf(m, "Call the bank").sectionId).toBe(beta);
		});
	});
});

describe("runWrite", () => {
	// Issue 43: one write runner for the habit and repeating-task writes: Undo notice only when something was
	// written, errors to the host.

	function fakeHost(mark = 7) {
		const notifyUndo = vi.fn();
		const error = vi.fn();
		const host = { app: { store: { undoMark: () => mark } }, notifyUndo, error } as unknown as UiHost;
		return { host, notifyUndo, error };
	}

	describe("runWrite", () => {
		it("shows a string message with the label of the write and the mark taken before it", async () => {
			const { host, notifyUndo } = fakeHost(7);
			const ok = await runWrite(host, async () => ({ wrote: true, label: "Edit habit" }), "Saved.");
			expect(ok).toBe(true);
			expect(notifyUndo).toHaveBeenCalledWith("Saved.", "Edit habit", 7);
		});

		it("builds the message from the result when given a function", async () => {
			const { host, notifyUndo } = fakeHost();
			const result: WriteResult = { wrote: true, label: "Complete task" };
			const message = vi.fn((r: WriteResult) => `Done under ${r.label}.`);
			await runWrite(host, async () => result, message);
			expect(message).toHaveBeenCalledWith(result);
			expect(notifyUndo).toHaveBeenCalledWith("Done under Complete task.", "Complete task", 7);
		});

		it("shows no notice when nothing was written, and still succeeds", async () => {
			const { host, notifyUndo } = fakeHost();
			const ok = await runWrite(host, async () => ({ wrote: false, label: "Edit habit" }), "Saved.");
			expect(ok).toBe(true);
			expect(notifyUndo).not.toHaveBeenCalled();
		});

		it("reports a failing write to the host and resolves false", async () => {
			const { host, notifyUndo, error } = fakeHost();
			const err = new Error("boom");
			const ok = await runWrite(host, () => Promise.reject(err), "Saved.");
			expect(ok).toBe(false);
			expect(error).toHaveBeenCalledWith(err);
			expect(notifyUndo).not.toHaveBeenCalled();
		});
	});
});
