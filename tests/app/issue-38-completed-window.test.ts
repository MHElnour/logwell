import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import { TickTickError } from "../../src/app/ports";
import { TICKTICK_COMPLETED_MAX, type TtTask } from "../../src/domain/ticktick/types";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";

// TickTick sync rule 23: completions since the last pull are read in one window; a window holding 200 or more is
// split in halves until each holds fewer, at most 32 splits per list. 200 or more at almost the same time, or more
// splits, stop the sync, writing nothing. TickTick answers at most 200 completed tasks per read (the fake cuts like it).

const SECOND = 1000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

interface List {
	name: string;
	listId: string;
	projectId: string;
	ttIds: string[];
}

/** Linked lists, each holding `n` open tasks imported from TickTick, synced. */
async function imported(...lists: [name: string, n: number][]): Promise<SyncHarness & { lists: List[] }> {
	const s = await syncHarness();
	const out: List[] = [];
	for (const [name, n] of lists) {
		const { listId, projectId } = await linkedList(s, name);
		const ttIds: string[] = [];
		for (let i = 0; i < n; i++) ttIds.push(s.tt.add(projectId, { title: `${name} bill ${i}` }).id);
		out.push({ name, listId, projectId, ttIds });
	}
	const r = await s.sync.sync();
	if (!r.ok) throw new Error(`import failed: ${r.error?.message}`);
	s.tick();
	return Object.assign(s, { lists: out });
}

/** Completes the tasks in TickTick evenly over `span` ms (each stamped at the fake's clock); 0 is one instant. */
function completeOver(s: SyncHarness, ttIds: string[], span: number): void {
	const step = span / ttIds.length;
	for (const id of ttIds) {
		s.tick(step);
		s.tt.edit(id, { status: 2 });
	}
}

/**
 * `gap` since the last sync, with the completions `span` long starting half a second after a whole second, a third of
 * the way into it. (Completions all inside two whole seconds cannot be split: the halves of a window share one.)
 */
function burstInGap(s: SyncHarness, ttIds: string[], span: number, gap: number): void {
	const before = Math.floor(gap / 3 / SECOND) * SECOND + SECOND / 2;
	s.tick(before);
	completeOver(s, ttIds, span);
	s.tick(gap - before - span);
}

function completedIn(s: SyncHarness, list: List): number {
	return list.ttIds.filter((_, i) => s.task(`${list.name} bill ${i}`).status === "completed").length;
}

function readsOf(s: SyncHarness, list: List, before: string[]): number {
	return s.tt.calls.slice(before.length).filter((c) => c === `listCompleted:${list.projectId}`).length;
}

/** The sync catches up: ok, every completion applied from the completed reads alone (no lookups, no prompts). */
async function expectCatchUp(s: SyncHarness & { lists: List[] }): Promise<number> {
	const pulledAt = s.lists.map((l) => s.link("list", l.listId)!.lastPulledAt!);
	const calls = [...s.tt.calls];
	const r = await s.sync.sync();
	expect(r.error).toBeNull();
	expect(r.needsConfirmation).toEqual([]);
	expect(s.tt.calls.slice(calls.length).filter((c) => c.startsWith("getTask"))).toEqual([]);
	s.lists.forEach((l, i) => {
		expect(completedIn(s, l)).toBe(l.ttIds.length);
		expect(s.link("list", l.listId)!.lastPulledAt! > pulledAt[i]!).toBe(true);
	});
	return s.lists.reduce((n, l) => n + readsOf(s, l, calls), 0);
}

/** The sync stops with too-many-completed, writing nothing. */
async function expectStop(s: SyncHarness & { lists: List[] }): Promise<{ message: string; reads: number }> {
	const state = s.h.app.store.state;
	const calls = [...s.tt.calls];
	const r = await s.sync.sync();
	expect(r.ok).toBe(false);
	expect(r.error).toMatchObject({ listId: s.lists[0]!.listId, kind: "too-many-completed" });
	expect(s.h.app.store.state).toBe(state);
	return { message: r.error?.message ?? "", reads: readsOf(s, s.lists[0]!, calls) };
}

