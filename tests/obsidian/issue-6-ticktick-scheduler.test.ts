import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryTickTickDevice, MemoryTickTickSecret, TickTickError } from "../../src/app/ports";
import { type PendingTrash, type SyncFailure, type SyncResult, TICKTICK_LINKS_LABEL, TICKTICK_SYNC_LABEL } from "../../src/app/SyncService";
import type { Category, SyncLink } from "../../src/domain/types";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { PUSH_DELAY_MS, RATE_LIMITED_TEXT, TickTickScheduler } from "../../src/obsidian/tickTickScheduler";
import { type AppHarness, appHarness, makeReadOnly } from "../app/harness";
import { linkedList, syncHarness } from "../app/sync-harness";

// When the sync runs. Fake timers; the sync engine is a stub that counts its runs.

const NOW = "2026-10-01T09:59:00.000Z";
const WORK = "00000000-0000-4000-8000-00000000000a";
const HOME = "00000000-0000-4000-8000-00000000000b";
const MIN = 60_000;

const list = (id: string, name: string, sortKey: string): Category => ({ id, name, icon: null, color: null, nameKey: name.toLowerCase(), isInbox: false, sortKey, createdAt: NOW, modifiedAt: NOW });

function db(linked: boolean): string {
	const d = createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-other", now: NOW });
	const categories = new Map(d.categories);
	categories.set(WORK, list(WORK, "Work", "V1"));
	categories.set(HOME, list(HOME, "Home", "V2"));
	const link: SyncLink = { kind: "list", logwellId: WORK, ttId: "p-work", ttProjectId: null, etag: null, base: {}, noteBySync: false, lastPulledAt: NOW, modifiedAt: NOW };
	return serializeDb({ ...d, categories, syncLinks: linked ? new Map([[`list:${WORK}`, link]]) : new Map() });
}

function ok(needsConfirmation: PendingTrash[] = []): SyncResult {
	return { ok: true, error: null, failures: [], content: { wrote: false, label: TICKTICK_SYNC_LABEL }, pulled: 0, pushed: 0, needsConfirmation, warnings: [] };
}

function failed(f: Partial<SyncFailure>): SyncResult {
	const failure: SyncFailure = { listId: WORK, listName: "Work", kind: "network", message: "TickTick: no answer (network error).", retryAfterSec: null, ...f };
	return { ...ok(), ok: false, error: failure, failures: [failure] };
}

class StubSync {
	calls = 0;
	readonly results: (SyncResult | Error)[] = [];
	/** While set, a sync waits for it. */
	hold: Promise<void> | null = null;
	async sync(): Promise<SyncResult> {
		this.calls++;
		if (this.hold !== null) await this.hold;
		const r = this.results.shift() ?? ok();
		if (r instanceof Error) throw r;
		return r;
	}
}

interface Setup {
	h: AppHarness;
	stub: StubSync;
	device: MemoryTickTickDevice;
	secret: MemoryTickTickSecret;
	settings: { minutes: number };
	notices: string[];
	errors: unknown[];
	scheduler: TickTickScheduler;
}

async function setup(options: { linked?: boolean; minutes?: number; device?: boolean; token?: boolean; start?: boolean } = {}): Promise<Setup> {
	const h = await appHarness({ initial: db(options.linked ?? true) });
	vi.useFakeTimers({ now: Date.parse(NOW), toFake: ["setTimeout", "clearTimeout", "Date"] });
	const stub = new StubSync();
	const device = new MemoryTickTickDevice();
	device.setEnabled(options.device ?? true);
	const secret = new MemoryTickTickSecret();
	if (options.token ?? true) secret.set("token");
	const settings = { minutes: options.minutes ?? 5 };
	const notices: string[] = [];
	const errors: unknown[] = [];
	const scheduler = new TickTickScheduler({
		store: h.app.store,
		sync: stub,
		device,
		secret,
		pullMinutes: () => settings.minutes,
		timers: { set: (fn, ms) => setTimeout(fn, ms) as unknown as number, clear: (t) => clearTimeout(t) },
		now: () => Date.now(),
		notify: (m) => notices.push(m),
		error: (e) => errors.push(e),
	});
	if (options.start ?? true) scheduler.start();
	await flush();
	return { h, stub, device, secret, settings, notices, errors, scheduler };
}

