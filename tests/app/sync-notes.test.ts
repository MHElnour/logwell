import { describe, expect, it } from "vitest";
import { TICKTICK_LINKS_LABEL } from "../../src/app/SyncService";
import { readNote } from "../../src/domain/ticktick/noteText";
import { MERGE_MARKER } from "../../src/domain/textMerge";
import { syncLinkId } from "../../src/domain/types";
import { type SyncHarness, linkedList, syncHarness } from "./sync-harness";

// With "Create notes from TickTick descriptions" on, TickTick's text of a synced task becomes
// a description note the sync created, and the two stay in step: up without frontmatter and with links as text,
// down keeping the frontmatter, a checklist as tick boxes, a three-way merge when both sides changed. A note the user
// linked is never read, written or sent.

async function ready(): Promise<SyncHarness & { listId: string; projectId: string }> {
	const s = await syncHarness();
	const { listId, projectId } = await linkedList(s);
	return Object.assign(s, { listId, projectId });
}

async function run(s: SyncHarness) {
	const r = await s.sync.sync();
	if (!r.ok) throw new Error(`sync failed: ${r.error?.message}`);
	s.tick();
	return r;
}

function noteOf(s: SyncHarness, title: string): string {
	const path = s.task(title).descriptionNote?.path;
	if (path === undefined) throw new Error(`"${title}" has no note`);
	return path;
}

describe("description notes from TickTick (SYNC-09)", () => {
	it("a pulled task with TickTick text gets a note in the note folder, linked by the sync; nothing is sent back", async () => {
		const s = await ready();
		s.notesOn = true;
		s.tt.add(s.projectId, { title: "Trip: Rome / Pisa", content: "Pack the bags\nBook a table" });
		await run(s);
		const path = noteOf(s, "Trip: Rome / Pisa");
		expect(path).toBe("Task notes/Trip Rome Pisa.md");
		expect(s.h.notes.files.get(path)).toBe("Pack the bags\nBook a table\n");
		const link = s.link("task", s.task("Trip: Rome / Pisa").id)!;
		expect(link).toMatchObject({ noteBySync: true, noteBase: "Pack the bags\nBook a table" });
		expect(s.tt.count("updateTask") + s.tt.count("batchTasks")).toBe(0);
	});

	it("takes a free name when the note name is taken (B45)", async () => {
		const s = await ready();
		s.notesOn = true;
		s.h.notes.set("Task notes/Call the bank.md", "mine");
		s.tt.add(s.projectId, { title: "Call the bank", content: "Ask about fees" });
		await run(s);
		expect(noteOf(s, "Call the bank")).toBe("Task notes/Call the bank (2).md");
		expect(s.h.notes.files.get("Task notes/Call the bank.md")).toBe("mine");
	});

	it("with the setting off, no note is made, read or written, and the text stays in TickTick", async () => {
		const s = await ready();
		const made = s.tt.add(s.projectId, { title: "Call the bank", content: "Ask about fees" });
		await run(s);
		expect(s.task("Call the bank").descriptionNote).toBeNull();
		expect(s.h.notes.writes).toEqual([]);
		expect(s.h.notes.reads).toEqual([]);
		expect(s.tt.get(made.id)!.content).toBe("Ask about fees");
	});

	it("a task with no text gets no note; text that appears later in TickTick makes one", async () => {
		const s = await ready();
		s.notesOn = true;
		const made = s.tt.add(s.projectId, { title: "Water the plants" });
		await run(s);
		expect(s.task("Water the plants").descriptionNote).toBeNull();
		s.tt.edit(made.id, { content: "Twice a week" });
		await run(s);
		expect(s.h.notes.files.get(noteOf(s, "Water the plants"))).toBe("Twice a week\n");
	});

	it("a task created in Logwell gets a note once TickTick has text for it", async () => {
		const s = await ready();
		s.notesOn = true;
		await s.h.app.tasks.create({ title: "Buy milk", categoryId: s.listId });
		await run(s);
		s.tt.edit(s.ttIdOf("Buy milk"), { content: "Oat, two cartons" });
		await run(s);
		expect(s.h.notes.files.get(noteOf(s, "Buy milk"))).toBe("Oat, two cartons\n");
	});

	it("a note the user linked is never read, written or sent, and TickTick's text is left as it is", async () => {
		const s = await ready();
		s.notesOn = true;
		const made = s.tt.add(s.projectId, { title: "Plan the week" });
		await run(s);
		s.h.notes.set("Mine/Week.md", "My own plan");
		await s.h.app.tasks.linkNote(s.task("Plan the week").id, "Mine/Week.md");
		s.tt.edit(made.id, { content: "TickTick text" });
		await run(s);
		s.h.notes.set("Mine/Week.md", "My own plan, changed");
		await run(s);
		expect(s.h.notes.files.get("Mine/Week.md")).toBe("My own plan, changed");
		expect(s.h.notes.reads).toEqual([]);
		expect(s.h.notes.writes).toEqual([]);
		expect(s.tt.get(made.id)!.content).toBe("TickTick text");
		expect(s.link("task", s.task("Plan the week").id)!.noteBySync).toBe(false);
	});

	it("never sends content for a task whose note the sync did not create", async () => {
		const s = await ready();
		s.notesOn = true;
		const t = await s.h.app.tasks.create({ title: "Pay rent", categoryId: s.listId, notePath: "Mine/Rent.md" });
		s.h.notes.set("Mine/Rent.md", "Landlord details");
		await run(s);
		const copy = s.tt.get(s.ttIdOf("Pay rent"))!;
		expect(copy.content).toBeUndefined();
		expect(s.link("task", t.task.id)!.noteBySync).toBe(false);
	});
});

