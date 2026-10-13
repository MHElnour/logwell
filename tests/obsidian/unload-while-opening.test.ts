// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { FocusService } from "../../src/app/FocusService";
import { RecurrenceService } from "../../src/app/RecurrenceService";
import { DbSession } from "../../src/obsidian/session";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { emptyDbText, makeTask } from "../persistence/fixtures";
import { fakeApp, loadPlugin } from "./fake-vault";

// Unloading the plugin while the database opens closes the opening session; the rest of
// its open then fails against the closed store. That is expected and shows no error once the plugin is gone.

const shown = vi.hoisted(() => [] as unknown[]);
vi.mock("../../src/obsidian/notices", async (original) => {
	const real = await original<typeof import("../../src/obsidian/notices")>();
	return {
		...real,
		showError: (err: unknown) => {
			shown.push(err);
		},
	};
});

afterEach(() => vi.restoreAllMocks());

describe("unloading while the database opens", () => {
	it("shows no error from the open the unload cut short", async () => {
		const fake = fakeApp();
		// Trash long expired: the open purges it, a write.
		const d = createEmptyDb({ dbId: "db-a", revision: "r-aaaaaaaaaaaa", deviceId: "d-other", now: "2020-01-01T00:00:00.000Z" });
		const old = makeTask("00000001-0000-4000-8000-000000000001", { title: "Old errand" });
		const trash = new Map([["b1", { batchId: "b1", deletedAt: "2020-01-01T00:00:00.000Z", tasks: [old] }]]);
		fake.files.set("A.cpbase", serializeDb({ ...d, trash }));
		const { default: CheckpointPlugin } = await import("../../src/main");
		const Ctor = CheckpointPlugin as unknown as new (a: unknown, m: unknown) => InstanceType<typeof CheckpointPlugin>;
		const plugin = new Ctor(fake.app, { id: "logwell", dir: "config/plugins/logwell" });
		await plugin.onload();
		plugin.settings.activeDatabasePath = "A.cpbase";
		// The unload lands after the file is read, while the open goes on.
		type Open = (this: FocusService) => ReturnType<FocusService["open"]>;
		const focusOpen = Object.getOwnPropertyDescriptor(FocusService.prototype, "open")!.value as Open;
		vi.spyOn(FocusService.prototype, "open").mockImplementation(async function (this: FocusService) {
			plugin.onunload();
			await new Promise((r) => setTimeout(r, 10));
			return focusOpen.call(this);
		});
		fake.layoutReady();
		await plugin.ready();
		await new Promise((r) => setTimeout(r, 20));
		expect(plugin.session).toBeNull();
		expect(shown).toEqual([]);
	});
});

/** Every session that opens, and every one that closes, from here on. */
function trackSessions() {
	const opened: DbSession[] = [];
	const closed = new Set<DbSession>();
	type Run = (this: DbSession) => Promise<void>;
	const open = Object.getOwnPropertyDescriptor(DbSession.prototype, "open")!.value as Run;
	const close = Object.getOwnPropertyDescriptor(DbSession.prototype, "close")!.value as Run;
	vi.spyOn(DbSession.prototype, "open").mockImplementation(function (this: DbSession) {
		opened.push(this);
		return open.call(this);
	});
	vi.spyOn(DbSession.prototype, "close").mockImplementation(function (this: DbSession) {
		closed.add(this);
		return close.call(this);
	});
	return { opened, closed };
}

function twoDatabases() {
	const fake = fakeApp();
	fake.files.set("A.cpbase", emptyDbText("db-a", "r-aaaaaaaaaaaa"));
	fake.files.set("B.cpbase", emptyDbText("db-b", "r-bbbbbbbbbbbb"));
	shown.length = 0;
	return fake;
}

describe("unloading while a database switch runs", () => {
	it("#112: a switch still closing the old database at unload opens nothing afterwards", async () => {
		const fake = twoDatabases();
		const plugin = await loadPlugin(fake, "A.cpbase");
		const sessions = trackSessions();
		// The unload lands while the switch waits for the old database's sync request.
		vi.spyOn(DbSession.prototype, "settleSync").mockImplementation(async () => {
			plugin.onunload();
			await new Promise((r) => setTimeout(r, 10));
		});
		plugin.settings.activeDatabasePath = "B.cpbase";
		await plugin.openActiveDatabase();
		expect(sessions.opened.map((s) => s.path)).toEqual([]);
		expect(plugin.session).toBeNull();
		expect(shown).toEqual([]);
	});

	it("#112: an open queued before the unload does not run after it", async () => {
		const fake = twoDatabases();
		const plugin = await loadPlugin(fake, "A.cpbase");
		const sessions = trackSessions();
		plugin.settings.activeDatabasePath = "B.cpbase";
		const first = plugin.openActiveDatabase();
		const second = plugin.openActiveDatabase();
		plugin.onunload();
		await first;
		await second;
		expect(sessions.opened.map((s) => s.path)).toEqual([]);
		expect(plugin.session).toBeNull();
	});

	it("#112: a database whose open fails after its file was read is closed", async () => {
		const fake = twoDatabases();
		const plugin = await loadPlugin(fake, "A.cpbase");
		const sessions = trackSessions();
		vi.spyOn(RecurrenceService.prototype, "endExhaustedSeries").mockRejectedValue(new Error("Could not end the series."));
		await plugin.setActiveDatabase("B.cpbase");
		expect(plugin.session).toBeNull();
		expect(sessions.opened.map((s) => s.path)).toEqual(["B.cpbase"]);
		expect(sessions.closed.has(sessions.opened[0]!)).toBe(true);
		expect(shown).toHaveLength(1);
	});
});