/** Lets pending promise callbacks run without moving the clock. */
async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.useRealTimers());

describe("TickTick sync scheduler: pulls (SYNC-10, D28)", () => {
	it("pulls once when the database opens, then every tickTickPullMinutes", async () => {
		const s = await setup({ minutes: 5 });
		expect(s.stub.calls).toBe(1);
		await advance(5 * MIN - 1);
		expect(s.stub.calls).toBe(1);
		await advance(1);
		expect(s.stub.calls).toBe(2);
		await advance(5 * MIN);
		expect(s.stub.calls).toBe(3);
	});

	it("never pulls less often than every 60 minutes nor more often than every 5 (D28: there is no 0)", async () => {
		const s = await setup({ minutes: 0 });
		expect(s.stub.calls).toBe(1);
		await advance(5 * MIN);
		expect(s.stub.calls).toBe(2);
		s.settings.minutes = 1000;
		s.scheduler.refresh();
		await advance(60 * MIN);
		expect(s.stub.calls).toBe(3);
	});

	it("follows a changed interval at once", async () => {
		const s = await setup({ minutes: 30 });
		s.settings.minutes = 5;
		s.scheduler.refresh();
		await advance(5 * MIN);
		expect(s.stub.calls).toBe(2);
		s.settings.minutes = 60;
		s.scheduler.refresh();
		await advance(59 * MIN);
		expect(s.stub.calls).toBe(2);
		await advance(MIN);
		expect(s.stub.calls).toBe(3);
	});
});

describe("TickTick sync scheduler: pushes (SYNC-10)", () => {
	it("pushes 5 s after the last edit of a linked list, whatever the interval", async () => {
		const s = await setup({ minutes: 60 });
		expect(s.stub.calls).toBe(1);
		await s.h.app.tasks.create({ title: "One", categoryId: WORK });
		await advance(3000);
		await s.h.app.tasks.create({ title: "Two", categoryId: WORK });
		await advance(PUSH_DELAY_MS - 1);
		expect(s.stub.calls).toBe(1);
		await advance(1);
		expect(s.stub.calls).toBe(2);
		await advance(30 * MIN);
		expect(s.stub.calls).toBe(2);
	});

	it("an edit of a description note the sync created pushes 5 s after the last one (SYNC-09); not while inactive", async () => {
		const s = await setup({ minutes: 60 });
		s.scheduler.noteEdited();
		await advance(3000);
		s.scheduler.noteEdited();
		await advance(PUSH_DELAY_MS - 1);
		expect(s.stub.calls).toBe(1);
		await advance(1);
		expect(s.stub.calls).toBe(2);
		s.device.setEnabled(false);
		s.scheduler.refresh();
		s.scheduler.noteEdited();
		await advance(PUSH_DELAY_MS);
		expect(s.stub.calls).toBe(2);
	});

	it("an edit moving a task out of a linked list pushes; edits elsewhere do not", async () => {
		const s = await setup({ minutes: 60 });
		const home = await s.h.app.tasks.create({ title: "At home", categoryId: HOME });
		await advance(PUSH_DELAY_MS);
		expect(s.stub.calls).toBe(1);
		const work = await s.h.app.tasks.create({ title: "At work", categoryId: WORK });
		await advance(PUSH_DELAY_MS);
		expect(s.stub.calls).toBe(2);
		await s.h.app.tasks.update(work.task.id, { categoryId: HOME });
		await advance(PUSH_DELAY_MS);
		expect(s.stub.calls).toBe(3);
		await s.h.app.tasks.update(home.task.id, { title: "Still at home" });
		await advance(PUSH_DELAY_MS);
		expect(s.stub.calls).toBe(3);
	});

	it("a change event without changes (a reload) re-checks: it pushes", async () => {
		const s = await setup({ minutes: 60 });
		s.h.app.store.notifyReloaded();
		await advance(PUSH_DELAY_MS);
		expect(s.stub.calls).toBe(2);
	});

	it("the sync's own writes never trigger a push", async () => {
		const s = await setup({ minutes: 60 });
		await s.h.app.store.run(TICKTICK_SYNC_LABEL, (tx) => s.h.app.tasks.createIn(tx, { title: "Pulled", categoryId: WORK }), { undoable: false });
		await s.h.app.store.run(TICKTICK_LINKS_LABEL, (tx) => {
			const l = tx.get("syncLinks", `list:${WORK}`)!;
			tx.put("syncLinks", { ...l, lastPulledAt: "2026-10-01T10:00:00.000Z" });
		}, { undoable: false });
		await advance(59 * MIN);
		expect(s.stub.calls).toBe(1);
	});
});

