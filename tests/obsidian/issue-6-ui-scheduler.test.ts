import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryTickTickDevice, MemoryTickTickSecret } from "../../src/app/ports";
import { type SyncFailure, type SyncResult, TICKTICK_SYNC_LABEL } from "../../src/app/SyncService";
import type { Category, SyncLink } from "../../src/domain/types";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { SecretStorageTickTickSecret } from "../../src/obsidian/tickTickPorts";
import { type SyncStatus, TickTickScheduler } from "../../src/obsidian/tickTickScheduler";
import { appHarness } from "../app/harness";

// What the settings and the list header read of the scheduler (the last sync and the last
// failure), the failure notices with their actions, and the secret field's id.

const NOW = "2026-10-01T09:59:00.000Z";
const WORK = "00000000-0000-4000-8000-00000000000a";
const MIN = 60_000;

function db(): string {
	const d = createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-other", now: NOW });
	const categories = new Map(d.categories);
	const work: Category = { id: WORK, name: "Work", icon: null, color: null, nameKey: "work", isInbox: false, sortKey: "V1", createdAt: NOW, modifiedAt: NOW };
	categories.set(WORK, work);
	const link: SyncLink = { kind: "list", logwellId: WORK, ttId: "p-work", ttProjectId: null, etag: null, base: {}, noteBySync: false, lastPulledAt: NOW, modifiedAt: NOW };
	return serializeDb({ ...d, categories, syncLinks: new Map([[`list:${WORK}`, link]]) });
}

function result(failures: SyncFailure[] = [], warnings: string[] = []): SyncResult {
	return { ok: failures.length === 0, error: failures[0] ?? null, failures, content: { wrote: false, label: TICKTICK_SYNC_LABEL }, pulled: 0, pushed: 0, needsConfirmation: [], warnings };
}
const failure = (over: Partial<SyncFailure>): SyncFailure => ({ listId: WORK, listName: "Work", kind: "network", message: "TickTick: no answer (network error).", retryAfterSec: null, ...over });

async function setup(withNotifyFailure: boolean) {
	const h = await appHarness({ initial: db() });
	vi.useFakeTimers({ now: Date.parse(NOW), toFake: ["setTimeout", "clearTimeout", "Date"] });
	const queue: (SyncResult | Error)[] = [];
	const device = new MemoryTickTickDevice();
	device.setEnabled(true);
	const secret = new MemoryTickTickSecret();
	secret.set("token");
	const notices: string[] = [];
	const failures: [SyncFailure, string][] = [];
	const errors: unknown[] = [];
	const scheduler = new TickTickScheduler({
		store: h.app.store,
		sync: {
			async sync() {
				const r = queue.shift() ?? result();
				if (r instanceof Error) throw r;
				return r;
			},
		},
		device,
		secret,
		pullMinutes: () => 5,
		timers: { set: (fn, ms) => setTimeout(fn, ms) as unknown as number, clear: (t) => clearTimeout(t) },
		now: () => Date.now(),
		notify: (m) => notices.push(m),
		...(withNotifyFailure ? { notifyFailure: (f: SyncFailure, t: string) => failures.push([f, t]) } : {}),
		error: (e) => errors.push(e),
	});
	const statuses: SyncStatus[] = [];
	scheduler.events.on("status", (s) => statuses.push(s));
	return { scheduler, queue, notices, failures, errors, statuses };
}

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.useRealTimers());

describe("scheduler status (settings status line, list header)", () => {
	it("starts empty, records the time of a sync without a failure and announces it", async () => {
		const s = await setup(false);
		expect(s.scheduler.status()).toEqual({ lastSyncAt: null, error: null });
		s.scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(s.scheduler.status()).toEqual({ lastSyncAt: Date.parse(NOW), error: null });
		expect(s.statuses).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(5 * MIN);
		expect(s.scheduler.status().lastSyncAt).toBe(Date.parse(NOW) + 5 * MIN);
	});

	it("a failed sync keeps the time of the last good one and holds the failure text; the next good one clears it", async () => {
		const s = await setup(false);
		s.scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		const good = s.scheduler.status().lastSyncAt;
		s.queue.push(result([failure({ kind: "server", message: 'TickTick: server error' })]));
		await vi.advanceTimersByTimeAsync(5 * MIN);
		expect(s.scheduler.status()).toEqual({ lastSyncAt: good, error: 'TickTick sync stopped in "Work": server error' });
		await vi.advanceTimersByTimeAsync(5 * MIN);
		expect(s.scheduler.status().error).toBeNull();
		expect(s.scheduler.status().lastSyncAt).toBe(Date.parse(NOW) + 10 * MIN);
	});

	it("a sync that throws is a failure too", async () => {
		const s = await setup(false);
		s.queue.push(new Error("boom"));
		s.scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(s.scheduler.status()).toEqual({ lastSyncAt: null, error: "boom" });
		expect(s.errors).toHaveLength(1);
	});
});

