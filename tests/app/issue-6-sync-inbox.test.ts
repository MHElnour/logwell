import { describe, expect, it, vi } from "vitest";
import { TickTickError } from "../../src/app/ports";
import { SyncService } from "../../src/app/SyncService";
import { InboxAliasApi } from "../../src/app/tickTickInbox";
import { INBOX_ID, syncLinkId } from "../../src/domain/types";
import { FakeTickTick } from "./fake-ticktick";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";

// TickTick's Inbox is linked under the alias `inbox`, but its tasks carry the real id
// `inbox<digits>`. The engine must treat both as one project: no duplicate import, moves, completions, deletes.

async function withInbox(): Promise<SyncHarness & { inboxId: string }> {
	const s = await syncHarness();
	const inbox = s.tt.addInbox();
	return Object.assign(s, { inboxId: inbox.id });
}

async function linkInbox(s: SyncHarness) {
	const r = await s.sync.applyFirstSync(INBOX_ID, "inbox");
	s.tick();
	return r;
}

describe("the Inbox as a linked list", () => {
	it("a first sync of an empty Inbox with an empty list links it and fails nothing", async () => {
		const s = await withInbox();
		const r = await linkInbox(s);
		expect(r.ok).toBe(true);
		expect(r.failures).toEqual([]);
		expect(s.link("list", INBOX_ID)?.ttId).toBe("inbox");
		const again = await s.sync.sync();
		expect(again.ok).toBe(true);
		expect(s.tt.calls.filter((c) => c.startsWith("getProjectData"))).toEqual(["getProjectData:inbox", "getProjectData:inbox", "getProjectData:inbox"]);
	});

	it("previews an Inbox that already has tasks, counting them once", async () => {
		const s = await withInbox();
		s.tt.add(s.inboxId, { title: "Call the bank" });
		await s.h.app.tasks.create({ title: "Pay rent" });
		const plan = await s.sync.planFirstSync(INBOX_ID, "inbox");
		expect(plan).toMatchObject({ toLogwell: 1, toTickTick: 1 });
	});

	it("imports the tasks of the Inbox once, whatever spelling their project id has", async () => {
		const s = await withInbox();
		s.tt.add(s.inboxId, { title: "Call the bank" });
		s.tt.add(s.inboxId, { title: "Book the dentist" });
		await linkInbox(s);
		expect(s.tasks("Call the bank")).toHaveLength(1);
		expect(s.tasks("Book the dentist")).toHaveLength(1);
		expect(s.link("task", s.task("Call the bank").id)?.ttProjectId).toBe("inbox");
		for (let i = 0; i < 3; i++) {
			s.tick();
			await s.sync.sync();
		}
		expect(s.h.app.store.state.tasks.size).toBe(2);
		expect(s.tt.live(s.inboxId)).toHaveLength(2);
	});

	it("sends a Logwell Inbox task to an empty Inbox, then keeps working with the real id", async () => {
		const s = await withInbox();
		await s.h.app.tasks.create({ title: "Pay rent" });
		await linkInbox(s);
		expect(s.tt.live(s.inboxId).map((t) => t.title)).toEqual(["Pay rent"]);
		// An edit and a new task after the real id was seen.
		s.tick();
		await s.h.app.tasks.update(s.task("Pay rent").id, { title: "Pay the rent" });
		await s.h.app.tasks.create({ title: "Buy milk" });
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(s.tt.live(s.inboxId).map((t) => t.title).sort()).toEqual(["Buy milk", "Pay the rent"]);
		expect(s.h.app.store.state.tasks.size).toBe(2);
	});

	it("pulls an edit made in TickTick and does not push it back", async () => {
		const s = await withInbox();
		s.tt.add(s.inboxId, { title: "Call the bank" });
		await linkInbox(s);
		s.tt.edit(s.ttIdOf("Call the bank"), { title: "Call the bank today" });
		s.tick();
		await s.sync.sync();
		expect(s.tasks("Call the bank today")).toHaveLength(1);
		expect(s.tt.count("updateTask")).toBe(0);
	});

	it("completes in Logwell a task completed in TickTick, and completes in TickTick one completed in Logwell", async () => {
		const s = await withInbox();
		s.tt.add(s.inboxId, { title: "Call the bank" });
		s.tt.add(s.inboxId, { title: "Book the dentist" });
		await linkInbox(s);
		s.tt.edit(s.ttIdOf("Call the bank"), { status: 2 });
		await s.h.app.tasks.complete(s.task("Book the dentist").id);
		s.tick();
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(s.task("Call the bank").status).toBe("completed");
		expect(s.tt.findByTitle("Book the dentist")?.status).toBe(2);
		expect(s.tt.calls.filter((c) => c.startsWith("listCompleted"))).toContain("listCompleted:inbox");
	});

	it("deletes in TickTick a task deleted in Logwell, and trashes in Logwell one deleted in TickTick", async () => {
		const s = await withInbox();
		s.tt.add(s.inboxId, { title: "Call the bank" });
		s.tt.add(s.inboxId, { title: "Book the dentist" });
		await linkInbox(s);
		const gone = s.ttIdOf("Call the bank");
		await s.h.app.tasks.delete(s.task("Book the dentist").id);
		s.tt.remove(gone);
		s.tick();
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(s.tasks("Call the bank")).toHaveLength(0);
		expect(s.tt.live(s.inboxId)).toHaveLength(0);
		s.tick();
		expect((await s.sync.sync()).ok).toBe(true);
	});

	it("moves a task from the Inbox to another linked list and back, in both directions", async () => {
		const s = await withInbox();
		s.tt.add(s.inboxId, { title: "Call the bank" });
		s.tt.add(s.inboxId, { title: "Book the dentist" });
		await linkInbox(s);
		const { listId, projectId } = await linkedList(s, "Work");
		// Logwell moves one into Work; TickTick moves the other into Work.
		await s.h.app.tasks.update(s.task("Call the bank").id, { categoryId: listId });
		s.tt.moveTo(s.ttIdOf("Book the dentist"), projectId);
		s.tick();
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(s.tt.findByTitle("Call the bank")?.projectId).toBe(projectId);
		expect(s.task("Book the dentist").categoryId).toBe(listId);
		expect(s.link("task", s.task("Call the bank").id)?.ttProjectId).toBe(projectId);
		// And both back into the Inbox.
		await s.h.app.tasks.update(s.task("Call the bank").id, { categoryId: INBOX_ID });
		s.tt.moveTo(s.ttIdOf("Book the dentist"), s.inboxId);
		s.tick();
		const back = await s.sync.sync();
		expect(back.ok).toBe(true);
		expect(s.tt.findByTitle("Call the bank")?.projectId).toBe(s.inboxId);
		expect(s.task("Book the dentist").categoryId).toBe(INBOX_ID);
		expect(s.link("task", s.task("Book the dentist").id)?.ttProjectId).toBe("inbox");
		expect(s.h.app.store.state.tasks.size).toBe(2);
		expect(s.tt.live(s.inboxId)).toHaveLength(2);
	});

	it("a project listed under an Inbox id is not a second project", async () => {
		const s = await withInbox();
		await linkInbox(s);
		const api = new InboxAliasApi(s.tt);
		expect((await api.listProjects()).map((p) => p.id)).toEqual([]);
		expect(s.h.app.store.state.syncLinks.has(syncLinkId("list", INBOX_ID))).toBe(true);
	});

	it("refuses to link the Inbox twice, in either spelling", async () => {
		const s = await withInbox();
		await linkInbox(s);
		const other = await s.h.app.categories.create("Work");
		await expect(s.sync.planFirstSync(other.id, "inbox")).rejects.toThrow("already linked to another list");
	});
});

