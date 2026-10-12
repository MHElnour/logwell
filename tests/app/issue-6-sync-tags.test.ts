import { describe, expect, it } from "vitest";
import { TickTickError } from "../../src/app/ports";
import { TICKTICK_TAGS_UNREAD_WARNING } from "../../src/app/SyncService";
import { tagNamesOf } from "../../src/domain/tags";
import { isSyncedTag } from "../../src/domain/ticktick/tags";
import { syncLinkId } from "../../src/domain/types";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";

// Tags sync both ways. A TickTick task carries lowercase tag names (the leaf, never a
// path); the sync makes sure TickTick has a tag record for each (parent first), reads TickTick's tags at most once
// per sync, and merges the set of names per field like any other field.

const pushes = (s: SyncHarness) => s.tt.count("batchTasks") + s.tt.count("updateTask") + s.tt.count("createTask") + s.tt.count("createTag");

async function setup(): Promise<SyncHarness & { listId: string; projectId: string }> {
	const s = await syncHarness();
	const { listId, projectId } = await linkedList(s);
	return Object.assign(s, { listId, projectId });
}

describe("push", () => {
	it("creates the tag records parent first and sends the leaf names", async () => {
		const s = await setup();
		await s.h.app.tags.create("Home/Calls");
		await s.h.app.tags.create("Errands");
		await s.h.app.tasks.create({ title: "Ring mum", categoryId: s.listId, tagKeys: ["home/calls", "errands"] });
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		const tt = s.tt.get(s.ttIdOf("Ring mum"))!;
		expect([...(tt.tags ?? [])].sort()).toEqual(["calls", "errands"]);
		expect(s.tt.tags.get("home")).toEqual({ name: "home", label: "Home" });
		expect(s.tt.tags.get("calls")).toEqual({ name: "calls", label: "Calls", parent: "home" });
		expect(s.tt.tags.get("errands")).toEqual({ name: "errands", label: "Errands" });
		const creates = s.tt.calls.filter((c) => c.startsWith("createTag:"));
		expect(creates.indexOf("createTag:home")).toBeLessThan(creates.indexOf("createTag:calls"));
		expect(s.tt.count("listTags")).toBe(1);
		// Stable: nothing more to do.
		const n = pushes(s);
		s.tick();
		await s.sync.sync();
		expect(pushes(s)).toBe(n);
		expect(s.tt.count("listTags")).toBe(1);
	});

	it("creates only the missing records; a name TickTick has under another parent creates no parent", async () => {
		const s = await setup();
		s.tt.addTag("calls", "Calls", "work");
		await s.h.app.tags.create("Home/Calls");
		await s.h.app.tags.create("Home/Garden");
		await s.h.app.tasks.create({ title: "Ring mum", categoryId: s.listId, tagKeys: ["home/calls"] });
		await s.sync.sync();
		expect(s.tt.calls.filter((c) => c.startsWith("createTag:"))).toEqual([]);
		expect(s.tt.get(s.ttIdOf("Ring mum"))?.tags).toEqual(["calls"]);
		await s.h.app.tasks.create({ title: "Weed", categoryId: s.listId, tagKeys: ["home/garden"] });
		s.tick();
		await s.sync.sync();
		expect(s.tt.calls.filter((c) => c.startsWith("createTag:"))).toEqual(["createTag:home", "createTag:garden"]);
	});

	it("removing a task's tags reads no TickTick tags", async () => {
		const s = await setup();
		await s.h.app.tags.create("Bills");
		const { task } = await s.h.app.tasks.create({ title: "Pay rent", categoryId: s.listId, tagKeys: ["bills"] });
		await s.sync.sync();
		const before = s.tt.count("listTags");
		s.tick();
		await s.h.app.tasks.update(task.id, { tagKeys: [] });
		await s.sync.sync();
		expect(s.tt.count("listTags")).toBe(before);
		expect(s.tt.get(s.ttIdOf("Pay rent"))?.tags).toEqual([]);
	});

	it("a failed tag read in the push is not repeated per list; the tags still go up", async () => {
		const s = await setup();
		const other = await linkedList(s, "Home");
		await s.h.app.tags.create("Bills");
		await s.h.app.tasks.create({ title: "Pay rent", categoryId: s.listId, tagKeys: ["bills"] });
		await s.h.app.tasks.create({ title: "Pay water", categoryId: other.listId, tagKeys: ["bills"] });
		s.tt.fail("listTags", new TickTickError("server", "TickTick: server error (HTTP 500)", { status: 500 }));
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(s.tt.count("listTags")).toBe(1);
		expect(s.tt.findByTitle("Pay rent")?.tags).toEqual(["bills"]);
		expect(s.tt.findByTitle("Pay water")?.tags).toEqual(["bills"]);
		expect(s.tt.tags.get("bills")).toEqual({ name: "bills", label: "Bills" });
	});

	it("pushes a tag added in Logwell to a synced task", async () => {
		const s = await setup();
		const { task } = await s.h.app.tasks.create({ title: "Pay rent", categoryId: s.listId });
		await s.sync.sync();
		s.tick();
		await s.h.app.tags.create("Bills");
		await s.h.app.tasks.update(task.id, { tagKeys: ["bills"] });
		await s.sync.sync();
		expect(s.tt.get(s.ttIdOf("Pay rent"))?.tags).toEqual(["bills"]);
	});

	it("a later duplicate tag is not pushed, is reported as not synced, and causes no repeated push", async () => {
		const s = await setup();
		await s.h.app.store.run("Seed", (tx) => {
			tx.put("tags", { key: "home/calls", displayName: "Home/Calls", color: null, createdAt: "2026-10-01T10:00:00Z", modifiedAt: "2026-10-01T10:00:00Z" });
			tx.put("tags", { key: "work/calls", displayName: "Work/Calls", color: null, createdAt: "2026-10-02T10:00:00Z", modifiedAt: "2026-10-02T10:00:00Z" });
			tx.put("tags", { key: "plain", displayName: "Plain", color: null, createdAt: "2026-10-01T10:00:00Z", modifiedAt: "2026-10-01T10:00:00Z" });
		});
		await s.h.app.tasks.create({ title: "Ring the office", categoryId: s.listId, tagKeys: ["work/calls", "plain"] });
		await s.sync.sync();
		expect(s.tt.get(s.ttIdOf("Ring the office"))?.tags).toEqual(["plain"]);
		expect(s.tt.tags.has("calls")).toBe(false);
		const names = tagNamesOf(s.h.app.store.state.tags);
		expect(isSyncedTag(names, "work/calls")).toBe(false);
		expect(isSyncedTag(names, "plain")).toBe(true);
		const n = pushes(s);
		s.tick();
		await s.sync.sync();
		expect(pushes(s)).toBe(n);
		// The Logwell task keeps its tags.
		expect(s.task("Ring the office").tagKeys).toEqual(["work/calls", "plain"]);
	});

	it("a tag record TickTick refuses stops that list only (SYNC-12), and the next sync sends it", async () => {
		const s = await setup();
		const other = await linkedList(s, "Home");
		await s.h.app.tags.create("Bills");
		await s.h.app.tasks.create({ title: "Pay rent", categoryId: s.listId, tagKeys: ["bills"] });
		await s.h.app.tasks.create({ title: "Water plants", categoryId: other.listId });
		s.tt.fail("createTag", new TickTickError("server", "TickTick: server error (HTTP 500)", { status: 500 }));
		const r = await s.sync.sync();
		expect(r.ok).toBe(false);
		expect(r.failures.map((f) => f.listId)).toEqual([s.listId]);
		expect(s.tt.findByTitle("Pay rent")).toBeUndefined();
		expect(s.tt.findByTitle("Water plants")?.projectId).toBe(other.projectId);
		s.tick();
		expect((await s.sync.sync()).ok).toBe(true);
		expect(s.tt.findByTitle("Pay rent")?.tags).toEqual(["bills"]);
		expect(s.tt.count("listTags")).toBe(2);
	});

	it("keeps TickTick names Logwell cannot hold when it pushes a tag change", async () => {
		const s = await setup();
		const tt = s.tt.add(s.projectId, { title: "Shop", tags: ["two words"] });
		await s.sync.sync();
		s.tick();
		expect(s.task("Shop").tagKeys).toEqual([]);
		await s.h.app.tags.create("Food");
		await s.h.app.tasks.update(s.task("Shop").id, { tagKeys: ["food"] });
		await s.sync.sync();
		expect([...(s.tt.get(tt.id)?.tags ?? [])].sort()).toEqual(["food", "two words"]);
	});
});