describe("TickTick sync scheduler: when nothing may run (SYNC-01)", () => {
	for (const [name, options] of [
		["the device switch is off", { device: false }],
		["no token is set", { token: false }],
		["no list is linked", { linked: false }],
	] as const) {
		it(`makes no sync at all when ${name}`, async () => {
			const s = await setup({ minutes: 5, ...options });
			await s.h.app.tasks.create({ title: "One", categoryId: WORK });
			await advance(60 * MIN);
			expect(s.stub.calls).toBe(0);
			expect(s.scheduler.isActive()).toBe(false);
			await expect(s.scheduler.syncNow()).resolves.toBeNull();
			expect(s.stub.calls).toBe(0);
		});
	}

	it("makes no sync while the database is read-only", async () => {
		const s = await setup({ minutes: 5, start: false });
		await makeReadOnly(s.h);
		s.scheduler.start();
		await advance(30 * MIN);
		expect(s.stub.calls).toBe(0);
	});

	it("stops when the device switch is turned off, and resumes at the next interval when it is on again", async () => {
		const s = await setup({ minutes: 5 });
		expect(s.stub.calls).toBe(1);
		await s.h.app.tasks.create({ title: "One", categoryId: WORK });
		s.device.setEnabled(false);
		s.scheduler.refresh();
		await advance(30 * MIN);
		expect(s.stub.calls).toBe(1);
		s.device.setEnabled(true);
		s.scheduler.refresh();
		await advance(5 * MIN);
		expect(s.stub.calls).toBe(2);
	});

	it("a token cleared meanwhile: the timer fires but makes no sync", async () => {
		const s = await setup({ minutes: 5 });
		s.secret.clear();
		await advance(20 * MIN);
		expect(s.stub.calls).toBe(1);
		s.secret.set("token");
		await advance(5 * MIN);
		expect(s.stub.calls).toBe(2);
	});

	it("dispose stops every timer and listener", async () => {
		const s = await setup({ minutes: 5 });
		await s.h.app.tasks.create({ title: "One", categoryId: WORK });
		s.scheduler.dispose();
		await advance(60 * MIN);
		expect(s.stub.calls).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("no sync starts once disposed, even one queued during a running sync", async () => {
		const s = await setup({ minutes: 5, start: false });
		let release!: () => void;
		s.stub.hold = new Promise<void>((r) => (release = r));
		s.scheduler.start();
		await flush();
		void s.scheduler.syncNow();
		await s.h.app.tasks.create({ title: "One", categoryId: WORK });
		s.scheduler.dispose();
		s.stub.hold = null;
		release();
		await advance(60 * MIN);
		expect(s.stub.calls).toBe(1);
	});
});

describe("TickTick sync scheduler: one at a time, failures (SYNC-10, SYNC-12)", () => {
	it("a trigger during a sync runs once after it", async () => {
		const s = await setup({ minutes: 60, start: false });
		let release!: () => void;
		s.stub.hold = new Promise<void>((r) => (release = r));
		const first = s.scheduler.syncNow();
		const second = s.scheduler.syncNow();
		const third = s.scheduler.syncNow();
		await flush();
		expect(s.stub.calls).toBe(1);
		s.stub.hold = null;
		release();
		await Promise.all([first, second, third]);
		await flush();
		expect(s.stub.calls).toBe(2);
		await advance(59 * MIN);
		expect(s.stub.calls).toBe(2);
	});

	it("Sync now during a background sync gets the result of a run that starts after it, and shows its notice", async () => {
		const s = await setup({ minutes: 60, start: false });
		let release!: () => void;
		s.stub.hold = new Promise<void>((r) => (release = r));
		s.stub.results.push(failed({}), failed({}), failed({ kind: "server", message: "TickTick: server error (HTTP 500)" }));
		s.scheduler.start();
		await flush();
		expect(s.notices).toHaveLength(0);
		// The background run's failure is shown once; a background repeat of it is not.
		s.stub.hold = null;
		release();
		await flush();
		expect(s.notices).toHaveLength(1);
		s.stub.hold = new Promise<void>((r) => (release = r));
		s.h.app.store.notifyReloaded();
		await advance(PUSH_DELAY_MS);
		expect(s.stub.calls).toBe(2);
		const manual = s.scheduler.syncNow();
		s.stub.hold = null;
		release();
		const r = await manual;
		expect(s.stub.calls).toBe(3);
		expect(r?.error?.kind).toBe("server");
		expect(s.notices.at(-1)).toBe('TickTick sync stopped in "Work": server error (HTTP 500)');
	});

	it("a failure is reported with its list and never retried in a loop", async () => {
		const s = await setup({ minutes: 5, start: false });
		s.stub.results.push(failed({ kind: "server", message: "TickTick: server error (HTTP 500)" }));
		s.scheduler.start();
		await flush();
		expect(s.notices).toEqual(['TickTick sync stopped in "Work": server error (HTTP 500)']);
		await advance(5 * MIN - 1);
		expect(s.stub.calls).toBe(1);
		await advance(1);
		expect(s.stub.calls).toBe(2);
	});

	it("a message that names the list already is shown as it is", async () => {
		const s = await setup({ minutes: 60 });
		s.stub.results.push(failed({ kind: "list-limit", message: 'TickTick: "Work" has 99 open tasks, the limit of TickTick\'s free plan.' }));
		await s.scheduler.syncNow();
		expect(s.notices).toEqual(['TickTick: "Work" has 99 open tasks, the limit of TickTick\'s free plan.']);
	});

	it("HTTP 429: the spec's notice, and no pull or push before Retry-After", async () => {
		const s = await setup({ minutes: 5, start: false });
		s.stub.results.push(failed({ kind: "rate-limited", message: "TickTick: too many requests (HTTP 429)", retryAfterSec: 600 }));
		s.scheduler.start();
		await flush();
		expect(s.notices).toEqual([RATE_LIMITED_TEXT]);
		await s.h.app.tasks.create({ title: "One", categoryId: WORK });
		await advance(10 * MIN - 1);
		expect(s.stub.calls).toBe(1);
		await advance(1);
		expect(s.stub.calls).toBe(2);
		await advance(5 * MIN);
		expect(s.stub.calls).toBe(3);
	});

	it("HTTP 429: a trigger queued during that sync waits for Retry-After too", async () => {
		const s = await setup({ minutes: 60, start: false });
		let release!: () => void;
		s.stub.hold = new Promise<void>((r) => (release = r));
		s.stub.results.push(failed({ kind: "rate-limited", message: "TickTick: too many requests (HTTP 429)", retryAfterSec: 600 }));
		s.scheduler.start();
		await flush();
		s.h.app.store.notifyReloaded();
		await advance(PUSH_DELAY_MS);
		expect(s.stub.calls).toBe(1);
		s.stub.hold = null;
		release();
		await flush();
		await advance(10 * MIN - 1);
		expect(s.stub.calls).toBe(1);
		await advance(1);
		expect(s.stub.calls).toBe(2);
	});

	it("HTTP 429: a push armed by an edit during that sync waits for Retry-After", async () => {
		const s = await setup({ minutes: 60, start: false });
		let release!: () => void;
		s.stub.hold = new Promise<void>((r) => (release = r));
		s.stub.results.push(failed({ kind: "rate-limited", message: "TickTick: too many requests (HTTP 429)", retryAfterSec: 600 }));
		s.scheduler.start();
		await flush();
		await s.h.app.tasks.create({ title: "Edit during the sync", categoryId: WORK });
		s.stub.hold = null;
		release();
		await flush();
		await advance(10 * MIN - 1);
		expect(s.stub.calls).toBe(1);
		await advance(1);
		expect(s.stub.calls).toBe(2);
	});

	it("a background failure repeated is shown once; Sync now always shows it, and success after a manual run", async () => {
		const s = await setup({ minutes: 5, start: false });
		const net = () => failed({});
		s.stub.results.push(net(), net(), net());
		s.scheduler.start();
		await flush();
		await advance(5 * MIN);
		expect(s.stub.calls).toBe(2);
		expect(s.notices).toHaveLength(1);
		await s.scheduler.syncNow();
		expect(s.notices).toHaveLength(2);
		await s.scheduler.syncNow();
		expect(s.notices.at(-1)).toBe("TickTick: synced.");
	});

	it("an unexpected error is handed to the host and the schedule goes on", async () => {
		const s = await setup({ minutes: 5, start: false });
		s.stub.results.push(new Error("boom"));
		s.scheduler.start();
		await flush();
		expect(s.errors).toHaveLength(1);
		await advance(5 * MIN);
		expect(s.stub.calls).toBe(2);
	});

	it("a thrown error reads in settings as the same failure reported by the sync would (issue 22)", async () => {
		const s = await setup({ minutes: 60 });
		s.stub.results.push(new TickTickError("rate-limited", "TickTick: HTTP 429", { retryAfterSec: 30 }));
		await s.scheduler.syncNow();
		expect(s.scheduler.status().error).toBe(RATE_LIMITED_TEXT);
		s.stub.results.push(failed({ kind: "rate-limited", message: "TickTick: HTTP 429", retryAfterSec: 30 }));
		await s.scheduler.syncNow();
		expect(s.scheduler.status().error).toBe(RATE_LIMITED_TEXT);
		s.stub.results.push(new TickTickError("network", "TickTick: no answer (network error)."));
		await s.scheduler.syncNow();
		expect(s.scheduler.status().error).toBe("TickTick: no answer (network error).");
	});

	it("keeps the tasks waiting for confirmation from the latest sync, and applies nothing", async () => {
		const s = await setup({ minutes: 60 });
		const seen: (readonly PendingTrash[])[] = [];
		s.scheduler.events.on("confirmations", (p) => seen.push(p));
		const pending: PendingTrash = { listId: WORK, reason: "many", tasks: [{ id: "t1", title: "Errand" }] };
		s.stub.results.push(ok([pending]));
		await s.scheduler.syncNow();
		expect(s.scheduler.pendingConfirmations()).toEqual([pending]);
		expect(seen).toEqual([[pending]]);
		// A sync that stops before its pull keeps them.
		s.stub.results.push(failed({}));
		await s.scheduler.syncNow();
		expect(s.scheduler.pendingConfirmations()).toEqual([pending]);
		await s.scheduler.syncNow();
		expect(s.scheduler.pendingConfirmations()).toEqual([]);
	});
});

describe("TickTick sync scheduler with the real engine: two devices do not wake each other forever", () => {
	it("a sync that finds nothing writes nothing, so a reload echoed back from another device settles", async () => {
		const s = await syncHarness();
		await linkedList(s);
		await s.h.app.tasks.create({ title: "Call the bank", categoryId: s.h.app.store.state.syncLinks.values().next().value!.logwellId });
		vi.useFakeTimers({ now: Date.parse(NOW), toFake: ["setTimeout", "clearTimeout", "Date"] });
		const device = new MemoryTickTickDevice();
		device.setEnabled(true);
		const secret = new MemoryTickTickSecret();
		secret.set("token");
		let syncs = 0;
		const scheduler = new TickTickScheduler({
			store: s.h.app.store,
			sync: { sync: () => (syncs++, s.sync.sync()) },
			device,
			secret,
			pullMinutes: () => 60,
			timers: { set: (fn, ms) => setTimeout(fn, ms) as unknown as number, clear: (t) => clearTimeout(t) },
			now: () => Date.now(),
			notify: () => undefined,
			error: (e) => {
				throw e;
			},
		});
		// The other device: every write here reaches it, it syncs, and its write comes back here as a reload.
		s.h.app.store.bus.on("changed", (e) => {
			if (e.changes !== undefined) setTimeout(() => s.h.app.store.notifyReloaded(), 1000);
		});
		scheduler.start();
		await advance(30 * MIN);
		scheduler.dispose();
		expect(syncs).toBeLessThanOrEqual(3);
	});
});
