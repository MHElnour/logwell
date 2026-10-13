import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import { TickTickError } from "../../src/app/ports";
import { LOOKUP_MAX, type SyncResult } from "../../src/app/syncModel";
import { TICKTICK_COMPLETED_MAX, type TtTask } from "../../src/domain/ticktick/types";
import { linkedList, type SyncHarness, syncHarness } from "./sync-harness";

// TickTick sync rule 23: completions since the last pull are read in one window; a window holding 200 or more is
// split in halves until each holds fewer, at most 32 splits per list. A window that cannot be narrowed (200 or more at
// almost the same time, or no splits left) is applied as read: the linked tasks it may have cut are looked up one by
// one, 50 a sync, and while any window is cut no task is offered or moved to Trash as missing. A task not found under
// its own project is looked up in the other linked ones (moved). TickTick sync rule 10: a task not looked up yet waits
// and is never offered for Trash. TickTick answers at most 200 completed tasks per read (the fake cuts like it).

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

/** The titles of the tasks in the Logwell Trash, sorted. */
function trashed(s: SyncHarness): string[] {
	return [...s.h.app.store.state.trash.values()].flatMap((e) => e.tasks.map((t) => t.title)).sort();
}

/**
 * `n` linked tasks completed in TickTick at one whole-second instant half an hour into an hour's gap; `extra` more
 * linked tasks and two that stay open (the list is never emptied).
 */
async function sameInstant(n: number, extra = 0): Promise<SyncHarness & { lists: List[] }> {
	const s = await imported(["Work", n + extra + 2]);
	s.tick(30 * 60_000);
	completeOver(s, s.lists[0]!.ttIds.slice(0, n), 0);
	s.tick(30 * 60_000);
	return s;
}

interface After {
	r: SyncResult;
	/** The list's `lastPulledAt` moved on. */
	advanced: boolean;
	trash: string[];
}

/**
 * The syncs after a burst at minute 0: at minutes 1, 4 and 8 the next pull's 5-minute overlap still covers it (the
 * window stays cut), at minute 15 it no longer does. `check` runs after each.
 */