describe("pull", () => {
	it("matches a name to the Logwell tag with that leaf, case-insensitively, keeping Logwell's key", async () => {
		const s = await setup();
		await s.h.app.tags.create("Home/Calls");
		s.tt.add(s.projectId, { title: "Ring mum", tags: ["Calls"] });
		await s.sync.sync();
		expect(s.task("Ring mum").tagKeys).toEqual(["home/calls"]);
		expect(s.h.app.store.state.tags.get("home/calls")?.displayName).toBe("Home/Calls");
		expect(s.tt.count("listTags")).toBe(0);
	});

	it("creates an unknown tag from TickTick's record, with its parent", async () => {
		const s = await setup();
		s.tt.addTag("outdoor", "Outdoor");
		s.tt.addTag("garden", "Garden", "outdoor");
		s.tt.add(s.projectId, { title: "Mow", tags: ["garden"] });
		s.tt.add(s.projectId, { title: "Rake", tags: ["garden"] });
		await s.sync.sync();
		expect(s.task("Mow").tagKeys).toEqual(["outdoor/garden"]);
		expect(s.task("Rake").tagKeys).toEqual(["outdoor/garden"]);
		const tags = s.h.app.store.state.tags;
		expect(tags.get("outdoor")?.displayName).toBe("Outdoor");
		expect(tags.get("outdoor/garden")?.displayName).toBe("Outdoor/Garden");
		expect(s.tt.count("listTags")).toBe(1);
		expect(s.tt.count("createTag")).toBe(0);
		// Nothing to push back.
		const n = pushes(s);
		s.tick();
		await s.sync.sync();
		expect(pushes(s)).toBe(n);
	});

	it("an unknown name with no TickTick record becomes a tag of that name", async () => {
		const s = await setup();
		s.tt.add(s.projectId, { title: "Read", tags: ["books"] });
		await s.sync.sync();
		expect(s.task("Read").tagKeys).toEqual(["books"]);
		expect(s.h.app.store.state.tags.get("books")?.displayName).toBe("books");
	});

	it("a TickTick parent whose name is a Logwell child tag does not nest a second level", async () => {
		const s = await setup();
		await s.h.app.tags.create("Work/Outdoor");
		s.tt.addTag("outdoor", "Outdoor");
		s.tt.addTag("garden", "Garden", "outdoor");
		s.tt.add(s.projectId, { title: "Mow", tags: ["garden"] });
		await s.sync.sync();
		expect(s.task("Mow").tagKeys).toEqual(["garden"]);
	});

	it("pulls a tag added in TickTick to a synced task", async () => {
		const s = await setup();
		const { task } = await s.h.app.tasks.create({ title: "Pay rent", categoryId: s.listId });
		await s.sync.sync();
		s.tick();
		s.tt.edit(s.ttIdOf("Pay rent"), { tags: ["bills"] });
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(task.id)?.tagKeys).toEqual(["bills"]);
	});

	it("reads TickTick's tags at most once per sync, and not at all without tags", async () => {
		const s = await setup();
		await s.h.app.tasks.create({ title: "Plain", categoryId: s.listId });
		await s.sync.sync();
		expect(s.tt.count("listTags")).toBe(0);
		s.tick();
		for (const name of ["a", "b", "c"]) s.tt.add(s.projectId, { title: `Pulled ${name}`, tags: [name] });
		await s.h.app.tags.create("Home/Calls");
		await s.h.app.tags.create("Errands");
		await s.h.app.tasks.create({ title: "Pushed", categoryId: s.listId, tagKeys: ["home/calls", "errands"] });
		await s.sync.sync();
		expect(s.tt.count("listTags")).toBe(1);
		s.tick();
		await s.sync.sync();
		expect(s.tt.count("listTags")).toBe(1);
	});

	it("a pulled name that is a Logwell parent tag maps to that tag and stays on the TickTick task", async () => {
		const s = await setup();
		await s.h.app.tags.create("Home/Calls");
		s.tt.add(s.projectId, { title: "Clean", tags: ["home"] });
		await s.sync.sync();
		s.tick();
		await s.sync.sync();
		const clean = s.task("Clean");
		expect(clean.tagKeys).toEqual(["home"]);
		expect(s.tt.get(s.ttIdOf("Clean"))?.tags).toEqual(["home"]);
		expect(isSyncedTag(tagNamesOf(s.h.app.store.state.tags), "home")).toBe(true);
	});

	it("a tag read that fails for another reason is reported as a warning", async () => {
		const s = await setup();
		s.tt.addTag("outdoor", "Outdoor");
		s.tt.addTag("garden", "Garden", "outdoor");
		s.tt.add(s.projectId, { title: "Mow", tags: ["garden"] });
		s.tt.fail("listTags", new TickTickError("server", "TickTick: server error (HTTP 500)", { status: 500 }));
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(r.warnings).toEqual([TICKTICK_TAGS_UNREAD_WARNING]);
		expect(TICKTICK_TAGS_UNREAD_WARNING).toBe("TickTick tags could not be read; tags were synced by name only.");
		expect(s.task("Mow").tagKeys).toEqual(["garden"]);
		s.tick();
		const next = await s.sync.sync();
		expect(next.warnings).toEqual([]);
	});

	it("a tag read TickTick refuses does not stop the sync: an unknown name becomes a tag of that name", async () => {
		const s = await setup();
		const other = await linkedList(s, "Home");
		await s.h.app.tasks.create({ title: "Local", categoryId: other.listId });
		s.tt.add(s.projectId, { title: "Remote", tags: ["garden"] });
		s.tt.fail("listTags", new TickTickError("bad-response", "TickTick: unexpected answer (a list was expected).", {}));
		const r = await s.sync.sync();
		expect(r.ok).toBe(true);
		expect(s.task("Remote").tagKeys).toEqual(["garden"]);
		expect(s.tt.findByTitle("Local")?.projectId).toBe(other.projectId);
		expect(s.tt.count("listTags")).toBe(1);
	});

	it("a token error on the tag read still stops the whole sync", async () => {
		const s = await setup();
		s.tt.add(s.projectId, { title: "Remote", tags: ["garden"] });
		s.tt.fail("listTags", new TickTickError("unauthorized", "TickTick: the API token was refused (HTTP 401)", { status: 401 }));
		const r = await s.sync.sync();
		expect(r.ok).toBe(false);
		expect(r.error?.kind).toBe("unauthorized");
		expect(s.tasks("Remote")).toHaveLength(0);
	});

	it("an unknown name on a task that is never taken in (repeating, completed) reads no tags", async () => {
		const s = await setup();
		s.tt.add(s.projectId, { title: "Weekly", tags: ["chores"], repeatFlag: "RRULE:FREQ=WEEKLY" });
		await s.sync.sync();
		s.tick();
		await s.sync.sync();
		expect(s.tt.count("listTags")).toBe(0);
		expect(s.h.app.store.state.tags.size).toBe(0);
	});
});