describe("keeping a sync-created note and TickTick in step (SYNC-09)", () => {
	async function withNote(content = "Pack the bags\nBook a table") {
		const s = await ready();
		s.notesOn = true;
		const made = s.tt.add(s.projectId, { title: "Trip", content });
		await run(s);
		return { s, ttId: made.id, path: noteOf(s, "Trip"), id: s.task("Trip").id };
	}

	it("an edit of the note goes up, without the frontmatter, links as their text, embeds dropped", async () => {
		const { s, ttId, path, id } = await withNote();
		s.h.notes.set(path, "---\ntags: [travel]\n---\nPack the bags\nBook [[Roma|a table]] at [[Da Enzo]]\n![[map.png]]\n");
		const writes = s.h.notes.writes.length;
		await run(s);
		expect(s.tt.get(ttId)!.content).toBe("Pack the bags\nBook a table at Da Enzo");
		expect(s.link("task", id)!.noteBase).toBe("Pack the bags\nBook a table at Da Enzo");
		// The note is not written back.
		expect(s.h.notes.writes.length).toBe(writes);
	});

	it("an edit in TickTick replaces the body, keeps the frontmatter, and keeps links on lines it did not change", async () => {
		const { s, ttId, path } = await withNote();
		s.h.notes.set(path, "---\ntags: [travel]\n---\nPack [[Bags|the bags]]\n![[map.png]]\nBook a table\n");
		await run(s);
		s.tt.edit(ttId, { content: "Pack the bags\nBook a table for four" });
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("---\ntags: [travel]\n---\nPack [[Bags|the bags]]\n![[map.png]]\nBook a table for four\n");
		expect(s.tt.get(ttId)!.content).toBe("Pack the bags\nBook a table for four");
	});

	it("both sides changed different lines: both apply, on both sides, in one sync", async () => {
		const { s, ttId, path, id } = await withNote("one\ntwo\nthree");
		s.h.notes.set(path, "ONE\ntwo\nthree\n");
		s.tt.edit(ttId, { content: "one\ntwo\nTHREE" });
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("ONE\ntwo\nTHREE\n");
		expect(s.tt.get(ttId)!.content).toBe("ONE\ntwo\nTHREE");
		expect(s.link("task", id)!.noteBase).toBe("ONE\ntwo\nTHREE");
		const calls = s.tt.calls.length;
		const writes = s.h.notes.writes.length;
		await run(s);
		expect(s.tt.calls.slice(calls).filter((c) => !c.startsWith("getProjectData") && !c.startsWith("listCompleted"))).toEqual([]);
		expect(s.h.notes.writes.length).toBe(writes);
	});

	it("both sides changed the same line: Logwell's stays, TickTick's follows after the marker, and both sides end the same", async () => {
		const { s, ttId, path } = await withNote("one\ntwo\nthree");
		s.h.notes.set(path, "one\ntwo, mine\nthree\n");
		s.tt.edit(ttId, { content: "one\ntwo, theirs\nthree" });
		await run(s);
		const merged = `one\ntwo, mine\n${MERGE_MARKER}\ntwo, theirs\nthree`;
		expect(s.h.notes.files.get(path)).toBe(`${merged}\n`);
		expect(s.tt.get(ttId)!.content).toBe(merged);
		const pushes = s.tt.count("updateTask");
		await run(s);
		expect(s.tt.count("updateTask")).toBe(pushes);
	});

	it("a note edited while the sync writes it is not overwritten; the next sync merges it", async () => {
		const { s, ttId, path } = await withNote("one");
		s.tt.edit(ttId, { content: "one\ntwo" });
		s.h.notes.beforeReplace = (p) => {
			s.h.notes.set(p, "one, edited just now\n");
			s.h.notes.beforeReplace = null;
		};
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("one, edited just now\n");
		expect(s.tt.get(ttId)!.content).toBe("one\ntwo");
		await run(s);
		// The edit changed the first line, TickTick added a second: both apply.
		expect(s.h.notes.files.get(path)).toBe("one, edited just now\ntwo\n");
		expect(s.tt.get(ttId)!.content).toBe("one, edited just now\ntwo");
	});

	it("reads the note only when it or TickTick's text changed", async () => {
		const { s, ttId, path } = await withNote();
		const reads = s.h.notes.reads.length;
		await run(s);
		await run(s);
		expect(s.h.notes.reads.length).toBe(reads);
		s.h.notes.set(path, "Pack the bags\n");
		await run(s);
		expect(s.h.notes.reads.length).toBe(reads + 1);
		s.tt.edit(ttId, { title: "Trip to Rome" });
		await run(s);
		expect(s.h.notes.reads.length).toBe(reads + 1);
	});

	it("a deleted note is unlinked from the sync and never made again", async () => {
		const { s, ttId, path, id } = await withNote();
		s.h.notes.delete(path);
		await run(s);
		expect(s.link("task", id)).toMatchObject({ noteBySync: false, noteBase: "" });
		// The task keeps its (missing) note, as for any deleted note.
		expect(s.task("Trip").descriptionNote?.path).toBe(path);
		s.tt.edit(ttId, { content: "New text" });
		await run(s);
		expect(s.h.notes.exists(path)).toBe(false);
		expect([...s.h.notes.files.keys()]).toEqual([]);
		expect(s.tt.get(ttId)!.content).toBe("New text");
	});

	it("a note the user unlinks is no longer written and no new one is made", async () => {
		const { s, ttId, path, id } = await withNote();
		await s.h.app.tasks.unlinkNote(id);
		expect(s.link("task", id)).toMatchObject({ noteBySync: false, noteBase: "" });
		s.tt.edit(ttId, { content: "New text" });
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("Pack the bags\nBook a table\n");
		expect(s.task("Trip").descriptionNote).toBeNull();
		expect(s.h.notes.files.size).toBe(1);
	});

	it("undoing the unlink makes the sync write the note again", async () => {
		const { s, ttId, path, id } = await withNote();
		await s.h.app.tasks.unlinkNote(id);
		await s.h.app.store.undo();
		expect(s.link("task", id)!.noteBySync).toBe(true);
		s.tt.edit(ttId, { content: "New text" });
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("New text\n");
	});

	it("a renamed note is followed (NOTE-06)", async () => {
		const { s, ttId, path } = await withNote();
		s.h.notes.rename(path, "Travel/Rome trip.md");
		await s.h.app.tasks.rewriteNotePaths(path, "Travel/Rome trip.md", false);
		s.tt.edit(ttId, { content: "Renamed and edited" });
		await run(s);
		expect(s.h.notes.files.get("Travel/Rome trip.md")).toBe("Renamed and edited\n");
		expect(s.h.notes.exists(path)).toBe(false);
	});

	it("with the setting turned off, nothing is read, written or sent; turned on again, the edits of both sides merge", async () => {
		const { s, ttId, path } = await withNote("one\ntwo");
		s.notesOn = false;
		s.h.notes.set(path, "ONE\ntwo\n");
		s.tt.edit(ttId, { content: "one\nTWO" });
		const reads = s.h.notes.reads.length;
		const writes = s.h.notes.writes.length;
		await run(s);
		expect(s.h.notes.reads.length).toBe(reads);
		expect(s.h.notes.writes.length).toBe(writes);
		expect(s.tt.get(ttId)!.content).toBe("one\nTWO");
		s.notesOn = true;
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("ONE\nTWO\n");
		expect(s.tt.get(ttId)!.content).toBe("ONE\nTWO");
	});

	it("a note push that fails is sent again by the next sync, with no second marker", async () => {
		const { s, ttId, path } = await withNote("one");
		s.h.notes.set(path, "one, mine\n");
		s.tt.edit(ttId, { content: "one, theirs" });
		const { TickTickError } = await import("../../src/app/ports");
		s.tt.fail("updateTask", new TickTickError("server", "TickTick: server error (HTTP 500)", { status: 500 }));
		const r = await s.sync.sync();
		expect(r.ok).toBe(false);
		s.tick();
		const merged = `one, mine\n${MERGE_MARKER}\none, theirs`;
		expect(s.h.notes.files.get(path)).toBe(`${merged}\n`);
		await run(s);
		expect(s.tt.get(ttId)!.content).toBe(merged);
		expect(s.h.notes.files.get(path)).toBe(`${merged}\n`);
	});

	it("a session that stops before the notes writes no note", async () => {
		const { s, ttId, path } = await withNote("one");
		s.tt.edit(ttId, { content: "two" });
		s.tt.onCall = (method) => {
			if (method === "getProjectData") s.sync.stop();
		};
		await s.sync.sync();
		expect(s.h.notes.files.get(path)).toBe("one\n");
	});
});