describe("InboxAliasApi", () => {
	function spy() {
		const tt = new FakeTickTick({ now: () => new Date("2026-10-01T10:00:00Z") });
		const inbox = tt.addInbox();
		return { tt, inbox, api: new InboxAliasApi(tt) };
	}

	it("returns the alias for every id, tasks, columns and project included", async () => {
		const { tt, inbox, api } = spy();
		tt.add(inbox.id, { title: "A" });
		tt.addColumn(inbox.id, "Later");
		const data = await api.getProjectData("inbox");
		expect(data.project.id).toBe("inbox");
		expect(data.tasks.map((t) => t.projectId)).toEqual(["inbox"]);
		expect(data.columns.map((c) => c.projectId)).toEqual(["inbox"]);
		expect((await api.getProjectData(inbox.id)).tasks[0]!.projectId).toBe("inbox");
	});

	it("sends a create with no project while the real id is unknown, and the real id afterwards", async () => {
		const { tt, inbox, api } = spy();
		const first = await api.createTask({ projectId: "inbox", title: "A" });
		expect(first.projectId).toBe("inbox");
		expect(tt.tasks.get([...tt.tasks.keys()][0]!)?.projectId).toBe(inbox.id);
		await api.updateTask({ id: first.id, projectId: "inbox", title: "A2" });
		await api.completeTask("inbox", first.id);
		await api.deleteTask("inbox", first.id);
		expect(tt.calls.filter((c) => c.startsWith("updateTask") || c.startsWith("completeTask") || c.startsWith("deleteTask"))).toHaveLength(3);
	});

	it("leaves ids of other projects as they are", async () => {
		const { tt, api } = spy();
		const work = tt.addProject("Work");
		const made = await api.createTask({ projectId: work.id, title: "A" });
		expect(made.projectId).toBe(work.id);
		expect((await api.getProjectData(work.id)).project.id).toBe(work.id);
	});
});

