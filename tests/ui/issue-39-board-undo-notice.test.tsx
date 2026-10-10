// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { INBOX_ID, type Task } from "../../src/domain/types";
import { type CalMount, dragTo, item, mountBoard, openBoard, settle, sidebarItem, stubBoardRects } from "./k1a-helpers";

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
