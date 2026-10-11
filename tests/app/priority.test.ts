import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildList } from "../../src/app/views";
import { emptyFilter, quadrantOf } from "../../src/domain/queries";
import { type Priority, type TagColor } from "../../src/domain/types";
import { CURRENT_SCHEMA_VERSION } from "../../src/persistence/schema";
import { appHarness } from "./harness";

// Priority defaults, its independence from the matrix, sort and filter, and the list icon and color commands.

describe("PRI-01: priority defaults", () => {
	it("every created task and subtask, and a duplicate of a prioritised task, has the right priority", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "A" });
		expect(task.priority).toBe(0);
		const { task: sub } = await h.app.tasks.create({ title: "Sub", parentId: task.id });
		expect(sub.priority).toBe(0);
		const { task: high } = await h.app.tasks.create({ title: "B", priority: 1 });
		expect(high.priority).toBe(1);
		const copy = await h.app.tasks.duplicate(high.id);
		expect(copy.priority).toBe(1);
		await expect(h.app.tasks.create({ title: "C", priority: 7 as Priority })).rejects.toMatchObject({ code: "InvalidValue" });
	});
});

describe("PRI-04: priority is independent of the matrix", () => {
	it("setPriority changes only priority and modifiedAt, and can be undone", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "A", urgent: true });
		h.clock.advance(60_000);
		const next = await h.app.tasks.setPriority(task.id, 2);
		expect(next).toEqual({ ...task, priority: 2, modifiedAt: next.modifiedAt });
		expect(next.modifiedAt > task.modifiedAt).toBe(true);
		expect(h.app.store.state.tasks.get(task.id)?.priority).toBe(2);
		await h.app.store.undo();
		expect(h.app.store.state.tasks.get(task.id)).toEqual(task);
	});

	it("setting the same priority is a no-op (no modifiedAt change)", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "A", priority: 3 });
		h.clock.advance(60_000);
		expect(await h.app.tasks.setPriority(task.id, 3)).toEqual(task);
	});

	it("rejects an invalid priority and an unknown task", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "A" });
		await expect(h.app.tasks.setPriority(task.id, 4 as Priority)).rejects.toMatchObject({ code: "InvalidValue" });
		await expect(h.app.tasks.setPriority("nope", 1)).rejects.toMatchObject({ code: "NotFound" });
	});

	it("setting urgent or important leaves priority unchanged, and quadrantOf ignores priority", async () => {
		const h = await appHarness();
		const { task } = await h.app.tasks.create({ title: "A", priority: 1 });
		const { task: t2 } = await h.app.tasks.update(task.id, { urgent: true, important: true });
		expect(t2.priority).toBe(1);
		expect(h.app.store.state.tasks.get(task.id)?.priority).toBe(1);
		for (const [urgent, important] of [[false, false], [false, true], [true, false], [true, true]] as const) {
			const results = ([0, 1, 2, 3] as const).map((priority) => quadrantOf({ ...t2, urgent, important, priority }));
			expect(new Set(results).size).toBe(1);
		}
	});

	it("quadrantOf's source never mentions priority", () => {
		const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "domain", "queries.ts"), "utf8");
		const start = src.indexOf("export function quadrantOf");
		const body = src.slice(start, src.indexOf("\n}\n", start));
		expect(body.length).toBeGreaterThan(20);
		expect(body.toLowerCase()).not.toContain("priority");
	});
});

describe("PRI-05: sort and filter by priority", () => {
	async function seed() {
		const h = await appHarness();
		const mk = async (title: string, priority: Priority) => (await h.app.tasks.create({ title, priority })).task;
		const none1 = await mk("none1", 0);
		const low = await mk("low", 3);
		const high = await mk("high", 1);
		const none2 = await mk("none2", 0);
		const med = await mk("med", 2);
		return { h, none1, low, high, none2, med };
	}
	const titles = (g: ReturnType<typeof buildList>["groups"]) => g.flatMap((x) => x.entries.map((e) => e.task.title));

	it("sorts high, medium, low, none with ties in the existing order", async () => {
		const { h } = await seed();
		const ctx = h.app.queryContext();
		const base = titles(buildList(h.app.store.state, { kind: "inbox" }, ctx, emptyFilter(), "").groups);
		expect(base).toEqual(["none1", "low", "high", "none2", "med"]);
		const sorted = titles(buildList(h.app.store.state, { kind: "inbox" }, ctx, { ...emptyFilter(), sort: "priority" }, "").groups);
		expect(sorted).toEqual(["high", "med", "low", "none1", "none2"]);
	});

	it("keeps subtasks under their parent when sorting by priority", async () => {
		const { h, none1, high } = await seed();
		await h.app.tasks.create({ title: "sub-of-none1", parentId: none1.id, priority: 1 });
		const ctx = h.app.queryContext();
		const rows = buildList(h.app.store.state, { kind: "inbox" }, ctx, { ...emptyFilter(), sort: "priority" }, "").groups[0]!.entries;
		const i = rows.findIndex((e) => e.task.id === none1.id);
		expect(rows[i + 1]?.task.title).toBe("sub-of-none1");
		expect(rows[i + 1]?.depth).toBe(1);
		expect(rows[0]?.task.id).toBe(high.id);
	});

	it("filters by any of the chosen priorities (none included), combined with other filters by AND", async () => {
		const { h, high, none1, none2, med } = await seed();
		const ctx = h.app.queryContext();
		const ids = (f: ReturnType<typeof emptyFilter>) =>
			new Set(buildList(h.app.store.state, { kind: "inbox" }, ctx, f, "").groups[0]!.entries.map((e) => e.task.id));
		expect(ids({ ...emptyFilter(), priorities: [1, 2] })).toEqual(new Set([high.id, med.id]));
		expect(ids({ ...emptyFilter(), priorities: [0] })).toEqual(new Set([none1.id, none2.id]));
		expect(ids({ ...emptyFilter(), priorities: [] }).size).toBe(5);
		await h.app.tasks.update(high.id, { important: true });
		expect(ids({ ...emptyFilter(), priorities: [1, 2], quadrants: ["important"] })).toEqual(new Set([high.id]));
	});
});