/** A new engine over the same store: what a reload leaves (the real Inbox id is not known yet). */
function reloaded(s: SyncHarness): SyncService {
	return new SyncService(s.h.app.store, s.h.app.tasks, s.h.app.sections, { zone: () => "Europe/Berlin" }, s.tt);
}

describe("the Inbox's real id is not known yet (probed against the real API)", () => {
	it("a Logwell Inbox with a section is pushed into an empty TickTick Inbox: the task first, then the column", async () => {
		const s = await withInbox();
		const sec = await s.h.app.sections.create(INBOX_ID, "Errands");
		await s.h.app.tasks.create({ title: "Call the bank", sectionId: sec.id });
		const r = await s.sync.applyFirstSync(INBOX_ID, "inbox");
		expect(r.ok).toBe(true);
		expect(r.failures).toEqual([]);
		const made = s.tt.findByTitle("Call the bank")!;
		expect(made.projectId).toBe(s.inboxId);
		const column = [...s.tt.columns.values()].find((c) => c.name === "Errands")!;
		expect(column.projectId).toBe(s.inboxId);
		expect(made.columnId).toBe(column.id);
		// The alias never went to the column call.
		expect(s.tt.calls.filter((c) => c.startsWith("createColumn"))).toEqual(["createColumn:Errands"]);
		// And the next sync has nothing to do: no duplicate, no section change.
		s.tick();
		const again = await s.sync.sync();
		expect(again.ok).toBe(true);
		expect(again.pushed).toBe(0);
		expect(s.tt.live(s.inboxId)).toHaveLength(1);
		expect(s.task("Call the bank").sectionId).toBe(sec.id);
	});

	it("a second task of the same section reuses the column", async () => {
		const s = await withInbox();
		const sec = await s.h.app.sections.create(INBOX_ID, "Errands");
		await s.h.app.tasks.create({ title: "Call the bank", sectionId: sec.id });
		await s.h.app.tasks.create({ title: "Pay rent", sectionId: sec.id });
		expect((await s.sync.applyFirstSync(INBOX_ID, "inbox")).ok).toBe(true);
		expect([...s.tt.columns.values()].filter((c) => c.name === "Errands")).toHaveLength(1);
		const column = [...s.tt.columns.values()][0]!;
		expect(s.tt.live(s.inboxId).map((t) => t.columnId)).toEqual([column.id, column.id]);
	});

	it("a failed column follow-up leaves the task linked as not sectioned, and the next sync sets the column", async () => {
		const s = await withInbox();
		const sec = await s.h.app.sections.create(INBOX_ID, "Errands");
		await s.h.app.tasks.create({ title: "Call the bank", sectionId: sec.id });
		s.tt.fail("createColumn", new TickTickError("network", "TickTick: no answer (network error)."));
		const first = await s.sync.applyFirstSync(INBOX_ID, "inbox");
		expect(first.ok).toBe(false);
		expect(s.tt.live(s.inboxId)).toHaveLength(1);
		expect(s.link("task", s.task("Call the bank").id)).toBeDefined();
		s.tick();
		const next = await s.sync.sync();
		expect(next.ok).toBe(true);
		expect(s.tt.live(s.inboxId)).toHaveLength(1);
		expect(s.tt.findByTitle("Call the bank")?.columnId).toBeDefined();
		expect(s.task("Call the bank").sectionId).toBe(sec.id);
	});

	it("moving a task into an empty Inbox and editing it in one sync works after a reload", async () => {
		const s = await withInbox();
		const { listId } = await linkedList(s, "Work");
		await s.h.app.tasks.create({ title: "Call the bank", categoryId: listId });
		await s.sync.sync();
		expect((await s.sync.applyFirstSync(INBOX_ID, "inbox")).ok).toBe(true);
		s.tick();
		const fresh = reloaded(s);
		await s.h.app.tasks.update(s.task("Call the bank").id, { categoryId: INBOX_ID, title: "Call the bank today" });
		const r = await fresh.sync();
		expect(r.ok).toBe(true);
		expect(r.failures).toEqual([]);
		expect(s.tt.findByTitle("Call the bank today")?.projectId).toBe(s.inboxId);
		expect(s.tt.calls.filter((c) => c.startsWith("batchTasks")).length).toBeGreaterThan(0);
	});

	it("deleting a completed Inbox task after a reload with no open task in the Inbox works", async () => {
		const s = await withInbox();
		s.tt.add(s.inboxId, { title: "Pay rent" });
		await s.sync.applyFirstSync(INBOX_ID, "inbox");
		s.tick();
		await s.h.app.tasks.complete(s.task("Pay rent").id);
		await s.sync.sync();
		const ttId = s.ttIdOf("Pay rent");
		expect(s.tt.tasks.get(ttId)?.status).toBe(2);
		s.tick(30 * 24 * 3600_000);
		await s.sync.sync();
		s.tick(30 * 24 * 3600_000);
		const fresh = reloaded(s);
		await s.h.app.tasks.delete(s.task("Pay rent").id);
		const r = await fresh.sync();
		expect(r.ok).toBe(true);
		expect(r.failures).toEqual([]);
		expect(s.tt.tasks.get(ttId)?.deleted).toBe(true);
		expect(s.h.app.store.state.syncLinks.has(syncLinkId("task", ttId))).toBe(false);
	});

	it("a batch update never carries the alias, and a column is never created with it", async () => {
		const s = await withInbox();
		s.tt.add(s.inboxId, { title: "Call the bank" });
		await linkInbox(s);
		const batch = vi.spyOn(s.tt, "batchTasks");
		await s.h.app.tasks.update(s.task("Call the bank").id, { title: "Call the bank today" });
		s.tick();
		expect((await reloaded(s).sync()).ok).toBe(true);
		expect(batch).toHaveBeenCalled();
		for (const [b] of batch.mock.calls) for (const u of b.update ?? []) expect(u.projectId).toBe(s.inboxId);
	});

	it("an account whose default list is not the Inbox: the created task is moved to the Inbox at once", async () => {
		const s = await withInbox();
		const other = s.tt.addProject("Tasks");
		s.tt.noProjectGoesTo = other.id;
		await s.h.app.tasks.create({ title: "Pay rent" });
		const r = await s.sync.applyFirstSync(INBOX_ID, "inbox");
		expect(r.ok).toBe(true);
		const made = s.tt.findByTitle("Pay rent")!;
		expect(made.projectId).toBe(s.inboxId);
		expect(s.tt.live(other.id)).toHaveLength(0);
		expect(s.link("task", s.task("Pay rent").id)?.ttProjectId).toBe("inbox");
		s.tick();
		expect((await s.sync.sync()).pushed).toBe(0);
		expect(s.tt.live(s.inboxId)).toHaveLength(1);
	});

	it("when that move fails the stray copy is deleted, the write fails for the list and nothing is linked", async () => {
		const s = await withInbox();
		const other = s.tt.addProject("Tasks");
		s.tt.noProjectGoesTo = other.id;
		await s.h.app.tasks.create({ title: "Pay rent" });
		s.tt.fail("moveTasks", new TickTickError("server", "TickTick: server error"));
		const r = await s.sync.applyFirstSync(INBOX_ID, "inbox");
		expect(r.ok).toBe(false);
		expect(s.link("task", s.task("Pay rent").id)).toBeUndefined();
		expect(s.tt.live(other.id)).toHaveLength(0);
		expect(s.tt.live(s.inboxId)).toHaveLength(0);
		// The next sync creates it again, once.
		s.tick();
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.tt.live(s.inboxId).map((t) => t.title)).toEqual(["Pay rent"]);
	});
});