describe("a completed-tasks window over TickTick's 200 (issue #38, TickTick sync rule 23)", () => {
	for (const order of ["newest", "oldest"] as const) {
		it(`splits the window and completes all 450 when a cut read keeps the ${order}`, async () => {
			const s = await imported(["Work", 450]);
			s.tt.completedOrder = order;
			completeOver(s, s.lists[0]!.ttIds, 2 * HOUR);
			s.tick();
			const reads = await expectCatchUp(s);
			expect(reads).toBeGreaterThan(1);
			expect(reads).toBeLessThanOrEqual(16);
		});
	}

	it("199 completions take one read; 200 are split", async () => {
		const one = await imported(["Work", TICKTICK_COMPLETED_MAX - 1]);
		completeOver(one, one.lists[0]!.ttIds, 2 * HOUR);
		one.tick();
		expect(await expectCatchUp(one)).toBe(1);
		const two = await imported(["Work", TICKTICK_COMPLETED_MAX]);
		completeOver(two, two.lists[0]!.ttIds, 2 * HOUR);
		two.tick();
		expect(await expectCatchUp(two)).toBe(3);
	});

	const bursts: [name: string, n: number, span: number, gap: number][] = [
		["250 within 10 s after 3 days", 250, 10 * SECOND, 3 * DAY],
		["250 within 60 s after 30 days", 250, 60 * SECOND, 30 * DAY],
		["200 over 2 s after 1 day", 200, 2 * SECOND, DAY],
		...[1, 7, 14, 30, 60].map((d): [string, number, number, number] => [`2000 over 12 h after ${d} days`, 2000, 12 * HOUR, d * DAY]),
	];
	for (const [name, n, span, gap] of bursts) {
		it(`catches up: ${name}`, async () => {
			const s = await imported(["Work", n]);
			burstInGap(s, s.lists[0]!.ttIds, span, gap);
			const reads = await expectCatchUp(s);
			expect(reads).toBeLessThanOrEqual(2 * 32 + 1);
		});
	}

	it("stops, writing nothing, when 200 or more were completed at the same instant (after more than a day)", async () => {
		const s = await imported(["Work", TICKTICK_COMPLETED_MAX + 20]);
		burstInGap(s, s.lists[0]!.ttIds, 0, DAY + HOUR);
		const pulledAt = s.link("list", s.lists[0]!.listId)!.lastPulledAt;
		const { message, reads } = await expectStop(s);
		expect(message).toBe(`TickTick: ${TICKTICK_COMPLETED_MAX} or more tasks in "Work" were completed at almost the same time.`);
		expect(reads).toBeLessThanOrEqual(2 * 32 + 1);
		expect(s.link("list", s.lists[0]!.listId)!.lastPulledAt).toBe(pulledAt);
		expect(completedIn(s, s.lists[0]!)).toBe(0);
	});

	it("stops after 32 splits, writing nothing, when the window cannot be narrowed within them", async () => {
		const s = await imported(["Work", 1]);
		// 8000 completions over a day need at least 40 windows of fewer than 200: more than 32 splits.
		const ids: string[] = [];
		for (let i = 0; i < 8000; i++) ids.push(s.tt.add(s.lists[0]!.projectId, { title: `Done ${i}` }).id);
		completeOver(s, ids, DAY);
		s.tick();
		const { message, reads } = await expectStop(s);
		expect(message).toBe(`TickTick: ${TICKTICK_COMPLETED_MAX} or more tasks were completed in "Work" since the last sync.`);
		expect(reads).toBeGreaterThan(32);
		expect(reads).toBeLessThanOrEqual(2 * 32 + 1);
	});

	it("reads both halves past the middle when TickTick's bounds are exclusive: the halves share a second", async () => {
		const s = await imported(["Work", 1000]);
		s.tt.completedBounds = { start: "exclusive", end: "exclusive" };
		// One completion on every whole second: each split point is the time of a completion.
		completeOver(s, s.lists[0]!.ttIds, 1000 * SECOND);
		s.tick();
		expect(await expectCatchUp(s)).toBeGreaterThan(3);
	});

	it("a completion exactly on the middle second is in both halves and applied once", async () => {
		const s = await imported(["Work", 300]);
		const list = s.lists[0]!;
		const pulledAt = Date.parse(s.link("list", list.listId)!.lastPulledAt!);
		completeOver(s, list.ttIds, 2 * HOUR);
		s.tick();
		const whole = (ms: number) => Math.floor(ms / SECOND) * SECOND;
		const from = whole(pulledAt - 5 * 60_000);
		const to = whole(s.h.clock.now().getTime() + 5 * 60_000);
		const mid = from + whole((to - from) / 2);
		const onMid = list.ttIds[0]!;
		s.tt.tasks.set(onMid, { ...s.tt.tasks.get(onMid)!, completedTime: DateTime.fromMillis(mid, { zone: "utc" }).toFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZZZ") });
		const spy = vi.spyOn(s.tt, "listCompleted");
		expect(await expectCatchUp(s)).toBe(3);
		const answers = (await Promise.all(spy.mock.results.map((r) => r.value as Promise<TtTask[]>))).slice(1);
		expect(answers.filter((a) => a.some((t) => t.id === onMid))).toHaveLength(2);
		expect(s.tasks("Work bill 0")).toHaveLength(1);
	});

	it("each list has its own budget: two lists that each need many splits both catch up", async () => {
		const s = await imported(["Work", 2000], ["Home", 2000]);
		s.tick(Math.floor((30 * DAY) / 3));
		completeOver(s, s.lists[0]!.ttIds, 12 * HOUR);
		completeOver(s, s.lists[1]!.ttIds, 12 * HOUR);
		s.tick(20 * DAY);
		// One shared budget could not make more than 2 × 32 + 1 reads in all.
		expect(await expectCatchUp(s)).toBeGreaterThan(2 * 32 + 1);
	});

	it("after a split pull, the next quiet sync reads the completed tasks once per list", async () => {
		const s = await imported(["Work", 250], ["Home", 3]);
		const list = s.lists[0]!;
		completeOver(s, list.ttIds, 2 * 60_000);
		completeOver(s, s.lists[1]!.ttIds, 3 * SECOND);
		s.tick();
		await expectCatchUp(s);
		// The completions are still inside the next pull's overlap: it splits again and finds nothing new.
		s.tick(5 * 60_000);
		const state = s.h.app.store.state;
		let calls = [...s.tt.calls];
		expect((await s.sync.sync()).ok).toBe(true);
		expect(readsOf(s, list, calls)).toBeGreaterThan(1);
		expect(s.h.app.store.state.tasks).toBe(state.tasks);
		// That pull moved the window past them: the next quiet sync reads once.
		s.tick();
		calls = [...s.tt.calls];
		expect((await s.sync.sync()).ok).toBe(true);
		expect(readsOf(s, list, calls)).toBe(1);
		expect(readsOf(s, s.lists[1]!, calls)).toBe(1);
	});

	it("a 429 on the third read stops with rate-limited, writing nothing", async () => {
		const s = await imported(["Work", 450]);
		completeOver(s, s.lists[0]!.ttIds, 2 * HOUR);
		s.tick();
		const state = s.h.app.store.state;
		const pulledAt = s.link("list", s.lists[0]!.listId)!.lastPulledAt;
		let reads = 0;
		s.tt.onCall = (m) => {
			if (m === "listCompleted" && ++reads === 3) {
				throw new TickTickError("rate-limited", "TickTick: too many requests (HTTP 429)", { status: 429, retryAfterSec: 30 });
			}
		};
		const r = await s.sync.sync();
		expect(r.ok).toBe(false);
		expect(r.error).toMatchObject({ listId: s.lists[0]!.listId, kind: "rate-limited", retryAfterSec: 30 });
		expect(reads).toBe(3);
		expect(s.h.app.store.state).toBe(state);
		expect(s.link("list", s.lists[0]!.listId)!.lastPulledAt).toBe(pulledAt);
		expect(completedIn(s, s.lists[0]!)).toBe(0);
	});
});
