import { describe, expect, it } from "vitest";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";

// Deleting a parent tag changes nothing in TickTick (TickTick sync rule 6): its child tags keep their names, so their
// tasks are not sent again, and no TickTick tag is renamed or deleted. A task that held the parent goes up once
// without it. Pulling a nested TickTick name creates the Logwell parent tag first (Lists, sections and tags rule 26).

const taskPushes = (s: SyncHarness) => s.tt.count("batchTasks") + s.tt.count("updateTask") + s.tt.count("createTask");

async function setup(): Promise<SyncHarness & { listId: string; projectId: string }> {
	const s = await syncHarness();
	const { listId, projectId } = await linkedList(s);
	await s.h.app.tags.create("Home/Calls");
	await s.h.app.tags.create("Home/Garden");
	await s.h.app.tasks.create({ title: "Ring mum", categoryId: listId, tagKeys: ["home/calls"] });
	await s.h.app.tasks.create({ title: "Weed", categoryId: listId, tagKeys: ["home/garden"] });
	await s.h.app.tasks.create({ title: "Tidy", categoryId: listId, tagKeys: ["home", "home/calls"] });
	const r = await s.sync.sync();
	if (!r.ok) throw new Error("first sync failed");
	s.tick();
	return Object.assign(s, { listId, projectId });
}

describe("sync after deleting a parent tag", () => {
	it("sends only the task that held the parent, touches no TickTick tag, and the next sync is quiet", async () => {
		const s = await setup();
		expect(s.tt.get(s.ttIdOf("Ring mum"))?.tags).toEqual(["calls"]);
		expect([...(s.tt.get(s.ttIdOf("Tidy"))?.tags ?? [])].sort()).toEqual(["calls", "home"]);
		const ttTags = new Map(s.tt.tags);
		const ring = structuredClone(s.tt.get(s.ttIdOf("Ring mum")));
		const weed = structuredClone(s.tt.get(s.ttIdOf("Weed")));

		await s.h.app.tags.delete("home");
		expect(s.task("Ring mum").tagKeys).toEqual(["calls"]);
		expect(s.task("Tidy").tagKeys).toEqual(["calls"]);
		const before = taskPushes(s);
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(taskPushes(s) - before).toBe(1);
		expect(s.tt.get(s.ttIdOf("Tidy"))?.tags).toEqual(["calls"]);
		// The child tags' tasks are not sent again.
		expect(s.tt.get(s.ttIdOf("Ring mum"))).toEqual(ring);
		expect(s.tt.get(s.ttIdOf("Weed"))).toEqual(weed);
		// TickTick's tags stay as they were: "calls" keeps its parent there.
		expect(s.tt.tags).toEqual(ttTags);
		expect(s.tt.tags.get("calls")).toEqual({ name: "calls", label: "Calls", parent: "home" });
		expect(s.tt.calls.some((c) => c.startsWith("deleteTag") || c.startsWith("updateTag"))).toBe(false);
		// The pull does not bring the parent back.
		expect(s.h.app.store.state.tags.has("home")).toBe(false);

		s.tick();
		const settled = taskPushes(s);
		const tagCreates = s.tt.count("createTag");
		await s.sync.sync();
		expect(taskPushes(s)).toBe(settled);
		expect(s.tt.count("createTag")).toBe(tagCreates);
		expect(s.task("Ring mum").tagKeys).toEqual(["calls"]);
		expect([...s.h.app.store.state.tags.keys()].sort()).toEqual(["calls", "garden"]);
	});
});

describe("pulling a nested TickTick tag", () => {
	it("creates the Logwell parent tag before the child, even when TickTick has no record of the parent", async () => {
		const s = await syncHarness();
		const { projectId } = await linkedList(s);
		s.tt.addTag("garden", "Garden", "outdoor");
		s.tt.add(projectId, { title: "Mow", tags: ["garden"] });
		await s.sync.sync();
		expect(s.task("Mow").tagKeys).toEqual(["outdoor/garden"]);
		const keys = [...s.h.app.store.state.tags.keys()];
		expect(keys).toContain("outdoor");
		expect(keys.indexOf("outdoor")).toBeLessThan(keys.indexOf("outdoor/garden"));
		expect(s.h.app.store.state.tags.get("outdoor")?.displayName).toBe("outdoor");
	});
});