describe("a list link written with the real Inbox id by an early build", () => {
	it("is rewritten to the alias, and the sync then behaves as for a link to the alias", async () => {
		const s = await withInbox();
		s.tt.add(s.inboxId, { title: "Call the bank" });
		await s.h.app.tasks.create({ title: "Pay rent" });
		// Link as an early build did: the real id as the project.
		await s.h.app.store.run("test links", (tx) => {
			tx.put("syncLinks", { kind: "list", logwellId: INBOX_ID, ttId: s.inboxId, ttProjectId: null, etag: null, base: {}, noteBySync: false, lastPulledAt: null, modifiedAt: tx.now });
		}, { undoable: false });
		const first = await s.sync.sync();
		expect(first.ok).toBe(true);
		expect(s.link("list", INBOX_ID)?.ttId).toBe("inbox");
		for (let i = 0; i < 2; i++) {
			s.tick();
			expect((await s.sync.sync()).ok).toBe(true);
		}
		expect([...s.h.app.store.state.tasks.values()].map((t) => t.title).sort()).toEqual(["Call the bank", "Pay rent"]);
		expect(s.tt.live(s.inboxId).map((t) => t.title).sort()).toEqual(["Call the bank", "Pay rent"]);
		for (const l of s.h.app.store.state.syncLinks.values()) expect(l.ttProjectId === null || l.ttProjectId === "inbox").toBe(true);
	});

	it("is the same project as the alias when linking", async () => {
		const s = await withInbox();
		await linkInbox(s);
		const other = await s.h.app.categories.create("Work");
		await expect(s.sync.planFirstSync(other.id, s.inboxId)).rejects.toThrow("already linked to another list");
		// And a first sync given the real id stores the alias.
		const s2 = await withInbox();
		await s2.sync.applyFirstSync(INBOX_ID, s2.inboxId);
		expect(s2.link("list", INBOX_ID)?.ttId).toBe("inbox");
	});
});