describe("merge (SYNC-07)", () => {
	it("tags changed on both sides keep Logwell's and make TickTick's version a copy", async () => {
		const s = await setup();
		await s.h.app.tags.create("Bills");
		await s.h.app.tags.create("Urgent");
		const { task } = await s.h.app.tasks.create({ title: "Pay rent", categoryId: s.listId });
		await s.sync.sync();
		s.tick();
		const ttId = s.ttIdOf("Pay rent");
		await s.h.app.tasks.update(task.id, { tagKeys: ["bills"] });
		s.tt.edit(ttId, { tags: ["urgent"] });
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(task.id)?.tagKeys).toEqual(["bills"]);
		expect(s.tt.get(ttId)?.tags).toEqual(["bills"]);
		expect(s.task("Pay rent (TickTick)").tagKeys).toEqual(["urgent"]);
	});

	it("a tag change on one side and a title change on the other both apply", async () => {
		const s = await setup();
		await s.h.app.tags.create("Bills");
		const { task } = await s.h.app.tasks.create({ title: "Pay rent", categoryId: s.listId });
		await s.sync.sync();
		s.tick();
		const ttId = s.ttIdOf("Pay rent");
		await s.h.app.tasks.update(task.id, { tagKeys: ["bills"] });
		s.tt.edit(ttId, { title: "Pay the rent" });
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(task.id)).toMatchObject({ title: "Pay the rent", tagKeys: ["bills"] });
		expect(s.tt.get(ttId)).toMatchObject({ title: "Pay the rent", tags: ["bills"] });
		expect(s.tasks("Pay the rent (TickTick)")).toHaveLength(0);
	});

	it("a pulled tag change keeps the Logwell task's duplicate tags", async () => {
		const s = await setup();
		await s.h.app.store.run("Seed", (tx) => {
			tx.put("tags", { key: "home/calls", displayName: "Home/Calls", color: null, createdAt: "2026-10-01T10:00:00Z", modifiedAt: "2026-10-01T10:00:00Z" });
			tx.put("tags", { key: "work/calls", displayName: "Work/Calls", color: null, createdAt: "2026-10-02T10:00:00Z", modifiedAt: "2026-10-02T10:00:00Z" });
		});
		const { task } = await s.h.app.tasks.create({ title: "Ring", categoryId: s.listId, tagKeys: ["work/calls"] });
		await s.sync.sync();
		s.tick();
		s.tt.edit(s.ttIdOf("Ring"), { tags: ["extra"] });
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(task.id)?.tagKeys).toEqual(["work/calls", "extra"]);
	});

	it("a link with no tags hash treats it like any missing field hash: an unchanged TickTick copy takes Logwell's tags", async () => {
		const s = await setup();
		await s.h.app.tags.create("Bills");
		const { task } = await s.h.app.tasks.create({ title: "Pay rent", categoryId: s.listId, tagKeys: ["bills"] });
		await s.sync.sync();
		s.tick();
		const ttId = s.ttIdOf("Pay rent");
		await s.h.app.store.run(
			"Seed",
			(tx) => {
				const link = tx.get("syncLinks", syncLinkId("task", task.id))!;
				const { tags: _tags, ...base } = link.base;
				tx.put("syncLinks", { ...link, base });
			},
			{ undoable: false },
		);
		const stored = s.tt.tasks.get(ttId)!;
		s.tt.tasks.set(ttId, { ...stored, tags: ["urgent"] });
		await s.sync.sync();
		expect(s.h.app.store.state.tasks.get(task.id)?.tagKeys).toEqual(["bills"]);
		expect(s.tt.get(ttId)?.tags).toEqual(["bills"]);
		expect(s.tasks("Pay rent (TickTick)")).toHaveLength(0);
		expect(s.link("task", task.id)?.base.tags).toBeDefined();
	});
});