describe("checklists as tick boxes, both ways (SYNC-09)", () => {
	const ITEM_FIELDS = { sortOrder: 0, startDate: "2026-10-09T08:00:00.000+0000", isAllDay: false, timeZone: "Europe/Moscow" };
	async function trip() {
		const s = await ready();
		s.notesOn = true;
		const made = s.tt.add(s.projectId, {
			title: "Trip",
			kind: "CHECKLIST",
			desc: "Trip notes go here.",
			items: [
				{ id: "i1", title: "Bring passport", status: 0, ...ITEM_FIELDS },
				{ id: "i2", title: "Print ticket", status: 0, ...ITEM_FIELDS },
			],
		});
		await run(s);
		return { s, ttId: made.id, path: noteOf(s, "Trip"), id: s.task("Trip").id };
	}
	const itemsOf = (s: SyncHarness, ttId: string) => s.tt.get(ttId)!.items!.map((i) => [i.title, i.status]);

	it("comes down as the text and a tick box per item; the base keeps the item lines, no ids", async () => {
		const { s, path, id } = await trip();
		expect(s.h.notes.files.get(path)).toBe("Trip notes go here.\n\n- [ ] Bring passport\n- [ ] Print ticket\n");
		expect(s.link("task", id)).toMatchObject({ noteBase: "Trip notes go here.", noteItems: ["- [ ] Bring passport", "- [ ] Print ticket"] });
	});

	it("ticking, adding and removing lines in the note changes the items in TickTick", async () => {
		const { s, ttId, path, id } = await trip();
		s.h.notes.set(path, "Trip notes go here.\n\n- [x] Print ticket\n- [ ] Pack charger\n");
		await run(s);
		expect(itemsOf(s, ttId)).toEqual([
			["Print ticket", 1],
			["Pack charger", 0],
		]);
		expect(s.link("task", id)!.noteItems).toEqual(["- [x] Print ticket", "- [ ] Pack charger"]);
		expect(s.tt.get(ttId)!.desc).toBe("Trip notes go here.");
		expect(s.tt.get(ttId)!.content).toBeUndefined();
	});

	it("sends each item with every field TickTick gave it (an update erases what it leaves out) (M3)", async () => {
		const { s, ttId, path } = await trip();
		s.h.notes.set(path, "Trip notes go here.\n\n- [x] Bring passport\n- [ ] Print ticket\n- [ ] Pack charger\n");
		await run(s);
		const sent = s.tt.sentItems.at(-1) as Record<string, unknown>[];
		expect(sent[0]).toMatchObject({ title: "Bring passport", status: 1, ...ITEM_FIELDS });
		expect(sent[1]).toMatchObject({ title: "Print ticket", status: 0, ...ITEM_FIELDS });
		expect(sent[2]).toEqual({ title: "Pack charger", status: 0 });
		expect(s.tt.get(ttId)!.items![0]).toMatchObject(ITEM_FIELDS);
	});

	it("items whose ids TickTick changed since (every update does) still match by their text", async () => {
		const { s, ttId, path } = await trip();
		// A title edit there renews every item id.
		s.tt.edit(ttId, { title: "Trip to Rome" });
		await run(s);
		s.h.notes.set(path, "Trip notes go here.\n\n- [x] Bring passport\n- [ ] Print ticket\n");
		await run(s);
		expect(itemsOf(s, ttId)).toEqual([
			["Bring passport", 1],
			["Print ticket", 0],
		]);
		expect(s.tt.get(ttId)!.items![0]).toMatchObject(ITEM_FIELDS);
		const calls = s.tt.count("updateTask");
		await run(s);
		expect(s.tt.count("updateTask")).toBe(calls);
	});

	it("ticking, adding and removing items in TickTick changes the tick boxes", async () => {
		const { s, ttId, path } = await trip();
		s.tt.edit(ttId, {
			items: [
				{ id: "x", title: "Bring passport", status: 1 },
				{ id: "y", title: "Pack charger", status: 0 },
			],
		});
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("Trip notes go here.\n\n- [x] Bring passport\n- [ ] Pack charger\n");
	});

	it("a tick in TickTick changes only the box: links, headings and the order of the note stay (B1)", async () => {
		const { s, ttId, path } = await trip();
		const mine = "---\ntags: [trip]\n---\n## Before\n- [ ] Bring [[Docs|passport]]\nSee [[Plan]]\n## Later\n- [ ] Print ticket\n![[map.png]]\n";
		s.h.notes.set(path, mine);
		await run(s);
		expect(s.tt.get(ttId)!.desc).toBe("## Before\nSee Plan\n## Later");
		s.tt.edit(ttId, { items: s.tt.get(ttId)!.items!.map((i) => (i.title === "Print ticket" ? { ...i, status: 1 } : i)) });
		await run(s);
		expect(s.h.notes.files.get(path)).toBe(mine.replace("- [ ] Print ticket", "- [x] Print ticket"));
	});

	it("ticks on both sides merge", async () => {
		const { s, ttId, path } = await trip();
		s.h.notes.set(path, "Trip notes go here.\n\n- [x] Bring passport\n- [ ] Print ticket\n");
		s.tt.edit(ttId, { items: s.tt.get(ttId)!.items!.map((i) => (i.title === "Print ticket" ? { ...i, status: 1 } : i)) });
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("Trip notes go here.\n\n- [x] Bring passport\n- [x] Print ticket\n");
		expect(itemsOf(s, ttId)).toEqual([
			["Bring passport", 1],
			["Print ticket", 1],
		]);
	});

	it("the same item added on both sides is kept once (M2)", async () => {
		const { s, ttId, path } = await trip();
		s.h.notes.set(path, "Trip notes go here.\n\n- [ ] Bring passport\n- [ ] Print ticket\n- [ ] Pack charger\n");
		s.tt.edit(ttId, { items: [...s.tt.get(ttId)!.items!, { id: "z", title: "pack charger", status: 0 }] });
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("Trip notes go here.\n\n- [ ] Bring passport\n- [ ] Print ticket\n- [ ] Pack charger\n");
		expect(itemsOf(s, ttId)).toEqual([
			["Bring passport", 0],
			["Print ticket", 0],
			["Pack charger", 0],
		]);
	});

	it("a checklist with items and no text gets a note (trigger)", async () => {
		const s = await ready();
		s.notesOn = true;
		s.tt.add(s.projectId, { title: "Shop", kind: "CHECKLIST", desc: "", items: [{ id: "a", title: "Milk", status: 0 }] });
		await run(s);
		expect(s.h.notes.files.get(noteOf(s, "Shop"))).toBe("- [ ] Milk\n");
	});

	it("a checklist with text and no items gets a note, and an item added in the note goes up as an item", async () => {
		const s = await ready();
		s.notesOn = true;
		const made = s.tt.add(s.projectId, { title: "Shop", kind: "CHECKLIST", desc: "Weekly run" });
		await run(s);
		const path = noteOf(s, "Shop");
		expect(s.h.notes.files.get(path)).toBe("Weekly run\n");
		s.h.notes.set(path, "Weekly run\n- [ ] Milk\n");
		await run(s);
		expect(s.tt.get(made.id)!.desc).toBe("Weekly run");
		expect(s.tt.get(made.id)!.items!.map((i) => i.title)).toEqual(["Milk"]);
		expect(s.tt.get(made.id)!.content).toBeUndefined();
	});

	it("an empty checklist gets no note", async () => {
		const s = await ready();
		s.notesOn = true;
		s.tt.add(s.projectId, { title: "Shop", kind: "CHECKLIST", desc: "", items: [] });
		await run(s);
		expect(s.task("Shop").descriptionNote).toBeNull();
	});

	it("a normal task never sends items, and its tick-box lines are text", async () => {
		const s = await ready();
		s.notesOn = true;
		const made = s.tt.add(s.projectId, { title: "Plan", content: "Intro" });
		await run(s);
		s.h.notes.set(noteOf(s, "Plan"), "Intro\n- [ ] a line\n");
		await run(s);
		expect(s.tt.get(made.id)!.content).toBe("Intro\n- [ ] a line");
		expect(s.tt.get(made.id)!.items).toBeUndefined();
		expect(s.tt.sentItems).toEqual([]);
	});

	it("a task that becomes a checklist in TickTick keeps its note; nothing of either side is lost", async () => {
		const s = await ready();
		s.notesOn = true;
		const made = s.tt.add(s.projectId, { title: "Trip", content: "Pack\n- [ ] Passport" });
		await run(s);
		const path = noteOf(s, "Trip");
		s.h.notes.set(path, "Pack the bags\n- [ ] Passport\n");
		// TickTick's conversion: the text goes to desc, the tick-box line becomes an item.
		s.tt.edit(made.id, { kind: "CHECKLIST", content: undefined, desc: "Pack", items: [{ id: "p", title: "Passport", status: 0 }, { id: "q", title: "Ticket", status: 0 }] });
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("Pack the bags\n- [ ] Passport\n- [ ] Ticket\n");
		expect(s.tt.get(made.id)!.desc).toBe("Pack the bags");
		expect(s.tt.get(made.id)!.items!.map((i) => i.title)).toEqual(["Passport", "Ticket"]);
		expect(s.link("task", s.task("Trip").id)!.noteItems).toEqual(["- [ ] Passport", "- [ ] Ticket"]);
	});

	it("a checklist that becomes a normal task in TickTick keeps its note; the items stay as text lines", async () => {
		const { s, ttId, path, id } = await trip();
		s.tt.edit(ttId, { kind: "TEXT", desc: undefined, items: undefined, content: "Trip notes go here.\n\n- [ ] Bring passport\n- [ ] Print ticket" });
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("Trip notes go here.\n\n- [ ] Bring passport\n- [ ] Print ticket\n");
		expect(s.link("task", id)!.noteItems).toBeUndefined();
		s.h.notes.set(path, "Trip notes go here.\n\n- [x] Bring passport\n- [ ] Print ticket\n");
		await run(s);
		expect(s.tt.get(ttId)!.content).toBe("Trip notes go here.\n\n- [x] Bring passport\n- [ ] Print ticket");
		expect(s.tt.sentItems.length).toBe(0);
	});
});

