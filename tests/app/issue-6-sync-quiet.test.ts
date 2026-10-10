import { describe, expect, it, vi } from "vitest";
import { syncLinkId } from "../../src/domain/types";
import { linkedList, syncHarness } from "./sync-harness";

// A sync that finds nothing to do writes nothing, not even the time of its pull. Otherwise two devices
// with sync on would wake each other forever: each write reaches the other device as a reload, which syncs and
// writes again. `lastPulledAt` advances whenever the links command writes anything else, and at least once an hour;
// the next pull always asks for completions since the stored `lastPulledAt` (less the overlap), so none is missed.

describe("a sync with nothing to do (issue #6)", () => {
	it("runs no command and leaves the file as it is", async () => {
		const s = await syncHarness();
		const { listId } = await linkedList(s);
		await s.h.app.tasks.create({ title: "Call the bank", categoryId: listId });
		await s.sync.sync();
		s.tick();
		await s.h.store.flush();
		const text = s.h.dbText();
		const labels: string[] = [];
		s.h.app.store.bus.on("changed", (e) => labels.push(e.label));
		const pulledAt = s.link("list", listId)!.lastPulledAt;
		const r = await s.sync.sync();
		await s.h.store.flush();
		expect(r.ok).toBe(true);
		expect(labels).toEqual([]);
		expect(s.h.dbText()).toBe(text);
		expect(s.link("list", listId)!.lastPulledAt).toBe(pulledAt);
	});

	it("still advances lastPulledAt with any other link write, and once it is an hour old", async () => {
		const s = await syncHarness();
		const { listId } = await linkedList(s);
		const first = s.link("list", listId)!.lastPulledAt!;
		await s.h.app.tasks.create({ title: "Call the bank", categoryId: listId });
		await s.sync.sync();
		const second = s.link("list", listId)!.lastPulledAt!;
		expect(second > first).toBe(true);
		s.tick(30 * 60_000);
		await s.sync.sync();
		expect(s.link("list", listId)!.lastPulledAt).toBe(second);
		s.tick(31 * 60_000);
		await s.sync.sync();
		expect(s.link("list", listId)!.lastPulledAt! > second).toBe(true);
	});

	it("asks for completions since the stored lastPulledAt, so a completion during quiet syncs is pulled", async () => {
		const s = await syncHarness();
		const { listId } = await linkedList(s);
		await s.h.app.tasks.create({ title: "Call the bank", categoryId: listId });
		await s.sync.sync();
		const stored = s.link("list", listId)!.lastPulledAt!;
		const spy = vi.spyOn(s.tt, "listCompleted");
		for (let i = 0; i < 3; i++) {
			s.tick(10 * 60_000);
			await s.sync.sync();
		}
		const from = Date.parse(stored) - 5 * 60_000;
		for (const [q] of spy.mock.calls) expect(Date.parse(q.startDate.replace("+0000", "Z"))).toBeLessThanOrEqual(from);
		s.tt.edit(s.ttIdOf("Call the bank"), { status: 2 });
		s.tick();
		await s.sync.sync();
		expect(s.task("Call the bank").status).toBe("completed");
		expect(s.link("task", s.task("Call the bank").id)).toBeDefined();
		expect(syncLinkId("list", listId)).toBe(`list:${listId}`);
	});
});