describe("category icon and color commands", () => {
	it("setIcon / setColor go through the queue, undo, and accept Lucide names, emoji, null", async () => {
		const h = await appHarness();
		const c = await h.app.categories.create("Study", "📖");
		expect(c.color).toBe("red"); // the first new list takes the first palette color
		h.clock.advance(1000);
		const a = await h.app.categories.setIcon(c.id, "book-open");
		expect(a.icon).toBe("book-open");
		expect(a.modifiedAt > c.modifiedAt).toBe(true);
		const b = await h.app.categories.setColor(c.id, "blue");
		expect(b).toEqual({ ...a, color: "blue", modifiedAt: b.modifiedAt });
		await h.app.store.undo();
		expect(h.app.categories.list().find((x) => x.id === c.id)?.color).toBe("red");
		await h.app.store.undo();
		expect(h.app.categories.list().find((x) => x.id === c.id)?.icon).toBe("📖");
		expect((await h.app.categories.setIcon(c.id, "📖")).icon).toBe("📖"); // legacy emoji accepted unchanged
		expect((await h.app.categories.setIcon(c.id, null)).icon).toBeNull();
	});

	it("rejects an invalid icon name and an invalid color, and unknown categories", async () => {
		const h = await appHarness();
		const c = await h.app.categories.create("Study");
		await expect(h.app.categories.setIcon(c.id, "Book Open!")).rejects.toMatchObject({ code: "InvalidValue" });
		await expect(h.app.categories.setIcon(c.id, "a".repeat(41))).rejects.toMatchObject({ code: "InvalidValue" });
		await expect(h.app.categories.setColor(c.id, "mauve" as TagColor)).rejects.toMatchObject({ code: "InvalidValue" });
		await expect(h.app.categories.setColor("nope", "red")).rejects.toMatchObject({ code: "NotFound" });
		await expect(h.app.categories.setIcon("nope", null)).rejects.toMatchObject({ code: "NotFound" });
	});

	it("works on the Inbox too", async () => {
		const h = await appHarness();
		expect((await h.app.categories.setColor("inbox", "green")).color).toBe("green");
	});
});

describe("PRI-05: global search honors the priority sort and filter", () => {
	it("orders open results by priority, then title, and filters by priority", async () => {
		const { globalSearch } = await import("../../src/app/views");
		const h = await appHarness();
		await h.app.tasks.create({ title: "x-a none" });
		await h.app.tasks.create({ title: "x-b low", priority: 3 });
		await h.app.tasks.create({ title: "x-c high", priority: 1 });
		const ctx = h.app.queryContext();
		const names = (f: ReturnType<typeof emptyFilter>) => globalSearch(h.app.store.state, "x", ctx, f).tasks.map((e) => e.task.title);
		expect(names(emptyFilter())).toEqual(["x-a none", "x-b low", "x-c high"]);
		expect(names({ ...emptyFilter(), sort: "priority" })).toEqual(["x-c high", "x-b low", "x-a none"]);
		expect(names({ ...emptyFilter(), priorities: [0, 3] })).toEqual(["x-a none", "x-b low"]);
	});
});

describe("PRI-01: importing a v1 backup", () => {
	it("migrates it forward: priority 0, color null, and the import applies", async () => {
		const text = readFileSync(join(import.meta.dirname, "..", "fixtures", "schema-v1.cpbase"), "utf8");
		const h = await appHarness();
		const r = h.app.data.previewImport(text);
		if (!r.ok) throw new Error(r.message);
		expect(r.preview.migratedFrom).toBe(1);
		expect(r.preview.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		await h.app.data.importReplace(r.preview);
		const tasks = [...h.app.store.state.tasks.values()];
		expect(tasks.length).toBeGreaterThan(0);
		for (const t of tasks) expect(t.priority).toBe(0);
		for (const c of h.app.categories.list()) expect(c.color).toBeNull();
	});
});