describe("data safety of sync notes (SYNC-09)", () => {
	async function withNote(content: string) {
		const s = await ready();
		s.notesOn = true;
		const made = s.tt.add(s.projectId, { title: "Trip", content });
		await run(s);
		return { s, ttId: made.id, path: noteOf(s, "Trip"), id: s.task("Trip").id };
	}

	it("TickTick text the note would read differently is written so it reads back the same; a second sync sends nothing (B2)", async () => {
		const s = await ready();
		s.notesOn = true;
		const texts = ["---\nAgenda\n---\nCall the bank", "See [[Plan]] and ![[photo.png]]", "Escaped \\[[x]]", "```\n[[code]]\n```"];
		const made = texts.map((content, i) => s.tt.add(s.projectId, { title: `Task ${i}`, content }));
		await run(s);
		texts.forEach((content, i) => {
			const note = s.h.notes.files.get(noteOf(s, `Task ${i}`))!;
			expect(readNote(note, false).text).toBe(content);
		});
		await run(s);
		await run(s);
		expect(s.tt.count("updateTask")).toBe(0);
		made.forEach((m, i) => expect(s.tt.get(m.id)!.content).toBe(texts[i]));
	});

	it("a frontmatter with no line ending after it keeps its line when TickTick's text comes in (H1)", async () => {
		const { s, ttId, path } = await withNote("Old");
		s.h.notes.set(path, "---\ntags: x\n---");
		await run(s);
		expect(s.tt.get(ttId)!.content).toBe("");
		s.tt.edit(ttId, { content: "New text" });
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("---\ntags: x\n---\nNew text\n");
		await run(s);
		expect(s.tt.get(ttId)!.content).toBe("New text");
	});

	it("a TickTick edit made after the pull is not overwritten by the note's push; the next sync merges it (L1)", async () => {
		const { s, ttId, path } = await withNote("one\ntwo\nthree");
		s.h.notes.set(path, "ONE\ntwo\nthree\n");
		s.tt.onCall = (method) => {
			if (method === "getTask") {
				s.tt.edit(ttId, { content: "one\ntwo\nTHREE" });
				s.tt.onCall = null;
			}
		};
		await run(s);
		expect(s.tt.get(ttId)!.content).toBe("one\ntwo\nTHREE");
		await run(s);
		expect(s.tt.get(ttId)!.content).toBe("ONE\ntwo\nTHREE");
		expect(s.h.notes.files.get(path)).toBe("ONE\ntwo\nTHREE\n");
	});

	it("a note unlinked while the sync reads it is neither written nor sent (L2)", async () => {
		const { s, ttId, path, id } = await withNote("one\ntwo");
		s.h.notes.set(path, "ONE\ntwo\n");
		s.tt.edit(ttId, { content: "one\nTWO" });
		const read = s.h.notes.read.bind(s.h.notes);
		s.h.notes.read = async (p) => {
			await s.h.app.tasks.unlinkNote(id);
			return read(p);
		};
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("ONE\ntwo\n");
		expect(s.tt.get(ttId)!.content).toBe("one\nTWO");
		expect(s.tt.count("updateTask")).toBe(0);
	});

	it("a note unlinked just before its push is not sent (L2)", async () => {
		const { s, ttId, path, id } = await withNote("one");
		s.h.notes.set(path, "one, mine\n");
		s.tt.onCall = (method) => (method === "getTask" ? s.h.app.tasks.unlinkNote(id).then(() => undefined) : undefined);
		await run(s);
		expect(s.tt.get(ttId)!.content).toBe("one");
		expect(s.tt.count("updateTask")).toBe(0);
	});

	it("a sync note deleted and, later, another file made at its path: the new file is never taken over (L3)", async () => {
		const { s, ttId, path, id } = await withNote("one");
		s.h.notes.delete(path);
		expect(s.sync.isSyncNoteEdit(path)).toBe(false);
		s.tick(30_000);
		s.h.notes.set(path, "Someone else's note\n");
		s.sync.isSyncNoteEdit(path);
		s.tt.edit(ttId, { content: "two" });
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("Someone else's note\n");
		expect(s.tt.get(ttId)!.content).toBe("two");
		expect(s.link("task", id)).toMatchObject({ noteBySync: false, noteBase: "" });
	});

	it("a delete followed at once by a create at the same path (an atomic replace) keeps the note (L5)", async () => {
		const { s, ttId, path, id } = await withNote("one");
		s.h.notes.delete(path);
		s.sync.isSyncNoteEdit(path);
		s.tick(1_000);
		s.h.notes.set(path, "one, replaced by a sync tool\n");
		expect(s.sync.isSyncNoteEdit(path)).toBe(true);
		await run(s);
		expect(s.link("task", id)!.noteBySync).toBe(true);
		expect(s.tt.get(ttId)!.content).toBe("one, replaced by a sync tool");
	});

	it("a delete with a file at the path again at the next sync, no create seen, keeps the note (L5)", async () => {
		const { s, ttId, path, id } = await withNote("one");
		s.h.notes.delete(path);
		s.sync.isSyncNoteEdit(path);
		s.h.notes.set(path, "one, back\n");
		await run(s);
		expect(s.link("task", id)!.noteBySync).toBe(true);
		expect(s.tt.get(ttId)!.content).toBe("one, back");
	});

	it("a delete with no file at the path at the next sync lets the note go (L5)", async () => {
		const { s, path, id } = await withNote("one");
		s.h.notes.delete(path);
		s.sync.isSyncNoteEdit(path);
		await run(s);
		expect(s.link("task", id)).toMatchObject({ noteBySync: false, noteBase: "" });
	});

	it("a rename while a sync is reading the note does not let the note go (L5)", async () => {
		const { s, ttId, path, id } = await withNote("one");
		s.h.notes.set(path, "one, edited\n");
		const read = s.h.notes.read.bind(s.h.notes);
		s.h.notes.read = async (p) => {
			if (p === path && s.h.notes.exists(path)) {
				s.h.notes.rename(path, "Travel/Trip.md");
				s.sync.isSyncNoteEdit(path);
				await s.h.app.tasks.rewriteNotePaths(path, "Travel/Trip.md", false);
			}
			return read(p);
		};
		await run(s);
		expect(s.link("task", id)!.noteBySync).toBe(true);
		await run(s);
		expect(s.link("task", id)!.noteBySync).toBe(true);
		expect(s.tt.get(ttId)!.content).toBe("one, edited");
	});

	it("TickTick's edit of a line with an embed comes down once; the next syncs send nothing (M)", async () => {
		const { s, ttId, path } = await withNote("Receipt\nTotal");
		s.h.notes.set(path, "Receipt ![[scan.png]]\nTotal\n");
		await run(s);
		expect(s.tt.get(ttId)!.content).toBe("Receipt\nTotal");
		s.tt.edit(ttId, { content: "Receipt March\nTotal" });
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("Receipt March ![[scan.png]]\nTotal\n");
		await run(s);
		await run(s);
		expect(s.tt.count("updateTask")).toBe(0);
		expect(s.tt.get(ttId)!.content).toBe("Receipt March\nTotal");
	});

	it("a renamed sync note is not taken for a deleted one (L3)", async () => {
		const { s, ttId, path } = await withNote("one");
		s.h.notes.rename(path, "Travel/Trip.md");
		s.sync.isSyncNoteEdit(path);
		await s.h.app.tasks.rewriteNotePaths(path, "Travel/Trip.md", false);
		s.tt.edit(ttId, { content: "two" });
		await run(s);
		expect(s.h.notes.files.get("Travel/Trip.md")).toBe("two\n");
	});

	/** Makes the next links command after `armed()` turns true fail once, as a store that turned read-only would. */
	function failLinksOnce(s: SyncHarness, armed: () => boolean) {
		const store = s.h.app.store;
		const original = store.run.bind(store);
		let done = false;
		store.run = ((label: string, fn: never, options?: never) => {
			if (!done && label === TICKTICK_LINKS_LABEL && armed()) {
				done = true;
				return Promise.reject(new Error("The database is read-only."));
			}
			return original(label, fn, options);
		});
	}

	it("no item is doubled when the base could not be saved after the note was written (M2)", async () => {
		const s = await ready();
		s.notesOn = true;
		const made = s.tt.add(s.projectId, { title: "Shop", kind: "CHECKLIST", desc: "", items: [{ id: "a", title: "Milk", status: 0 }] });
		await run(s);
		const path = noteOf(s, "Shop");
		s.h.notes.set(path, "- [ ] Milk\n- [ ] Eggs\n");
		s.tt.edit(made.id, { items: [...s.tt.get(made.id)!.items!, { id: "b", title: "Bread", status: 0 }] });
		const writes = () => s.h.notes.writes.length;
		const before = writes();
		failLinksOnce(s, () => writes() > before);
		await expect(s.sync.sync()).rejects.toThrow("read-only");
		s.tick();
		await run(s);
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("- [ ] Milk\n- [ ] Eggs\n- [ ] Bread\n");
		expect(s.tt.get(made.id)!.items!.map((i) => i.title)).toEqual(["Milk", "Eggs", "Bread"]);
	});

	it("no item is doubled when TickTick confirmed the push but the links were not saved (M2)", async () => {
		const s = await ready();
		s.notesOn = true;
		const made = s.tt.add(s.projectId, { title: "Shop", kind: "CHECKLIST", desc: "", items: [{ id: "a", title: "Milk", status: 0 }] });
		await run(s);
		const path = noteOf(s, "Shop");
		s.h.notes.set(path, "- [ ] Milk\n- [ ] Eggs\n");
		failLinksOnce(s, () => s.tt.count("updateTask") > 0);
		await expect(s.sync.sync()).rejects.toThrow("read-only");
		s.tick();
		expect(s.tt.get(made.id)!.items!.map((i) => i.title)).toEqual(["Milk", "Eggs"]);
		await run(s);
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("- [ ] Milk\n- [ ] Eggs\n");
		expect(s.tt.get(made.id)!.items!.map((i) => i.title)).toEqual(["Milk", "Eggs"]);
		expect(s.tt.count("updateTask")).toBe(1);
	});
});