describe("status for screens that sit outside a sync", () => {
	it("refresh announces the status, so a changed device switch or token redraws the screens", async () => {
		const s = await setup(false);
		s.scheduler.refresh();
		expect(s.statuses).toHaveLength(0);
		s.scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		const before = s.statuses.length;
		s.scheduler.refresh();
		expect(s.statuses).toHaveLength(before + 1);
	});

	it("a first sync run from the link dialog counts as the latest sync, or as a failure", async () => {
		const s = await setup(false);
		s.scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(2 * MIN);
		s.scheduler.recordSync(result());
		expect(s.scheduler.status()).toEqual({ lastSyncAt: Date.now(), error: null });
		s.scheduler.recordSync(result([failure({ kind: "server", message: "TickTick: server error" })]));
		expect(s.scheduler.status().error).toContain("server error");
		expect(s.scheduler.status().lastSyncAt).toBe(Date.now());
	});
});

describe("warnings of a sync that went on", () => {
	const WARNING = "TickTick tags could not be read; tags were synced by name only.";

	it("shows a warning once per session, not on every sync, and a different one when it comes", async () => {
		const s = await setup(true);
		s.queue.push(result([], [WARNING]), result([], [WARNING]), result([], [WARNING, "Another problem."]), result([], [WARNING]));
		s.scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(5 * MIN);
		expect(s.notices).toEqual([WARNING, "Another problem."]);
	});

	it("a first sync from the link dialog shares the once-per-session rule", async () => {
		const s = await setup(false);
		s.scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		s.scheduler.recordSync(result([], [WARNING]));
		s.scheduler.recordSync(result([], [WARNING]));
		s.queue.push(result([], [WARNING]));
		await vi.advanceTimersByTimeAsync(5 * MIN);
		expect(s.notices.filter((n) => n === WARNING)).toHaveLength(1);
	});

	it("shows it with a failure of another list, and for a manual sync too", async () => {
		const s = await setup(false);
		s.queue.push(result([failure({ kind: "server", message: "TickTick: server error" })], [WARNING]));
		s.scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(s.notices).toEqual([WARNING, 'TickTick sync stopped in "Work": server error']);
		s.queue.push(result([], [WARNING]));
		await s.scheduler.syncNow();
		expect(s.notices.filter((n) => n === WARNING)).toHaveLength(1);
	});
});

describe("failure notices", () => {
	it("go to notifyFailure with the failure and its text, once per distinct text", async () => {
		const s = await setup(true);
		const refused = failure({ listId: null, listName: null, kind: "unauthorized", message: "TickTick: the API token was refused" });
		s.queue.push(result([refused, { ...refused }]));
		s.scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(s.failures).toEqual([[refused, "TickTick: the API token was refused"]]);
		expect(s.notices).toEqual([]);
	});

	it("go to notify when the host has no notifyFailure", async () => {
		const s = await setup(false);
		s.queue.push(result([failure({ kind: "rate-limited", message: "TickTick: too many requests", retryAfterSec: 60 })]));
		s.scheduler.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(s.notices).toEqual(["TickTick: too many requests. Sync will try again at the next pull."]);
	});
});

describe("the token's secret id", () => {
	const store = (init: Record<string, string> = {}) => {
		const secrets = new Map(Object.entries(init));
		return { secrets, app: { secretStorage: { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, v: string) => void secrets.set(id, v) } } };
	};

	it("reads the secret the setting names, follows a change of it and reads none for an empty id", () => {
		const f = store({ "my-token": "abc", "logwell-ticktick-token": "old" });
		let id = "my-token";
		const port = new SecretStorageTickTickSecret(f.app, () => id);
		expect(port.get()).toBe("abc");
		id = "logwell-ticktick-token";
		expect(port.get()).toBe("old");
		id = "";
		expect(port.get()).toBeNull();
	});

	it("never writes under an empty id", () => {
		const f = store();
		const port = new SecretStorageTickTickSecret(f.app, () => "");
		port.set("x");
		port.clear();
		expect(f.secrets.size).toBe(0);
	});

	it("a secret that is missing or empty reads as no token", () => {
		const f = store({ empty: "" });
		expect(new SecretStorageTickTickSecret(f.app, () => "empty").get()).toBeNull();
		expect(new SecretStorageTickTickSecret(f.app, () => "missing").get()).toBeNull();
	});
});