async function syncsAfterBurst(s: SyncHarness & { lists: List[] }, check: (after: After, minute: number) => void): Promise<void> {
	let at = 0;
	for (const minute of [1, 4, 8, 15]) {
		s.tick((minute - at) * 60_000);
		at = minute;
		const before = s.link("list", s.lists[0]!.listId)!.lastPulledAt!;
		const r = await s.sync.sync();
		expect(r.error).toBeNull();
		check({ r, advanced: s.link("list", s.lists[0]!.listId)!.lastPulledAt! > before, trash: trashed(s) }, minute);
	}
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
		// A short gap and a long one: the gap only sets the window's length.
		...[1, 60].map((d): [string, number, number, number] => [`2000 over 12 h after ${d} days`, 2000, 12 * HOUR, d * DAY]),
	];
	for (const [name, n, span, gap] of bursts) {
		it(`catches up: ${name}`, async () => {
			const s = await imported(["Work", n]);
			burstInGap(s, s.lists[0]!.ttIds, span, gap);
			const reads = await expectCatchUp(s);
			expect(reads).toBeLessThanOrEqual(2 * 32 + 1);
		});
	}

	// Each cut order and each bound type once: the two settings are independent of each other.
	for (const [order, bounds] of [
		["newest", "inclusive"],
		["oldest", "exclusive"],
	] as const) {
		it(`230 completed at one instant: the cut read is applied and the rest looked up (${order}, ${bounds} bounds)`, async () => {
			const s = await sameInstant(230);
			s.tt.completedOrder = order;
			s.tt.completedBounds = { start: bounds, end: bounds };
			const pulledAt = s.link("list", s.lists[0]!.listId)!.lastPulledAt!;
			const getTask = s.tt.count("getTask");
			const r = await s.sync.sync();
			expect(r.error).toBeNull();
			expect(r.needsConfirmation).toEqual([]);
			expect(completedIn(s, s.lists[0]!)).toBe(230);
			expect(s.tt.count("getTask") - getTask).toBe(230 - TICKTICK_COMPLETED_MAX);
			expect(s.link("list", s.lists[0]!.listId)!.lastPulledAt! > pulledAt).toBe(true);
		});
	}

	it("Logwell completes 250 subtasks while 60 other tasks are deleted in TickTick: no Trash verdict until the window is whole", async () => {
		const s = await imported(["Work", 70]);
		const list = s.lists[0]!;
		const { task: parent } = await s.h.app.tasks.create({ title: "Move house", categoryId: list.listId });
		for (let i = 0; i < 250; i++) await s.h.app.tasks.create({ title: `Box ${i}`, categoryId: list.listId, parentId: parent.id });
		expect((await s.sync.sync()).ok).toBe(true);
		s.tick();
		// Minute 0: the bulk completion reaches TickTick in one instant; 60 other tasks go in TickTick.
		await s.h.app.tasks.complete(parent.id, { includeSubtasks: true });
		expect((await s.sync.sync()).ok).toBe(true);
		for (const id of list.ttIds.slice(0, 60)) s.tt.remove(id);
		let offered: SyncResult["needsConfirmation"] = [];
		await syncsAfterBurst(s, ({ r, advanced, trash }, minute) => {
			expect(trash).toEqual([]);
			if (minute < 15) expect(advanced).toBe(true);
			if (minute < 15) expect(r.needsConfirmation).toEqual([]);
			else offered = r.needsConfirmation;
		});
		expect(s.task("Box 0").status).toBe("completed");
		// The first whole window checks 50 (nothing found under a cut is kept); the dialog is closed, the next sync
		// checks the other 10.
		expect(offered).toHaveLength(1);
		expect(offered[0]).toMatchObject({ listId: list.listId, reason: "many" });
		expect(offered[0]!.tasks).toHaveLength(LOOKUP_MAX);
		s.tick(5 * 60_000);
		offered = (await s.sync.sync()).needsConfirmation;
		expect(offered[0]!.tasks).toHaveLength(60);
		await s.sync.trashMissing(list.listId, offered[0]!.tasks.map((t) => t.id));
		expect(trashed(s)).toHaveLength(60);
	});

	it.each([
		["260", "the rest at the next", 260, [250, 260, 260, 260]],
		["400", "50 more each sync", 400, [250, 300, 350, 400]],
	])("%s completed in TickTick at one instant: 250 at the first sync, %s, never a confirmation; the rest of the pull applies", async (_, _rest, n, want) => {
		const s = await imported(["Work", n + 2]);
		const list = s.lists[0]!;
		completeOver(s, list.ttIds.slice(0, n), 0);
		// An edit of a task that stays open: a cut window never stops the rest of the pull.
		s.tt.edit(list.ttIds[n]!, { priority: 5 });
		const done: number[] = [];
		await syncsAfterBurst(s, ({ r, trash }) => {
			expect(r.needsConfirmation).toEqual([]);
			expect(trash).toEqual([]);
			expect(s.task(`Work bill ${n}`).priority).toBe(1);
			done.push(completedIn(s, list));
		});
		expect(done).toEqual(want);
	});

	it("a cut in one list holds the Trash verdicts of every list until the window is whole", async () => {
		const s = await imported(["Work", 232], ["Home", 5]);
		const [work, home] = s.lists as [List, List];
		completeOver(s, work.ttIds.slice(0, 230), 0);
		for (const id of home.ttIds.slice(0, 3)) s.tt.remove(id);
		await syncsAfterBurst(s, ({ r, trash }, minute) => {
			expect(r.needsConfirmation).toEqual([]);
			expect(trash).toEqual(minute < 15 ? [] : ["Home bill 0", "Home bill 1", "Home bill 2"]);
		});
		expect(completedIn(s, work)).toBe(230);
	});

	it("a task moved to a cut list and completed in its burst is completed there, at the first sync", async () => {
		const s = await imported(["Home", 3], ["Work", 230]);
		const [home, work] = s.lists as [List, List];
		s.tt.completedOrder = "oldest";
		s.tt.edit(home.ttIds[0]!, { projectId: work.projectId });
		completeOver(s, work.ttIds, 0);
		s.tick(1);
		s.tt.edit(home.ttIds[0]!, { status: 2 });
		s.tick(60_000);
		const r = await s.sync.sync();
		expect(r.error).toBeNull();
		expect(r.needsConfirmation).toEqual([]);
		expect(trashed(s)).toEqual([]);
		expect(s.task("Home bill 0")).toMatchObject({ status: "completed", categoryId: work.listId });
		expect(completedIn(s, work)).toBe(230);
	});

	it("a task moved to a list that is not linked is not found in any: the usual Trash flow", async () => {
		const s = await imported(["Home", 3], ["Work", 3]);
		const other = s.tt.addProject("Other");
		s.tt.edit(s.lists[0]!.ttIds[0]!, { projectId: other.id });
		s.tick();
		const getTask = s.tt.count("getTask");
		const r = await s.sync.sync();
		expect(r.error).toBeNull();
		expect(r.needsConfirmation).toEqual([]);
		expect(trashed(s)).toEqual(["Home bill 0"]);
		// Its own list, then each other linked list.
		expect(s.tt.count("getTask") - getTask).toBe(2);
	});

	it("no splits left with linked completions it cut: nothing offered or trashed, the rest looked up 50 a sync", async () => {
		const s = await imported(["Work", 1002]);
		const list = s.lists[0]!;
		// Linked and unlinked completions interleaved over a day: one linked in every eight. Two stay open.
		const ids: string[] = [];
		for (const linked of list.ttIds.slice(0, 1000)) {
			ids.push(linked);
			for (let i = 0; i < 7; i++) ids.push(s.tt.add(list.projectId, { title: `Done ${ids.length}` }).id);
		}
		completeOver(s, ids, DAY);
		s.tick();
		const pulledAt = s.link("list", list.listId)!.lastPulledAt!;
		let r = await s.sync.sync();
		expect(r.error).toBeNull();
		expect(r.needsConfirmation).toEqual([]);
		expect(trashed(s)).toEqual([]);
		expect(s.link("list", list.listId)!.lastPulledAt! > pulledAt).toBe(true);
		let done = completedIn(s, list);
		expect(done).toBeLessThan(1000);
		const hidden = 1000 - done;
		for (let sync = 0; sync < Math.ceil(hidden / LOOKUP_MAX); sync++) {
			s.tick(5 * 60_000);
			r = await s.sync.sync();
			expect(r.error).toBeNull();
			expect(r.needsConfirmation).toEqual([]);
			expect(trashed(s)).toEqual([]);
			const now = completedIn(s, list);
			expect(now - done).toBe(Math.min(LOOKUP_MAX, 1000 - done));
			done = now;
		}
		expect(done).toBe(1000);
	});

	it("120 completions hidden from every read (won't do), no cut: no dialog, all completed after 3 syncs", async () => {
		const s = await imported(["Work", 122]);
		const list = s.lists[0]!;
		for (const id of list.ttIds.slice(0, 120)) s.tt.edit(id, { status: -1 });
		const done: number[] = [];
		for (let sync = 0; sync < 3; sync++) {
			s.tick(5 * 60_000);
			const r = await s.sync.sync();
			expect(r.error).toBeNull();
			expect(r.needsConfirmation).toEqual([]);
			expect(trashed(s)).toEqual([]);
			done.push(completedIn(s, list));
		}
		expect(done).toEqual([50, 100, 120]);
	});

	it("80 deleted in TickTick: the dialog lists only the tasks TickTick confirmed gone, all 80 by the second sync", async () => {
		const s = await imported(["Work", 82]);
		const list = s.lists[0]!;
		for (const id of list.ttIds.slice(0, 80)) s.tt.remove(id);
		s.tick();
		const lookups = s.tt.count("getTask");
		const first = await s.sync.sync();
		expect(s.tt.count("getTask") - lookups).toBe(LOOKUP_MAX);
		expect(trashed(s)).toEqual([]);
		expect(first.needsConfirmation).toHaveLength(1);
		expect(first.needsConfirmation[0]).toMatchObject({ listId: list.listId, reason: "many" });
		expect(first.needsConfirmation[0]!.tasks).toHaveLength(LOOKUP_MAX);
		// The dialog is closed: nothing decided. The next sync looks up the other 30.
		s.tick(5 * 60_000);
		const getTask = s.tt.count("getTask");
		const second = await s.sync.sync();
		expect(s.tt.count("getTask") - getTask).toBe(30);
		expect(second.needsConfirmation).toHaveLength(1);
		expect(second.needsConfirmation[0]!.tasks.map((t) => t.title).sort()).toEqual(list.ttIds.slice(0, 80).map((_, i) => `Work bill ${i}`).sort());
		expect(trashed(s)).toEqual([]);
	});

	it("a list emptied in TickTick asks only once every task is looked up (Keep would unlink it)", async () => {
		const s = await imported(["Work", 80]);
		const list = s.lists[0]!;
		for (const id of list.ttIds) s.tt.remove(id);
		s.tick();
		expect((await s.sync.sync()).needsConfirmation).toEqual([]);
		s.tick(5 * 60_000);
		const r = await s.sync.sync();
		expect(r.needsConfirmation).toHaveLength(1);
		expect(r.needsConfirmation[0]).toMatchObject({ listId: list.listId, reason: "emptied" });
		expect(r.needsConfirmation[0]!.tasks).toHaveLength(80);
		expect(trashed(s)).toEqual([]);
	});

	it("60 deleted and 200 hidden completions, the dialog closed every time: all resolved within ceil(260 / 50) syncs", async () => {
		const s = await imported(["Work", 262]);
		const list = s.lists[0]!;
		// Interleaved, so neither kind is looked up first.
		const deleted = list.ttIds.slice(0, 260).filter((_, i) => i % 13 < 3);
		const hidden = list.ttIds.slice(0, 260).filter((_, i) => i % 13 >= 3);
		expect([deleted.length, hidden.length]).toEqual([60, 200]);
		for (const id of deleted) s.tt.remove(id);
		for (const id of hidden) s.tt.edit(id, { status: -1 });
		const deletedTitles = new Set(deleted.map((id) => `Work bill ${list.ttIds.indexOf(id)}`));
		let offered: string[] = [];
		for (let sync = 0; sync < Math.ceil(260 / LOOKUP_MAX); sync++) {
			s.tick(5 * 60_000);
			const r = await s.sync.sync();
			expect(r.error).toBeNull();
			for (const p of r.needsConfirmation) for (const t of p.tasks) expect(deletedTitles.has(t.title)).toBe(true);
			offered = r.needsConfirmation.flatMap((p) => p.tasks.map((t) => t.title));
		}
		expect(hidden.filter((id) => s.task(`Work bill ${list.ttIds.indexOf(id)}`).status !== "completed")).toEqual([]);
		expect(offered.sort()).toEqual([...deletedTitles].sort());
		expect(trashed(s)).toEqual([]);
	});

	it("the 50 lookups of a sync are shared by all lists", async () => {
		const s = await imported(["Work", 42], ["Home", 42]);
		for (const l of s.lists) for (const id of l.ttIds.slice(0, 40)) s.tt.edit(id, { status: -1 });
		const done: number[] = [];
		for (let sync = 0; sync < 2; sync++) {
			s.tick();
			const before = s.tt.count("getTask");
			const r = await s.sync.sync();
			expect(r.error).toBeNull();
			expect(r.needsConfirmation).toEqual([]);
			expect(s.tt.count("getTask") - before).toBe(sync === 0 ? LOOKUP_MAX : 80 - LOOKUP_MAX);
			done.push(s.lists.reduce((n, l) => n + completedIn(s, l), 0));
		}
		expect(done).toEqual([LOOKUP_MAX, 80]);
	});

	it("lookups in the other linked lists count against the sync's 50", async () => {
		const s = await imported(["Home", 20], ["Work", 2], ["Errands", 2]);
		const [home, , errands] = s.lists as [List, List, List];
		// Moved to the last list and set to won't do there: in no project data and no completed answer.
		for (const id of home.ttIds.slice(0, 17)) s.tt.edit(id, { projectId: errands.projectId, status: -1 });
		s.tick();
		const getTask = s.tt.count("getTask");
		const r = await s.sync.sync();
		expect(r.error).toBeNull();
		// Home, Work, Errands: three calls a task. 16 take 48; the 17th reaches 50 before Errands is asked.
		expect(s.tt.count("getTask") - getTask).toBe(LOOKUP_MAX);
		const moved = () => home.ttIds.slice(0, 17).map((_, i) => s.task(`Home bill ${i}`)).filter((t) => t.status === "completed" && t.categoryId === errands.listId);
		expect(moved()).toHaveLength(16);
		// The 17th waits for the next sync; it is never offered for Trash.
		expect(r.needsConfirmation).toEqual([]);
		s.tick();
		expect((await s.sync.sync()).needsConfirmation).toEqual([]);
		expect(moved()).toHaveLength(17);
	});

	it("tasks offered as gone, then restored and completed in TickTick inside a cut burst, end completed", async () => {
		const s = await imported(["Work", 8]);
		const list = s.lists[0]!;
		const gone = list.ttIds.slice(0, 6);
		for (const id of gone) s.tt.remove(id);
		s.tick();
		expect((await s.sync.sync()).needsConfirmation[0]?.tasks).toHaveLength(6);
		// The dialog is closed. The six come back in TickTick and are completed a millisecond before 250 others, inside one
		// second: a cut answer keeps the newest.
		s.tick(30 * 60_000 + 500);
		for (const id of gone) s.tt.tasks.set(id, { ...s.tt.tasks.get(id)!, deleted: false });
		completeOver(s, gone, 0);
		s.tick(1);
		const others: string[] = [];
		for (let i = 0; i < 250; i++) others.push(s.tt.add(list.projectId, { title: `Done ${i}` }).id);
		completeOver(s, others, 0);
		await syncsAfterBurst(s, ({ r, trash }) => {
			expect(r.needsConfirmation).toEqual([]);
			expect(trash).toEqual([]);
		});
		for (let i = 0; i < 6; i++) expect(s.task(`Work bill ${i}`).status).toBe("completed");
	});

	it("a task offered as gone and then restored open in TickTick is never offered again", async () => {
		const s = await imported(["Work", 8]);
		const list = s.lists[0]!;
		const gone = list.ttIds.slice(0, 6);
		for (const id of gone) s.tt.remove(id);
		s.tick();
		expect((await s.sync.sync()).needsConfirmation[0]?.tasks).toHaveLength(6);
		for (const id of gone) s.tt.tasks.set(id, { ...s.tt.tasks.get(id)!, deleted: false });
		for (let sync = 0; sync < 3; sync++) {
			s.tick(5 * 60_000);
			const r = await s.sync.sync();
			expect(r.needsConfirmation).toEqual([]);
		}
		expect(trashed(s)).toEqual([]);
		for (let i = 0; i < 6; i++) expect(s.task(`Work bill ${i}`).status).toBe("open");
	});

	it("8 deletions among 100 hidden completions are offered together once, never trashed a few at a time", async () => {
		const s = await imported(["Work", 110]);
		const list = s.lists[0]!;
		// Every 13th task is deleted, the others are won't do: hidden from every read.
		const deleted = list.ttIds.slice(0, 108).filter((_, i) => i % 13 === 0).slice(0, 8);
		for (const id of list.ttIds.slice(0, 108)) {
			if (deleted.includes(id)) s.tt.remove(id);
			else s.tt.edit(id, { status: -1 });
		}
		const titles = deleted.map((id) => `Work bill ${list.ttIds.indexOf(id)}`).sort();
		const offers: string[][] = [];
		for (let sync = 0; sync < 3; sync++) {
			s.tick(5 * 60_000);
			const r = await s.sync.sync();
			expect(r.error).toBeNull();
			expect(trashed(s)).toEqual([]);
			offers.push(...r.needsConfirmation.map((p) => p.tasks.map((t) => t.title).sort()));
		}
		expect(offers[0]).toEqual(titles);
		for (const offer of offers) expect(offer).toEqual(titles);
	});

	it("a sync makes at most 90 requests before its push, however much is left to look up", async () => {
		const s = await imported(["Work", 302], ["Home", 32]);
		const [work, home] = s.lists as [List, List];
		s.tick(30 * 60_000);
		// One bulk completion of 250, 50 more hidden from every read, 30 deleted in another list.
		completeOver(s, work.ttIds.slice(0, 250), 0);
		for (const id of work.ttIds.slice(250, 300)) s.tt.edit(id, { status: -1 });
		for (const id of home.ttIds.slice(0, 30)) s.tt.remove(id);
		s.tick(30 * 60_000);
		const calls = [...s.tt.calls];
		const r = await s.sync.sync();
		expect(r.error).toBeNull();
		const pull = s.tt.calls.slice(calls.length).filter((c) => /^(getProjectData|listCompleted|getTask)\b/.test(c));
		expect(pull.length).toBeLessThanOrEqual(90);
		expect(pull.filter((c) => c.startsWith("getTask")).length).toBeGreaterThan(0);
	});

	/** Two lists, each with 250 completed in one second and 600 over 12 hours, a month after the last sync. */
	async function twoBusyLists(): Promise<SyncHarness & { lists: List[] }> {
		const s = await imported(["Work", 852], ["Home", 852]);
		s.tick(10 * DAY);
		for (const l of s.lists) completeOver(s, l.ttIds.slice(0, 250), 0);
		s.tick(HOUR);
		for (const l of s.lists) completeOver(s, l.ttIds.slice(250, 850), 12 * HOUR);
		s.tick(20 * DAY);
		return s;
	}

	const pullCalls = (s: SyncHarness, before: number) => s.tt.calls.slice(before).filter((c) => /^(getProjectData|listCompleted|getTask)\b/.test(c));

	it("the completed reads share the pull's 90 requests: a window past them counts as cut, and later syncs find the rest", async () => {
		const s = await twoBusyLists();
		const pulledAt = s.lists.map((l) => s.link("list", l.listId)!.lastPulledAt!);
		const before = s.tt.calls.length;
		const r = await s.sync.sync();
		expect(r.error).toBeNull();
		expect(r.needsConfirmation).toEqual([]);
		expect(trashed(s)).toEqual([]);
		// Every list gets its project and a first completed read even past the 90: 2 requests a list at most beyond.
		expect(pullCalls(s, before).length).toBeLessThanOrEqual(90 + 2 * 2);
		s.lists.forEach((l, i) => expect(s.link("list", l.listId)!.lastPulledAt! > pulledAt[i]!).toBe(true));
		const done = () => s.lists.reduce((n, l) => n + completedIn(s, l), 0);
		const hidden = 2 * 850 - done();
		expect(hidden).toBeGreaterThan(0);
		// The window has moved past them: each later sync looks up 50.
		for (let sync = 0; sync < Math.ceil(hidden / LOOKUP_MAX); sync++) {
			s.tick(5 * 60_000);
			const later = s.tt.calls.length;
			const next = await s.sync.sync();
			expect(next.error).toBeNull();
			expect(next.needsConfirmation).toEqual([]);
			expect(pullCalls(s, later).length).toBeLessThanOrEqual(90);
		}
		expect(done()).toBe(2 * 850);
		expect(trashed(s)).toEqual([]);
	});

	it("a 429 on a completed read stops the sync with rate-limited, writing nothing; the next sync catches up", async () => {
		const s = await imported(["Work", 450]);
		completeOver(s, s.lists[0]!.ttIds, 2 * HOUR);
		s.tick();
		const state = s.h.app.store.state;
		const pulledAt = s.link("list", s.lists[0]!.listId)!.lastPulledAt;
		let reads = 0;
		// The third read is a split's: the window was already being narrowed.
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
		s.tt.onCall = null;
		s.tick();
		await expectCatchUp(s);
	});

	it("a 429 during the lookups keeps the tasks found gone: the next sync looks up only the rest", async () => {
		const s = await imported(["Work", 42]);
		const list = s.lists[0]!;
		for (const id of list.ttIds.slice(0, 40)) s.tt.remove(id);
		s.tick();
		let lookups = 0;
		s.tt.onCall = (m) => {
			if (m === "getTask" && ++lookups === 30) throw new TickTickError("rate-limited", "TickTick: too many requests (HTTP 429)", { status: 429, retryAfterSec: 30 });
		};
		expect((await s.sync.sync()).error).toMatchObject({ kind: "rate-limited" });
		s.tt.onCall = null;
		s.tick();
		const before = s.tt.count("getTask");
		const r = await s.sync.sync();
		expect(r.error).toBeNull();
		expect(s.tt.count("getTask") - before).toBe(40 - 29);
		expect(r.needsConfirmation[0]?.tasks).toHaveLength(40);
		expect(trashed(s)).toEqual([]);
	});

	it("a task moved between the pulls of two linked lists is moved, not offered as gone", async () => {
		const s = await imported(["Work", 3], ["Home", 3]);
		const [work, home] = s.lists as [List, List];
		s.tick();
		let pulls = 0;
		// Work is pulled first; the task moves from Home to Work before Home is pulled.
		s.tt.onCall = (m) => {
			if (m === "getProjectData" && ++pulls === 2) s.tt.edit(home.ttIds[0]!, { projectId: work.projectId });
		};
		const r = await s.sync.sync();
		s.tt.onCall = null;
		expect(r.error).toBeNull();
		expect(r.needsConfirmation).toEqual([]);
		expect(trashed(s)).toEqual([]);
		expect(s.task("Home bill 0")).toMatchObject({ status: "open", categoryId: work.listId });
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

	it("each list has its own splits within the pull's requests: two lists that need many both catch up in one sync", async () => {
		const s = await imported(["Work", 2000], ["Home", 450]);
		s.tick(Math.floor((30 * DAY) / 3));
		completeOver(s, s.lists[0]!.ttIds, 12 * HOUR);
		completeOver(s, s.lists[1]!.ttIds, 2 * HOUR);
		s.tick(20 * DAY);
		const reads = await expectCatchUp(s);
		expect(reads).toBeGreaterThan(32);
		expect(reads + 2).toBeLessThanOrEqual(90);
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
});