describe("description notes and the rest of the sync (SYNC-09)", () => {
	it("tells the host which vault changes are the user's edits of a sync note, never the sync's own writes", async () => {
		const s = await ready();
		s.notesOn = true;
		const made = s.tt.add(s.projectId, { title: "Trip", content: "one" });
		await run(s);
		const path = noteOf(s, "Trip");
		expect(s.sync.isSyncNoteEdit(path)).toBe(false);
		s.tt.edit(made.id, { content: "two" });
		await run(s);
		expect(s.sync.isSyncNoteEdit(path)).toBe(false);
		s.h.notes.set(path, "three\n");
		expect(s.sync.isSyncNoteEdit(path)).toBe(true);
		expect(s.sync.isSyncNoteEdit("Mine/Other.md")).toBe(false);
		s.notesOn = false;
		expect(s.sync.isSyncNoteEdit(path)).toBe(false);
	});

	it("a note that cannot be read is skipped with a warning; the other notes and the rest of the sync go on", async () => {
		const s = await ready();
		s.notesOn = true;
		const a = s.tt.add(s.projectId, { title: "Alpha", content: "a" });
		const b = s.tt.add(s.projectId, { title: "Beta", content: "b" });
		await run(s);
		s.h.notes.set(noteOf(s, "Alpha"), "a, edited\n");
		s.h.notes.set(noteOf(s, "Beta"), "b, edited\n");
		const read = s.h.notes.read.bind(s.h.notes);
		s.h.notes.read = async (path) => {
			if (path === noteOf(s, "Alpha")) throw new Error("EBUSY");
			return read(path);
		};
		s.tt.edit(b.id, { title: "Beta two" });
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		const { TICKTICK_NOTE_WARNING } = await import("../../src/app/syncNotes");
		expect(r.warnings).toEqual([TICKTICK_NOTE_WARNING]);
		expect(s.tt.get(a.id)!.content).toBe("a");
		expect(s.tt.get(b.id)!.content).toBe("b, edited");
		expect(s.task("Beta two")).toBeDefined();
	});

	it("a duplicate of a task shares its note, but only the original's link writes it", async () => {
		const s = await ready();
		s.notesOn = true;
		const made = s.tt.add(s.projectId, { title: "Trip", content: "one" });
		await run(s);
		const original = s.task("Trip");
		const path = noteOf(s, "Trip");
		const copy = await s.h.app.tasks.duplicate(original.id);
		expect(copy.descriptionNote?.path).toBe(path);
		await run(s);
		expect(s.link("task", copy.id)!.noteBySync).toBe(false);
		expect(s.tt.get(s.link("task", copy.id)!.ttId)!.content).toBeUndefined();
		s.tt.edit(made.id, { content: "two" });
		await run(s);
		expect(s.h.notes.files.get(path)).toBe("two\n");
		expect(s.link("task", original.id)!.noteBySync).toBe(true);
	});

	it("a checklist task moved to another linked list keeps its note in step", async () => {
		const s = await ready();
		s.notesOn = true;
		const home = await linkedList(s, "Home");
		const made = s.tt.add(s.projectId, { title: "Trip", kind: "CHECKLIST", desc: "", items: [{ id: "i1", title: "Pack", status: 0 }] });
		await run(s);
		await s.h.app.tasks.update(s.task("Trip").id, { categoryId: home.listId });
		await run(s);
		s.h.notes.set(noteOf(s, "Trip"), "- [x] Pack\n");
		await run(s);
		const copy = s.tt.get(made.id)!;
		expect(copy.projectId).toBe(home.projectId);
		expect(copy.items!.map((i) => [i.title, i.status])).toEqual([["Pack", 1]]);
	});
});

describe("description note bookkeeping (SYNC-09)", () => {
	it("is not undoable, and its commands are the sync's own (they start no push)", async () => {
		const s = await ready();
		s.notesOn = true;
		const before = s.h.app.store.undoLabel;
		const labels: string[] = [];
		s.h.app.store.bus.on("changed", (e) => labels.push(e.label));
		s.tt.add(s.projectId, { title: "Trip", content: "Pack" });
		await run(s);
		expect(s.h.app.store.undoLabel).toBe(before);
		const { SYNC_OWN_LABELS } = await import("../../src/app/SyncService");
		expect(labels.length).toBeGreaterThan(0);
		expect(labels.every((l) => SYNC_OWN_LABELS.has(l))).toBe(true);
	});

	it("leaves no note fields on a link that never had a note", async () => {
		const s = await ready();
		s.notesOn = true;
		await s.h.app.tasks.create({ title: "Buy milk", categoryId: s.listId });
		await run(s);
		const link = s.h.app.store.state.syncLinks.get(syncLinkId("task", s.task("Buy milk").id))!;
		expect("noteBase" in link).toBe(false);
		expect("noteItems" in link).toBe(false);
	});
});
