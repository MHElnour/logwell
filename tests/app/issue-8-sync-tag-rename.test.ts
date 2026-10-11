import { describe, expect, it } from "vitest";
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
