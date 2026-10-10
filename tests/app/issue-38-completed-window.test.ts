import { describe, expect, it } from "vitest";
import { TickTickError } from "../../src/app/ports";
import { TICKTICK_COMPLETED_MAX } from "../../src/domain/ticktick/types";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";

// TickTick sync rule 23: completions since the last pull are read in one window; a window holding 200 or more is
// split in halves until each holds fewer, at most 32 reads per list. 200 or more within one second, or more reads,
// stop that list, writing nothing. TickTick answers at most 200 completed tasks per read (the fake cuts like it).

const TWO_HOURS = 2 * 60 * 60_000;

/** A linked list holding `n` open tasks imported from TickTick, synced. */
async function imported(n: number): Promise<SyncHarness & { listId: string; projectId: string; ttIds: string[] }> {
	const s = await syncHarness();
	const { listId, projectId } = await linkedList(s);
	const ttIds: string[] = [];
	for (let i = 0; i < n; i++) ttIds.push(s.tt.add(projectId, { title: `Pay bill ${i}` }).id);
	const r = await s.sync.sync();
	if (!r.ok) throw new Error(`import failed: ${r.error?.message}`);
	s.tick();
	return Object.assign(s, { listId, projectId, ttIds });
}

/** Completes every task in TickTick, evenly over `span` ms (each completion stamped at the fake's clock). */
function completeOver(s: SyncHarness, ttIds: string[], span: number): void {
	const step = Math.floor(span / ttIds.length);
	for (const id of ttIds) {
		s.tick(step);
		s.tt.edit(id, { status: 2 });
	}
	s.tick();
}

function completedInLogwell(s: SyncHarness, n: number): number {
	let done = 0;
	for (let i = 0; i < n; i++) if (s.task(`Pay bill ${i}`).status === "completed") done++;
	return done;
}

describe("a completed-tasks window over TickTick's 200 (issue #38, TickTick sync rule 23)", () => {
	for (const order of ["newest", "oldest"] as const) {
		it(`splits the window and completes all 450 when a cut read keeps the ${order}`, async () => {
			const s = await imported(450);
			s.tt.completedOrder = order;
			completeOver(s, s.ttIds, TWO_HOURS);
			const pulledAt = s.link("list", s.listId)!.lastPulledAt!;
			const before = s.tt.count("listCompleted");
			const r = await s.sync.sync();
			expect(r.error).toBeNull();
			expect(r.ok).toBe(true);
			expect(r.needsConfirmation).toEqual([]);
			expect(completedInLogwell(s, 450)).toBe(450);
			expect(s.link("list", s.listId)!.lastPulledAt! > pulledAt).toBe(true);
			const reads = s.tt.count("listCompleted") - before;
			expect(reads).toBeGreaterThan(1);
			expect(reads).toBeLessThanOrEqual(16);
		});
	}

	it("stops, writing nothing, when 200 or more were completed within one second", async () => {
		const s = await imported(TICKTICK_COMPLETED_MAX + 20);
		s.tick(30 * 60_000);
		// One bulk action: every completion carries the same instant.
		for (const id of s.ttIds) s.tt.edit(id, { status: 2 });
		s.tick(30 * 60_000);
		const state = s.h.app.store.state;
		const pulledAt = s.link("list", s.listId)!.lastPulledAt;
		const before = s.tt.count("listCompleted");
		const r = await s.sync.sync();
		expect(r.ok).toBe(false);
		expect(r.error).toMatchObject({ listId: s.listId, kind: "too-many-completed" });
		expect(r.error?.message).toContain("within one second");
		expect(s.h.app.store.state).toBe(state);
		expect(s.link("list", s.listId)!.lastPulledAt).toBe(pulledAt);
		expect(s.tt.count("listCompleted") - before).toBeLessThanOrEqual(32);
		expect(completedInLogwell(s, TICKTICK_COMPLETED_MAX + 20)).toBe(0);
	});

	it("stops after 32 reads, writing nothing, when the window cannot be narrowed within them", async () => {
		const s = await imported(TICKTICK_COMPLETED_MAX);
		s.tick(14 * 24 * 60 * 60_000);
		for (const id of s.ttIds) s.tt.edit(id, { status: 2 });
		s.tick();
		const state = s.h.app.store.state;
		const before = s.tt.count("listCompleted");
		const r = await s.sync.sync();
		expect(r.error).toMatchObject({ listId: s.listId, kind: "too-many-completed" });
		expect(r.error?.message).toContain("since the last sync");
		expect(s.tt.count("listCompleted") - before).toBe(32);
		expect(s.h.app.store.state).toBe(state);
	});

	it("a 429 on the third read stops with rate-limited, writing nothing", async () => {
		const s = await imported(450);
		completeOver(s, s.ttIds, TWO_HOURS);
		const state = s.h.app.store.state;
		const pulledAt = s.link("list", s.listId)!.lastPulledAt;
		let reads = 0;
		s.tt.onCall = (m) => {
			if (m === "listCompleted" && ++reads === 3) {
				throw new TickTickError("rate-limited", "TickTick: too many requests (HTTP 429)", { status: 429, retryAfterSec: 30 });
			}
		};
		const r = await s.sync.sync();
		expect(r.ok).toBe(false);
		expect(r.error).toMatchObject({ listId: s.listId, kind: "rate-limited", retryAfterSec: 30 });
		expect(reads).toBe(3);
		expect(s.h.app.store.state).toBe(state);
		expect(s.link("list", s.listId)!.lastPulledAt).toBe(pulledAt);
		expect(completedInLogwell(s, 450)).toBe(0);
	});
});
