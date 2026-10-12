import { describe, expect, it } from "vitest";
import { tagNamesOf } from "../../src/domain/tags";
import { isSyncedTag } from "../../src/domain/ticktick/tags";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";

// Renaming a tag in Logwell renames nothing in TickTick (TickTick sync rule 6): its tasks go up once with the new
// name, the old TickTick tag stays, the next sync is quiet, and a TickTick task still carrying the old name brings it
// back as a new Logwell tag.

const taskPushes = (s: SyncHarness) => s.tt.count("batchTasks") + s.tt.count("updateTask") + s.tt.count("createTask");

async function setup(): Promise<SyncHarness & { listId: string; projectId: string }> {
	const s = await syncHarness();
	const { listId, projectId } = await linkedList(s);
	await s.h.app.tags.create("Calls");
	await s.h.app.tasks.create({ title: "Ring mum", categoryId: listId, tagKeys: ["calls"] });
	const r = await s.sync.sync();
	if (!r.ok) throw new Error("first sync failed");
	s.tick();
	return Object.assign(s, { listId, projectId });
}

describe("sync after a tag rename", () => {
	it("pushes the task once with the new name, leaves the old TickTick tag, and the next sync is quiet", async () => {
		const s = await setup();
		expect(s.tt.get(s.ttIdOf("Ring mum"))?.tags).toEqual(["calls"]);
		const oldTag = s.tt.tags.get("calls");
		await s.h.app.tags.edit("calls", { name: "Phone", parentKey: null, color: null });
		const before = taskPushes(s);
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(taskPushes(s) - before).toBe(1);
		expect(s.tt.get(s.ttIdOf("Ring mum"))?.tags).toEqual(["phone"]);
		expect(s.tt.tags.get("phone")).toEqual({ name: "phone", label: "Phone" });
		// Nothing is renamed or deleted in TickTick.
		expect(s.tt.tags.get("calls")).toEqual(oldTag);
		expect(s.tt.calls.some((c) => c.startsWith("deleteTag") || c.startsWith("updateTag"))).toBe(false);
		// The pull did not bring the old name back on the renamed task.
		expect(s.h.app.store.state.tags.has("calls")).toBe(false);
		expect(s.task("Ring mum").tagKeys).toEqual(["phone"]);

		s.tick();
		const settled = taskPushes(s);
		const tagCreates = s.tt.count("createTag");
		await s.sync.sync();
		expect(taskPushes(s)).toBe(settled);
		expect(s.tt.count("createTag")).toBe(tagCreates);
		expect(s.h.app.store.state.tags.has("calls")).toBe(false);
	});

	it("moving a tag under a parent keeps it synced under its own name; nothing is renamed and the next sync is quiet", async () => {
		const s = await setup();
		await s.h.app.tags.create("Home");
		await s.h.app.tags.edit("calls", { name: "Calls", parentKey: "home", color: null });
		const names = tagNamesOf(s.h.app.store.state.tags);
		expect(names.owner("calls")).toBe("home/calls");
		expect(isSyncedTag(names, "home/calls")).toBe(true);
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(s.tt.get(s.ttIdOf("Ring mum"))?.tags).toEqual(["calls"]);
		// The pull leaves the moved key alone: it does not bring back a top-level "calls".
		expect(s.task("Ring mum").tagKeys).toEqual(["home/calls"]);
		expect(s.h.app.store.state.tags.has("calls")).toBe(false);
		s.tick();
		const settled = taskPushes(s);
		await s.sync.sync();
		expect(taskPushes(s)).toBe(settled);
		expect(s.task("Ring mum").tagKeys).toEqual(["home/calls"]);
	});

	it("renaming the owner of a name an older duplicate shares hands the name to the duplicate, which then syncs", async () => {
		const s = await syncHarness();
		const { listId } = await linkedList(s);
		await s.h.app.store.run("Seed", (tx) => {
			tx.put("tags", { key: "home", displayName: "Home", color: null, createdAt: "2026-01-01T00:00:00Z", modifiedAt: "2026-01-01T00:00:00Z" });
			tx.put("tags", { key: "home/calls", displayName: "Home/Calls", color: null, createdAt: "2026-01-01T00:00:00Z", modifiedAt: "2026-01-01T00:00:00Z" });
			tx.put("tags", { key: "work", displayName: "Work", color: null, createdAt: "2026-02-01T00:00:00Z", modifiedAt: "2026-02-01T00:00:00Z" });
			tx.put("tags", { key: "work/calls", displayName: "Work/Calls", color: null, createdAt: "2026-02-01T00:00:00Z", modifiedAt: "2026-02-01T00:00:00Z" });
		});
		await s.h.app.tasks.create({ title: "Ring mum", categoryId: listId, tagKeys: ["home/calls"] });
		await s.h.app.tasks.create({ title: "Ring the office", categoryId: listId, tagKeys: ["work/calls"] });
		await s.sync.sync();
		expect(isSyncedTag(tagNamesOf(s.h.app.store.state.tags), "work/calls")).toBe(false);
		expect(s.tt.get(s.ttIdOf("Ring the office"))?.tags ?? []).toEqual([]);
		s.tick();

		await s.h.app.tags.edit("home/calls", { name: "Phone", parentKey: "home", color: null });
		expect(tagNamesOf(s.h.app.store.state.tags).owner("calls")).toBe("work/calls");
		expect(isSyncedTag(tagNamesOf(s.h.app.store.state.tags), "work/calls")).toBe(true);
		await s.sync.sync();
		expect(s.tt.get(s.ttIdOf("Ring mum"))?.tags).toEqual(["phone"]);
		expect(s.tt.get(s.ttIdOf("Ring the office"))?.tags).toEqual(["calls"]);
		expect(s.task("Ring the office").tagKeys).toEqual(["work/calls"]);
		s.tick();
		const settled = taskPushes(s);
		await s.sync.sync();
		expect(taskPushes(s)).toBe(settled);
	});

	it("a TickTick task that still carries the old name brings it back as a new tag", async () => {
		const s = await setup();
		await s.h.app.tags.edit("calls", { name: "Phone", parentKey: null, color: null });
		await s.sync.sync();
		s.tick();
		s.tt.add(s.projectId, { title: "Call the bank", tags: ["calls"] });
		await s.sync.sync();
		expect(s.h.app.store.state.tags.has("calls")).toBe(true);
		expect(s.task("Call the bank").tagKeys).toEqual(["calls"]);
		expect(s.task("Ring mum").tagKeys).toEqual(["phone"]);
	});
});
