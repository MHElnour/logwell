import { describe, expect, it } from "vitest";
import { appHarness } from "./harness";

// TaskService.place.

async function setup() {
	const h = await appHarness();
	const ids: string[] = [];
	for (let i = 0; i < 3; i++) ids.push((await h.app.tasks.create({ title: `T${i}` })).task.id);
	return { h, ids };
}

const order = (h: Awaited<ReturnType<typeof appHarness>>) =>
	[...h.app.store.state.tasks.values()].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0)).map((t) => t.title);

/** Rewrites sort keys directly, for a state the UI can reach (equal keys across lists). */
async function setKeys(h: Awaited<ReturnType<typeof appHarness>>, keys: Record<string, string>) {
	for (const [id, sortKey] of Object.entries(keys)) {
		await h.app.store.run("Test setup", (tx) => {
			tx.put("tasks", { ...tx.get("tasks", id)!, sortKey });
		}, { undoable: false });
	}
}

describe("place", () => {
	it("moves a task to the first, middle and last place, with one undo entry each", async () => {
		const { h, ids } = await setup();
		const [a, b, c] = ids as [string, string, string];
		let r = await h.app.tasks.place(c, [c, a, b]);
		expect(r.changed).toBe(true);
		expect(order(h)).toEqual(["T2", "T0", "T1"]);
		r = await h.app.tasks.place(c, [a, c, b]);
		expect(order(h)).toEqual(["T0", "T2", "T1"]);
		r = await h.app.tasks.place(c, [a, b, c]);
		expect(order(h)).toEqual(["T0", "T1", "T2"]);
		expect(h.app.store.undoLabel).toBe("Move task");
		await h.app.store.undo();
		expect(order(h)).toEqual(["T0", "T2", "T1"]);
	});

	it("changes only the moved task's key when neighbours are strictly ordered", async () => {
		const { h, ids } = await setup();
		const [a, b, c] = ids as [string, string, string];
		const before = new Map([...h.app.store.state.tasks].map(([id, t]) => [id, t.sortKey]));
		await h.app.tasks.place(a, [b, a, c]);
		expect(h.app.store.state.tasks.get(b)!.sortKey).toBe(before.get(b));
		expect(h.app.store.state.tasks.get(c)!.sortKey).toBe(before.get(c));
		expect(h.app.store.state.tasks.get(a)!.sortKey).not.toBe(before.get(a));
	});

	it("rebalances the whole order in one run when neighbour keys are equal", async () => {
		const { h, ids } = await setup();
		const [a, b, c] = ids as [string, string, string];
		await setKeys(h, { [a]: "M", [b]: "M", [c]: "M" });
		const undoBefore = h.app.store.undoLabel;
		const r = await h.app.tasks.place(c, [a, c, b]);
		expect(r.changed).toBe(true);
		const keys = [a, c, b].map((id) => h.app.store.state.tasks.get(id)!.sortKey);
		expect(keys[0]! < keys[1]! && keys[1]! < keys[2]!).toBe(true);
		expect(order(h)).toEqual(["T0", "T2", "T1"]);
		await h.app.store.undo();
		expect(h.app.store.undoLabel).toBe(undoBefore);
		expect([a, b, c].map((id) => h.app.store.state.tasks.get(id)!.sortKey)).toEqual(["M", "M", "M"]);
	});

	it("applies the patch in the same run (one undo entry) and keeps DST warnings", async () => {
		const { h, ids } = await setup();
		const [a, b, c] = ids as [string, string, string];
		const r = await h.app.tasks.place(c, [c, a, b], { scheduled: { kind: "datetime", local: "2026-03-29T02:30", tz: "Europe/Berlin" } });
		expect(r.changed).toBe(true);
		expect(r.warnings.length).toBeGreaterThan(0);
		expect(h.app.store.state.tasks.get(c)!.scheduled).not.toBeNull();
		expect(order(h)[0]).toBe("T2");
		await h.app.store.undo();
		expect(h.app.store.state.tasks.get(c)!.scheduled).toBeNull();
		expect(order(h)).toEqual(["T0", "T1", "T2"]);
	});

	it("a patch alone changes the date and keeps the key", async () => {
		const { h, ids } = await setup();
		const [a, b, c] = ids as [string, string, string];
		const key = h.app.store.state.tasks.get(b)!.sortKey;
		const r = await h.app.tasks.place(b, [a, b, c], { scheduled: { kind: "date", date: "2026-10-05" } });
		expect(r.changed).toBe(true);
		expect(h.app.store.state.tasks.get(b)!.sortKey).toBe(key);
	});

	it("a priority in the patch is written with the position, in one undo entry", async () => {
		const { h, ids } = await setup();
		const [a, b, c] = ids as [string, string, string];
		const label = h.app.store.undoLabel;
		const r = await h.app.tasks.place(c, [c, a, b], { priority: 1 });
		expect(r.changed).toBe(true);
		expect(h.app.store.state.tasks.get(c)!.priority).toBe(1);
		expect(order(h)[0]).toBe("T2");
		// urgent and important are untouched.
		expect(h.app.store.state.tasks.get(c)).toMatchObject({ urgent: false, important: false });
		await h.app.store.undo();
		expect(h.app.store.state.tasks.get(c)!.priority).toBe(0);
		expect(order(h)).toEqual(["T0", "T1", "T2"]);
		expect(h.app.store.undoLabel).toBe(label);
		// The same priority and the same place write nothing.
		const same = await h.app.tasks.place(b, [a, b, c], { priority: 0 });
		expect(same.changed).toBe(false);
		await expect(h.app.tasks.place(b, [a, b, c], { priority: 9 as never })).rejects.toMatchObject({ code: "InvalidValue" });
	});

	it("the priority patch rejects invalid values, keeps urgent and important, and counts as a change alone", async () => {
		const { h, ids } = await setup();
		const [a, b, c] = ids as [string, string, string];
		for (const bad of [5, -1, 1.5]) {
			await expect(h.app.tasks.place(b, [a, b, c], { priority: bad as never })).rejects.toMatchObject({ code: "InvalidValue" });
			await expect(h.app.tasks.update(b, { priority: bad as never })).rejects.toMatchObject({ code: "InvalidValue" });
		}
		expect(h.app.store.state.tasks.get(b)!.priority).toBe(0);
		// The same priority writes nothing.
		expect((await h.app.tasks.update(b, { priority: 0 })).changed).toBe(false);
		// Only the priority changes and the order stays: still a change.
		const r = await h.app.tasks.place(b, [a, b, c], { priority: 2 });
		expect(r.changed).toBe(true);
		expect(order(h)).toEqual(["T0", "T1", "T2"]);
		const u = await h.app.tasks.update(a, { priority: 3 });
		expect(u.changed).toBe(true);
		for (const id of [a, b]) expect(h.app.store.state.tasks.get(id)).toMatchObject({ urgent: false, important: false });
		expect(h.app.store.state.tasks.get(a)!.priority).toBe(3);
		expect(h.app.store.state.tasks.get(b)!.priority).toBe(2);
	});

	it("reports changed: false and writes no undo entry when nothing moved", async () => {
		const { h, ids } = await setup();
		const [a, b, c] = ids as [string, string, string];
		const label = h.app.store.undoLabel;
		const before = h.app.store.state.tasks.get(b);
		const r = await h.app.tasks.place(b, [a, b, c]);
		expect(r.changed).toBe(false);
		expect(h.app.store.state.tasks.get(b)).toBe(before);
		expect(h.app.store.undoLabel).toBe(label);
		const same = await h.app.tasks.place(b, [b], { scheduled: null });
		expect(same.changed).toBe(false);
		expect(h.app.store.undoLabel).toBe(label);
	});

	it("reorders a subtask among its siblings", async () => {
		const h = await appHarness();
		const p = (await h.app.tasks.create({ title: "P" })).task;
		const s1 = (await h.app.tasks.create({ title: "S1", parentId: p.id })).task;
		const s2 = (await h.app.tasks.create({ title: "S2", parentId: p.id })).task;
		await h.app.tasks.place(s2.id, [s2.id, s1.id]);
		const keys = (id: string) => h.app.store.state.tasks.get(id)!.sortKey;
		expect(keys(s2.id) < keys(s1.id)).toBe(true);
	});

	it("rejects an order that mixes parents, or an id not in it, and writes nothing", async () => {
		const h = await appHarness();
		const p = (await h.app.tasks.create({ title: "P" })).task;
		const q = (await h.app.tasks.create({ title: "Q" })).task;
		const s = (await h.app.tasks.create({ title: "S", parentId: p.id })).task;
		const label = h.app.store.undoLabel;
		await expect(h.app.tasks.place(s.id, [q.id, s.id])).rejects.toMatchObject({ code: "InvalidValue" });
		await expect(h.app.tasks.place(q.id, [p.id])).rejects.toMatchObject({ code: "InvalidValue" });
		await expect(h.app.tasks.place(q.id, [q.id, "missing"])).rejects.toMatchObject({ code: "NotFound" });
		expect(h.app.store.undoLabel).toBe(label);
	});

	describe("rebalance keeps every task's place in every view", () => {
		const key = (h: Awaited<ReturnType<typeof appHarness>>, id: string) => h.app.store.state.tasks.get(id)!.sortKey;
		const ascending = (keys: string[]) => keys.every((k, n) => n === 0 || keys[n - 1]! < k);

		it("rebalances equal keys across categories inside (lo, hi) and later creations land after", async () => {
			const h = await appHarness();
			const x = (await h.app.categories.create("X")).id;
			const y = (await h.app.categories.create("Y")).id;
			const i0 = (await h.app.tasks.create({ title: "I0" })).task.id;
			const i1 = (await h.app.tasks.create({ title: "I1" })).task.id;
			const x0 = (await h.app.tasks.create({ title: "X0", categoryId: x })).task.id;
			const x1 = (await h.app.tasks.create({ title: "X1", categoryId: x })).task.id;
			const y0 = (await h.app.tasks.create({ title: "Y0", categoryId: y })).task.id;
			// Equal keys across the lists: I0 = X0 = Y0 and I1 = X1. The column holds I0, X0 and Y0.
			expect(new Set([key(h, i0), key(h, x0), key(h, y0)]).size).toBe(1);
			expect(key(h, i1)).toBe(key(h, x1));
			const r = await h.app.tasks.place(y0, [y0, i0, x0]);
			expect(r.changed).toBe(true);
			expect(ascending([y0, i0, x0].map((id) => key(h, id)))).toBe(true);
			// The rebalanced keys stay below every task above the order, in every view.
			expect(key(h, x0) < key(h, i1)).toBe(true);
			expect(key(h, x0) < key(h, x1)).toBe(true);
			const inboxNew = (await h.app.tasks.create({ title: "I2" })).task.id;
			const xNew = (await h.app.tasks.create({ title: "X2", categoryId: x })).task.id;
			expect(key(h, inboxNew) > key(h, i1) && key(h, inboxNew) > key(h, i0)).toBe(true);
			// X0 is the last card of the column, so the new X task lands last in its list and in the column.
			expect(key(h, xNew) > key(h, x1) && key(h, xNew) > key(h, x0)).toBe(true);
			expect([y0, i0, x0].every((id) => key(h, xNew) > key(h, id))).toBe(true);
		});

		it("rebalances keys that are out of order, not just equal", async () => {
			const { h, ids } = await setup();
			const [a, b, c] = ids as [string, string, string];
			await setKeys(h, { [a]: "T", [b]: "M", [c]: "H" });
			const r = await h.app.tasks.place(a, [a, b, c]);
			expect(r.changed).toBe(true);
			expect(ascending([a, b, c].map((id) => key(h, id)))).toBe(true);
			expect(order(h)).toEqual(["T0", "T1", "T2"]);
		});

		it("does not move the rebalanced tasks relative to a task outside the order", async () => {
			const { h, ids } = await setup();
			const [a, b, c] = ids as [string, string, string];
			const below = (await h.app.tasks.create({ title: "Below" })).task.id;
			const above = (await h.app.tasks.create({ title: "Above" })).task.id;
			await setKeys(h, { [below]: "2", [a]: "M", [b]: "M", [c]: "M", [above]: "e" });
			await h.app.tasks.place(c, [c, a, b]);
			const keys = [below, c, a, b, above].map((id) => key(h, id));
			expect(ascending(keys)).toBe(true);
			expect(order(h)).toEqual(["Below", "T2", "T0", "T1", "Above"]);
		});

		it("undo restores every key", async () => {
			const { h, ids } = await setup();
			const [a, b, c] = ids as [string, string, string];
			await setKeys(h, { [a]: "M", [b]: "M", [c]: "M" });
			await h.app.tasks.place(c, [c, a, b]);
			await h.app.store.undo();
			expect([a, b, c].map((id) => key(h, id))).toEqual(["M", "M", "M"]);
		});

		it("a category move with a one-task order keeps the end-of-category key", async () => {
			const h = await appHarness();
			const x = (await h.app.categories.create("X")).id;
			const x0 = (await h.app.tasks.create({ title: "X0", categoryId: x })).task.id;
			const x1 = (await h.app.tasks.create({ title: "X1", categoryId: x })).task.id;
			const m = (await h.app.tasks.create({ title: "M" })).task.id;
			await h.app.tasks.place(m, [m], { categoryId: x });
			expect(key(h, m) > key(h, x1) && key(h, m) > key(h, x0)).toBe(true);
			const next = (await h.app.tasks.create({ title: "N", categoryId: x })).task.id;
			expect(key(h, next) > key(h, m)).toBe(true);
		});
	});
});