describe("the Inbox wrapper respects a stopped sync", () => {
	async function movedIntoInboxAfterReload() {
		const s = await withInbox();
		const work = s.tt.addProject("Work");
		const wl = await s.h.app.categories.create("Work");
		await s.sync.applyFirstSync(wl.id, work.id);
		await linkInbox(s);
		await s.h.app.tasks.create({ title: "Call the bank", categoryId: wl.id });
		s.tick();
		await s.sync.sync();
		// A new engine (as after a reload) does not know the Inbox's real id yet.
		const fresh = new SyncService(s.h.app.store, s.h.app.tasks, s.h.app.sections, { zone: () => "Europe/Berlin" }, s.tt);
		await s.h.app.tasks.update(s.task("Call the bank").id, { categoryId: INBOX_ID, title: "Call the bank today" });
		s.tt.calls.length = 0;
		s.tick();
		return { s, fresh };
	}

	it("sends nothing after stop() while it learns the Inbox's real id", async () => {
		const { s, fresh } = await movedIntoInboxAfterReload();
		s.tt.onCall = (m) => {
			if (m === "getTask") fresh.stop();
		};
		const r = await fresh.sync();
		const afterLookup = s.tt.calls.slice(s.tt.calls.findIndex((c) => c.startsWith("getTask")) + 1);
		expect(afterLookup).toEqual([]);
		expect(r.ok).toBe(false);
	});

	it("stops learning the real id on a rate limit instead of trying more tasks", async () => {
		const { s, fresh } = await movedIntoInboxAfterReload();
		s.tt.fail("getTask", new TickTickError("rate-limited", "TickTick: too many requests.", { retryAfterSec: 60 }));
		const r = await fresh.sync();
		expect(r.ok).toBe(false);
		expect(s.tt.calls.filter((c) => c.startsWith("getTask"))).toHaveLength(1);
		expect(s.tt.calls.some((c) => c.startsWith("batchTasks"))).toBe(false);
	});
});
