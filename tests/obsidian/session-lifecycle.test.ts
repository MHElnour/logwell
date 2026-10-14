// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settle } from "../ui/app-helpers";
import { FocusService } from "../../src/app/FocusService";
import { RecurrenceService } from "../../src/app/RecurrenceService";
import { DbSession } from "../../src/obsidian/session";
import { SAVE_DEBOUNCE_MS } from "../../src/persistence/CpbaseStore";
import { CURRENT_SCHEMA_VERSION, createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { descendant, emptyDbText, load, makeTask, withTask } from "../persistence/fixtures";
import { type FakeApp, fakeApp, fileOf, loadPlugin } from "./fake-vault";

// The plugin's database lifecycle over a fake vault: opening (migration and repair notices, ending exhausted series),
// switching databases, closing a session (and what it cannot keep), "Open conflict view", the active database deleted
// and recreated, and unloading while a database opens.

interface Recorded {
	message: string;
	labels: string[];
	timeout: number | undefined;
	/** Runs the action with this label, the first one without. */
	run: (label?: string) => unknown;
}

/** Every notice shown: action notices, errors (with their context) and plain Obsidian notices. */
const notices = vi.hoisted(() => ({ actions: [] as Recorded[], errors: [] as unknown[], contexts: [] as (string | undefined)[], plain: [] as string[] }));

vi.mock("../../src/obsidian/notices", async (original) => ({
	...(await original<typeof import("../../src/obsidian/notices")>()),
	actionNotice: (message: string, actions: { label: string; run: () => unknown }[], timeout?: number) => {
		const run = (label?: string) => (label === undefined ? actions[0] : actions.find((a) => a.label === label))?.run();
		notices.actions.push({ message, labels: actions.map((a) => a.label), timeout, run });
		return {};
	},
	showError: (err: unknown, context?: string) => {
		notices.errors.push(err);
		notices.contexts.push(context);
	},
	syncNotice: () => ({}),
}));

vi.mock("obsidian", async (importOriginal) => {
	const original = await importOriginal<Record<string, unknown>>();
	const Base = original.Notice as new (...args: unknown[]) => object;
	return {
		...original,
		Notice: class extends Base {
			constructor(message: unknown, ...rest: unknown[]) {
				super(message, ...rest);
				notices.plain.push(String(message));
			}
		},
	};
});

// Create database asks for a folder and a name: the vault root and "New".
vi.mock("../../src/obsidian/modals", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	pickFolder: () => Promise.resolve({ isRoot: () => true, path: "/" }),
	prompt: () => Promise.resolve({ name: "New" }),
}));

const A = "A.cpbase";
const B = "B.cpbase";
const PATH = "Checkpoint.cpbase";
const fixture = (version: number) => readFileSync(join(import.meta.dirname, "..", "fixtures", `schema-v${version}.cpbase`), "utf8");

/** Two databases, A and B. */
function setup(): FakeApp {
	const fake = fakeApp();
	fake.files.set(A, emptyDbText("db-a", "r-aaaaaaaaaaaa"));
	fake.files.set(B, emptyDbText("db-b", "r-bbbbbbbbbbbb"));
	return fake;
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);
beforeEach(() => {
	notices.actions.length = 0;
	notices.errors.length = 0;
	notices.contexts.length = 0;
	notices.plain.length = 0;
	unhandled.length = 0;
	process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
	process.off("unhandledRejection", onUnhandled);
	vi.restoreAllMocks();
});

type Emitter = { onStoreEvent(e: unknown): void };
const emit = (session: unknown, e: unknown) => (session as Emitter).onStoreEvent(e);
const titles = (text: string | undefined) => [...load(text ?? "").tasks.values()].map((t) => t.title);
const conflictCopies = (fake: FakeApp) => [...fake.plugin.files.keys()].filter((p) => p.includes("/conflicts/"));

describe("opening a database", () => {
	// Opening an older database shows "The database was upgraded from schema X to Y" exactly once per migration.
	const upgrades = () => notices.actions.map((n) => n.message).filter((m) => m.includes("was upgraded from schema"));

	it("opening a v1 database shows the upgrade notice once", async () => {
		const fake = fakeApp();
		fake.files.set(PATH, fixture(1));
		await loadPlugin(fake, PATH);
		expect(upgrades()).toHaveLength(1);
		expect(upgrades()[0]).toContain("from schema 1 to 6");
	});

	it("the modify event for the migration's own save does not announce it again", async () => {
		const fake = fakeApp();
		fake.files.set(PATH, fixture(1));
		const plugin = await loadPlugin(fake, PATH);
		await plugin.session!.store.flush();
		fake.fire("modify", fileOf(PATH));
		await plugin.ready();
		await settle();
		expect(upgrades()).toHaveLength(1);
	});

	it("re-selecting the already active v1 database announces its migration once per migration", async () => {
		const fake = fakeApp();
		fake.files.set(PATH, fixture(1));
		const plugin = await loadPlugin(fake, PATH);
		await plugin.setActiveDatabase(PATH);
		// The first open rewrote the file at the current schema, so the second open has nothing to migrate.
		expect(upgrades()).toHaveLength(1);
	});

	it("two opens queued at start-up (layout ready plus a settings change) announce once", async () => {
		const fake = fakeApp();
		fake.files.set(PATH, fixture(1));
		const plugin = await loadPlugin(fake, PATH);
		await Promise.all([plugin.openActiveDatabase(), plugin.onSettingChanged("activeDatabasePath")]);
		expect(upgrades()).toHaveLength(1);
	});

	it("opening a current-schema database shows no upgrade notice", async () => {
		const fake = fakeApp();
		fake.files.set(PATH, fixture(6));
		await loadPlugin(fake, PATH);
		expect(upgrades()).toHaveLength(0);
	});

	it("opening a v3 database shows the upgrade notice once", async () => {
		const fake = fakeApp();
		fake.files.set(PATH, fixture(3));
		const plugin = await loadPlugin(fake, PATH);
		await plugin.session!.store.flush();
		fake.fire("modify", fileOf(PATH));
		await plugin.ready();
		await plugin.setActiveDatabase(PATH);
		expect(upgrades()).toHaveLength(1);
		expect(upgrades()[0]).toContain("from schema 3 to 6");
	});

	it("opening a v2 database shows the upgrade notice once", async () => {
		const fake = fakeApp();
		fake.files.set(PATH, fixture(2));
		const plugin = await loadPlugin(fake, PATH);
		await plugin.setActiveDatabase(PATH);
		expect(upgrades()).toHaveLength(1);
		expect(upgrades()[0]).toContain("from schema 2 to 6");
	});

	it("#104: two sections with one name: opening says so on each open and leaves the file as it is", async () => {
		// Week 2 renamed to Week 1 in the same list, as a merge or another device can leave it.
		const text = fixture(6).replace('"name":"Week 2","nameKey":"week 2"', '"name":"Week 1","nameKey":"week 1"');
		const fake = fakeApp();
		fake.files.set(PATH, text);
		const plugin = await loadPlugin(fake, PATH);
		await plugin.setActiveDatabase(PATH);
		await plugin.session!.store.flush();
		const messages = notices.actions.map((n) => n.message);
		const attention = messages.filter((m) => m.startsWith("Some database records need your attention:"));
		expect(attention).toHaveLength(2);
		expect(attention[0]).toContain('Section "Week 1" has the same name as another section in its list.');
		expect(messages.some((m) => m.includes("were repaired"))).toBe(false);
		expect(fake.files.get(PATH)).toBe(text);
	});

	// A series whose end was reached outside a write (here a count already used up by its records) is ended when the
	// database opens, like the Trash purge.
	it("ends a series whose count its records reached; a live series is not", async () => {
		const RENT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
		const GYM = "4f5a6b7c-8d9e-4fa0-b1c2-d3e4f5a6b7c8";
		const fake = fakeApp();
		const text = fixture(5).replace('"end":{"count":12,"kind":"count"}', '"end":{"count":1,"kind":"count"}');
		if (text === fixture(5)) throw new Error("the fixture's rent line changed");
		fake.files.set(PATH, text);
		const plugin = await loadPlugin(fake, PATH);
		const tasks = plugin.session!.store.data.tasks;
		expect(tasks.get(RENT)?.status).toBe("completed");
		expect(typeof tasks.get(RENT)?.recurrence?.endedAt).toBe("string");
		expect(tasks.get(GYM)).toMatchObject({ status: "open", recurrence: { endedAt: null } });
		await plugin.session!.store.flush();
		expect(fake.files.get(PATH)).toContain(`"id":"${RENT}"`);
		expect(fake.files.get(PATH)).not.toContain('"title":"Pay rent","categoryId":"inbox","status":"open"');
	});

	it("an untouched current-schema (v6) database is not rewritten", async () => {
		const fake = fakeApp();
		fake.files.set(PATH, fixture(6));
		const plugin = await loadPlugin(fake, PATH);
		await plugin.session!.store.flush();
		expect(fake.files.get(PATH)).toBe(fixture(6));
	});
});

describe("switching databases: a session keeps writing to the file it opened", () => {
	it("an edit made just before switching databases lands in the old file, with no conflict", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const oldSession = plugin.session;
		expect(oldSession).not.toBeNull();
		await plugin.session!.app.tasks.create({ title: "edited just before the switch" });

		await plugin.setActiveDatabase(B); // well inside the save debounce
		expect(SAVE_DEBOUNCE_MS).toBeGreaterThan(0);

		expect(titles(fake.files.get(A))).toEqual(["edited just before the switch"]);
		expect(titles(fake.files.get(B))).toEqual([]);
		expect(plugin.session).not.toBeNull();
		expect(plugin.session).not.toBe(oldSession);
		expect(plugin.session!.path).toBe(B);
		expect(notices.actions).toEqual([]);
		expect(notices.errors).toEqual([]);
		expect(conflictCopies(fake)).toEqual([]);
	});

	it("the new session writes to the new file only", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		await plugin.setActiveDatabase(B);
		await plugin.session!.app.tasks.create({ title: "in B" });
		await plugin.session!.store.flush();
		expect(titles(fake.files.get(B))).toEqual(["in B"]);
		expect(titles(fake.files.get(A))).toEqual([]);
	});

	it("the old session's device-local db id is recorded under its own path", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		await plugin.session!.app.tasks.create({ title: "x" });
		await plugin.setActiveDatabase(B);
		expect(fake.app.loadLocalStorage("checkpoint-db-id-A.cpbase")).toBe("db-a");
		expect(fake.app.loadLocalStorage("checkpoint-db-id-B.cpbase")).toBe("db-b");
	});

	it("a rename of the open database moves the session's path (and the setting) with it", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const session = plugin.session!;
		// The vault renames the file, then fires the event.
		const content = fake.files.get(A)!;
		fake.files.delete(A);
		fake.files.set("Moved/A2.cpbase", content);
		fake.fire("rename", fileOf("Moved/A2.cpbase"), A);
		expect(session.path).toBe("Moved/A2.cpbase");
		expect(plugin.settings.activeDatabasePath).toBe("Moved/A2.cpbase");

		await session.app.tasks.create({ title: "after the move" });
		await session.store.flush();
		expect(titles(fake.files.get("Moved/A2.cpbase"))).toEqual(["after the move"]);
		expect(notices.actions).toEqual([]);
	});

	it("renaming the old database while the switch is pending does not touch the new setting", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const old = plugin.session!;
		await old.app.tasks.create({ title: "pending" });
		plugin.settings.activeDatabasePath = B;
		const switching = plugin.openActiveDatabase();
		const content = fake.files.get(A)!;
		fake.files.delete(A);
		fake.files.set("A-moved.cpbase", content);
		fake.fire("rename", fileOf("A-moved.cpbase"), A);
		await switching;
		expect(plugin.settings.activeDatabasePath).toBe(B);
		expect(old.path).toBe("A-moved.cpbase");
		expect(titles(fake.files.get("A-moved.cpbase"))).toEqual(["pending"]);
		expect(plugin.session!.path).toBe(B);
	});

	it("a rename that happens while the new session is opening is followed by it", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		plugin.settings.activeDatabasePath = B;
		const switching = plugin.openActiveDatabase();
		await Promise.resolve();
		await Promise.resolve();
		const content = fake.files.get(B)!;
		fake.files.delete(B);
		fake.files.set("B-moved.cpbase", content);
		fake.fire("rename", fileOf("B-moved.cpbase"), B);
		await switching;
		expect(plugin.settings.activeDatabasePath).toBe("B-moved.cpbase");
		expect(plugin.session?.path).toBe("B-moved.cpbase");
	});

	it("#103: a change to the file while it opens is read once the open finishes, so the next edit saves with no conflict", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		// Another device's save lands after B is read, while the rest of its open goes on (the focus timer of B is
		// the one opened from here on).
		type Open = (this: FocusService) => ReturnType<FocusService["open"]>;
		const focusOpen = Object.getOwnPropertyDescriptor(FocusService.prototype, "open")!.value as Open;
		const spy = vi.spyOn(FocusService.prototype, "open").mockImplementation(function (this: FocusService) {
			fake.files.set(B, descendant(fake.files.get(B)!, (d) => withTask(d, makeTask("remote")).next, "r-remote000001"));
			fake.fire("modify", fileOf(B));
			return focusOpen.call(this);
		});
		try {
			await plugin.setActiveDatabase(B);
		} finally {
			spy.mockRestore();
		}
		const session = plugin.session!;
		await session.store.flush();
		expect([...session.app.store.state.tasks.values()].map((t) => t.title)).toEqual(["Task remote"]);

		await session.app.tasks.create({ title: "mine" });
		await session.store.flush();
		expect(titles(fake.files.get(B)).sort()).toEqual(["Task remote", "mine"]);
		expect(notices.actions).toEqual([]);
		expect(conflictCopies(fake)).toEqual([]);
	});

	it("#113: a note renamed during a switch is followed by the database being closed, as well as by the one opening", async () => {
		const fake = setup();
		const note = { path: "Notes/X.md", linkedAt: "2026-10-01T09:00:00.000Z" };
		fake.files.set(A, descendant(fake.files.get(A)!, (d) => withTask(d, makeTask("a1", { descriptionNote: note })).next, "r-a00000000001"));
		fake.files.set(B, descendant(fake.files.get(B)!, (d) => withTask(d, makeTask("b1", { descriptionNote: note })).next, "r-b00000000001"));
		const plugin = await loadPlugin(fake, A);
		// The note's folder is renamed while the switch waits for A's sync request (the test stub's
		// files all count as folders, so a folder rename is the one these tests can send).
		const settle = vi.spyOn(plugin.session!, "settleSync").mockImplementation(async () => {
			fake.fire("rename", fileOf("Archive"), "Notes");
			await new Promise((r) => setTimeout(r, 10));
		});
		await plugin.setActiveDatabase(B);
		expect(settle).toHaveBeenCalled();
		const notePaths = (text: string | undefined) => [...load(text ?? "").tasks.values()].map((t) => t.descriptionNote?.path);
		expect(notePaths(fake.files.get(A))).toEqual(["Archive/X.md"]);
		expect([...plugin.session!.app.store.state.tasks.values()].map((t) => t.descriptionNote?.path)).toEqual(["Archive/X.md"]);
		expect(notices.errors).toEqual([]);
	});

	it("#113: a note rename that reaches the closing database after its file closed is applied when it opens again", async () => {
		const fake = setup();
		const note = { path: "Notes/X.md", linkedAt: "2026-10-01T09:00:00.000Z" };
		fake.files.set(A, descendant(fake.files.get(A)!, (d) => withTask(d, makeTask("a1", { descriptionNote: note })).next, "r-a00000000001"));
		const plugin = await loadPlugin(fake, A);
		const store = plugin.session!.store;
		const close = store.close.bind(store);
		vi.spyOn(store, "close").mockImplementation(async () => {
			await close();
			fake.fire("rename", fileOf("Archive"), "Notes");
		});
		await plugin.setActiveDatabase(B);
		await plugin.setActiveDatabase(A);
		expect([...plugin.session!.app.store.state.tasks.values()].map((t) => t.descriptionNote?.path)).toEqual(["Archive/X.md"]);
		expect(notices.errors).toEqual([]);
	});
});

describe("closing a session", () => {
	it("flushes held-back renames before the store closes", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const session = plugin.session!;
		const order: string[] = [];
		vi.spyOn(session.app.noteRenames, "flushRenames").mockImplementation(() => void order.push("flushRenames"));
		const close = session.store.close.bind(session.store);
		vi.spyOn(session.store, "close").mockImplementation(() => {
			order.push("store.close");
			return close();
		});
		await plugin.setActiveDatabase(B);
		expect(order).toEqual(["flushRenames", "store.close"]);
	});

	describe("a store whose close() rejects", () => {
		// The plugin must not keep pointing at the closed session, and must not leak an unhandled rejection.

		it("switching databases still opens the new one and plugin.session is the new session", async () => {
			const fake = setup();
			const plugin = await loadPlugin(fake, A);
			const old = plugin.session!;
			vi.spyOn(old.store, "close").mockRejectedValue(new Error("EACCES"));

			await plugin.setActiveDatabase(B);

			expect(plugin.session).not.toBeNull();
			expect(plugin.session).not.toBe(old);
			expect(plugin.session!.path).toBe(B);
			expect(plugin.settings.activeDatabasePath).toBe(B);
			expect(notices.errors.map(String)).toEqual(["Error: EACCES"]);
		});

		it("the closed session's bus is cleared even though close() rejects", async () => {
			const fake = setup();
			const plugin = await loadPlugin(fake, A);
			const old = plugin.session!;
			const onChanged = vi.fn();
			old.app.store.bus.on("changed", onChanged);
			vi.spyOn(old.store, "close").mockRejectedValue(new Error("EACCES"));

			await expect(old.close()).rejects.toThrow("EACCES");

			old.app.store.bus.emit("changed", { label: "x" });
			expect(onChanged).not.toHaveBeenCalled();
		});

		it("held-back renames are still flushed before the failing close", async () => {
			const fake = setup();
			const plugin = await loadPlugin(fake, A);
			const old = plugin.session!;
			const flush = vi.spyOn(old.app.noteRenames, "flushRenames");
			vi.spyOn(old.store, "close").mockRejectedValue(new Error("EACCES"));
			await expect(old.close()).rejects.toThrow("EACCES");
			expect(flush).toHaveBeenCalledTimes(1);
		});

		it("unloading the plugin does not leak an unhandled rejection and drops the session", async () => {
			const fake = setup();
			const plugin = await loadPlugin(fake, A);
			const old = plugin.session!;
			vi.spyOn(old.store, "close").mockRejectedValue(new Error("EACCES"));

			plugin.onunload();
			await settle();
			await settle();

			expect(unhandled).toEqual([]);
			expect(plugin.session).toBeNull();
			expect(notices.errors.map(String)).toEqual(["Error: EACCES"]);
		});
	});

	describe("edits that could not be kept", () => {
		it("a persistent notice names the database and the reason, and never says Retrying", async () => {
			const fake = setup();
			const plugin = await loadPlugin(fake, A);
			emit(plugin.session, { type: "edits-lost", message: "disk full" });
			expect(notices.actions).toHaveLength(1);
			const n = notices.actions[0]!;
			expect(n.timeout).toBe(0);
			expect(n.message).toContain(A);
			expect(n.message).toContain("disk full");
			expect(n.message).toMatch(/unsaved/i);
			expect(n.message).toMatch(/could not be kept/i);
			expect(n.message).not.toMatch(/retry/i);
		});

		it("closing a database whose file and conflict copy cannot be written completes the switch and ends with that notice, not a retry promise", async () => {
			const fake = setup();
			const plugin = await loadPlugin(fake, A);
			await plugin.session!.app.tasks.create({ title: "pending" });
			const origProcess = fake.app.vault.process;
			fake.app.vault.process = (f, fn) => (f.path === A ? Promise.reject(new Error("EACCES")) : origProcess(f, fn));
			fake.plugin.failNextWrite((p) => p.includes("/conflicts/"));

			await plugin.setActiveDatabase(B);

			expect(plugin.session?.path).toBe(B);
			const lost = notices.actions.filter((n) => n.timeout === 0 && /could not be kept/i.test(n.message));
			expect(lost).toHaveLength(1);
			expect(lost[0]!.message).toContain(A);
			expect(notices.actions.some((n) => /retrying/i.test(n.message))).toBe(false);
			await settle();
			expect(unhandled).toEqual([]);
		});

		it("the generic save error says Retrying while the session is open", async () => {
			const fake = setup();
			const plugin = await loadPlugin(fake, A);
			emit(plugin.session, { type: "save-error", message: "EACCES" });
			expect(notices.actions).toHaveLength(1);
			expect(notices.actions[0]!.message).toBe("Could not save the database: EACCES Retrying.");
			expect(notices.actions[0]!.timeout).toBeUndefined();
		});

		it("the generic save error never says Retrying once the session is closing", async () => {
			const fake = setup();
			const plugin = await loadPlugin(fake, A);
			const session = plugin.session!;
			vi.spyOn(session.store, "close").mockImplementation(() => {
				emit(session, { type: "save-error", message: "EACCES" });
				return Promise.resolve();
			});
			await session.close();
			expect(notices.actions).toHaveLength(1);
			expect(notices.actions[0]!.message).toContain("EACCES");
			expect(notices.actions[0]!.message).not.toMatch(/retry/i);
		});
	});

	describe("a failing rename flush never skips closing the store", () => {
		it("a rename queue that throws on save: the store still closes, and the user is told", async () => {
			const fake = setup();
			// The database is newer than this plugin: it is read-only, so renames wait.
			fake.files.set(A, emptyDbText("db-a", "r-aaaaaaaaaaaa").replace(`"schemaVersion":${CURRENT_SCHEMA_VERSION}`, '"schemaVersion":7'));
			const plugin = await loadPlugin(fake, A);
			const session = plugin.session!;
			await session.app.noteRenames.rewriteNotePaths("X.md", "Y.md", false); // saved at once; the cooldown starts
			void session.app.noteRenames.rewriteNotePaths("Y.md", "Z.md", false); // held back by the cooldown
			await settle();
			fake.app.saveLocalStorage = (k: string) => {
				if (k.startsWith("logwell-pending-renames")) throw new Error("quota exceeded");
			};
			const close = vi.spyOn(session.store, "close");

			await expect(session.close()).resolves.toBeUndefined();

			expect(close).toHaveBeenCalledTimes(1);
			expect(notices.actions.some((n) => n.message.includes("quota exceeded") && /rename/i.test(n.message))).toBe(true);
		});

		it("a throwing flushRenames (spied) still closes the store and clears the bus", async () => {
			const fake = setup();
			const plugin = await loadPlugin(fake, A);
			const session = plugin.session!;
			vi.spyOn(session.app.noteRenames, "flushRenames").mockImplementation(() => {
				throw new Error("boom");
			});
			const close = vi.spyOn(session.store, "close");
			const onChanged = vi.fn();
			session.app.store.bus.on("changed", onChanged);

			await expect(session.close()).resolves.toBeUndefined();

			expect(close).toHaveBeenCalledTimes(1);
			expect(notices.actions.some((n) => n.message.includes("boom"))).toBe(true);
			session.app.store.bus.emit("changed", { label: "x" });
			expect(onChanged).not.toHaveBeenCalled();
		});

		it("a failing store.close still rejects as before, after a failing flush", async () => {
			const fake = setup();
			const plugin = await loadPlugin(fake, A);
			const session = plugin.session!;
			vi.spyOn(session.app.noteRenames, "flushRenames").mockImplementation(() => {
				throw new Error("boom");
			});
			vi.spyOn(session.store, "close").mockRejectedValue(new Error("EACCES"));
			await expect(session.close()).rejects.toThrow("EACCES");
		});
	});
});

describe("#137: one change event per replacement", () => {
	it("#137: Replace all and a snapshot restore each announce the new state once; an outside change still does", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const store = plugin.session!.app.store;
		const labels: string[] = [];
		store.bus.on("changed", (e) => labels.push(e.label));
		const { collectionsOf } = await import("../../src/persistence/schema");
		await store.replaceAll(collectionsOf(store.state), null);
		expect(labels).toEqual(["Replace all"]);

		labels.length = 0;
		fake.files.set(A, descendant(fake.files.get(A)!, (d) => d, "r-theirs000001"));
		await plugin.session!.store.handleExternalChange();
		expect(labels).toHaveLength(1);
	});
});

describe("#134: failures that used to show nothing", () => {
	it("#134: a backup that cannot be written says the database file is not affected, never Retrying", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		emit(plugin.session, { type: "backup-error", message: "ENOSPC" });
		expect(notices.actions).toHaveLength(1);
		const message = notices.actions[0]!.message;
		expect(message).toContain("ENOSPC");
		expect(message).toMatch(/backup/i);
		expect(message).toMatch(/not affected/i);
		expect(message).not.toMatch(/could not save the database|retrying/i);
	});

	it("#134: Create database tells why the file could not be created", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const refused = new Error("EINVAL");
		(fake.app.vault as unknown as { create: () => Promise<never> }).create = () => Promise.reject(refused);
		await expect(plugin.createDatabase()).resolves.toBeUndefined();
		expect(notices.errors).toEqual([refused]);
		expect(notices.contexts).toEqual(["Could not create the database New.cpbase"]);
		expect(plugin.settings.activeDatabasePath).toBe(A);
	});

	it("#134: the hourly cleanup shows a failure, and stays quiet when the file turned read-only meanwhile", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const session = plugin.session!;
		const failure = new Error("disk error");
		vi.spyOn(session.app.tasks, "purgeExpired").mockRejectedValueOnce(failure);
		const endSeries = vi.spyOn(session.app.recurrence, "endExhaustedSeries");
		await expect(session.hourlyCleanup()).resolves.toBeUndefined();
		expect(notices.errors).toEqual([failure]);
		expect(notices.contexts[0]).toMatch(/Trash/);
		expect(endSeries).not.toHaveBeenCalled();

		const { DomainError } = await import("../../src/domain/errors");
		vi.spyOn(session.app.tasks, "purgeExpired").mockRejectedValueOnce(new DomainError("ReadOnly", "read-only"));
		await expect(session.hourlyCleanup()).resolves.toBeUndefined();
		expect(notices.errors).toEqual([failure]);
	});

	it("#134: a settings save that fails after following a moved database is shown", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const refused = new Error("EACCES");
		plugin.saveData = () => Promise.reject(refused);
		fake.files.set("Moved.cpbase", fake.files.get(A)!);
		fake.files.delete(A);
		fake.fire("rename", fileOf("Moved.cpbase"), A);
		await vi.waitFor(() => expect(notices.errors).toEqual([refused]));
		expect(notices.contexts[0]).toContain("Moved.cpbase");
		expect(plugin.settings.activeDatabasePath).toBe("Moved.cpbase");
	});
});

describe("conflict copies and 'Open conflict view'", () => {
	/** Edits pending in A while another device's save lands, then a switch to B: closing A keeps them as a copy. */
	async function closedWithConflictCopy(fake: FakeApp) {
		const plugin = await loadPlugin(fake, A);
		await plugin.session!.app.tasks.create({ title: "mine" });
		fake.files.set(A, descendant(fake.files.get(A)!, (d) => withTask(d, makeTask("remote")).next, "r-remote000001"));
		await plugin.setActiveDatabase(B);
		return plugin;
	}

	it("a copy written while a session closes is announced by one notice that offers 'Open conflict view', never Keep mine / Keep theirs", async () => {
		const fake = setup();
		await closedWithConflictCopy(fake);
		expect(conflictCopies(fake)).toHaveLength(1);
		expect(notices.actions).toHaveLength(1);
		expect(notices.actions[0]!.labels).toEqual(["Open conflict view"]);
		expect(notices.actions[0]!.message).toContain(A);
		expect(notices.errors).toEqual([]);
	});

	it("the store's pending-saved-as-conflict event is announced once, even if a conflict event names the same copy", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		emit(plugin.session, { type: "pending-saved-as-conflict", path: "plugin/backups/db-a/conflicts/x.cpbase" });
		emit(plugin.session, { type: "pending-saved-as-conflict", path: "plugin/backups/db-a/conflicts/x.cpbase" });
		expect(notices.actions).toHaveLength(1);
		expect(notices.actions[0]!.labels).toEqual(["Open conflict view"]);
		expect(notices.actions[0]!.message).toContain(A);
	});

	// One test per branch of openConflictView.

	it("for a closed database whose file is there: makes it active again, then opens the Data section", async () => {
		const fake = setup();
		const plugin = await closedWithConflictCopy(fake);
		const openApp = vi.spyOn(plugin, "openApp").mockResolvedValue(null);
		await notices.actions[0]!.run("Open conflict view");
		expect(plugin.settings.activeDatabasePath).toBe(A);
		expect(plugin.session!.path).toBe(A);
		expect(openApp).toHaveBeenCalledWith("data");
		expect(notices.actions).toHaveLength(1);
	});

	it("for a closed database whose file is gone: switches to and opens nothing, and names where the copies are kept", async () => {
		const fake = setup();
		const plugin = await closedWithConflictCopy(fake);
		fake.files.delete(A);
		const openApp = vi.spyOn(plugin, "openApp").mockResolvedValue(null);
		const setActive = vi.spyOn(plugin, "setActiveDatabase");

		await notices.actions[0]!.run("Open conflict view");

		expect(openApp).not.toHaveBeenCalled();
		expect(setActive).not.toHaveBeenCalled();
		expect(plugin.settings.activeDatabasePath).toBe(B);
		expect(plugin.session!.path).toBe(B);
		expect(notices.actions).toHaveLength(2);
		const msg = notices.actions[1]!.message;
		expect(msg).toContain(A);
		expect(msg).toContain("was not found");
		expect(msg).toContain("config/plugins/logwell/backups/db-a/conflicts");
		expect(msg).toMatch(/back/);
	});

	it("for the current session whose file is momentarily missing (a sync tool rewriting it): still opens the Data view", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const session = plugin.session!;
		fake.files.delete(A);
		const openApp = vi.spyOn(plugin, "openApp").mockResolvedValue(null);
		const setActive = vi.spyOn(plugin, "setActiveDatabase");

		await session.openConflictView();

		expect(openApp).toHaveBeenCalledWith("data");
		expect(setActive).not.toHaveBeenCalled();
		expect(notices.actions).toEqual([]);
	});

	it("the damaged-database notice's 'Open conflict view' goes through the same path (issue 29)", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const old = plugin.session!;
		await plugin.setActiveDatabase(B);
		emit(old, { type: "read-only", state: { reason: "damaged", failure: "syntax", detail: "x", recoveredFrom: null } });
		const openApp = vi.spyOn(plugin, "openApp").mockResolvedValue(null);
		await notices.actions.at(-1)!.run("Open conflict view");
		expect(plugin.settings.activeDatabasePath).toBe(A);
		expect(openApp).toHaveBeenCalledWith("data");
	});

	it("#118: a change listener that throws: the write still succeeds, the other listeners run, the error is shown, and an outside change still offers Keep mine", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const session = plugin.session!;
		const failure = new Error("a view failed");
		session.app.store.bus.on("changed", () => {
			throw failure;
		});
		const seen: string[] = [];
		session.app.store.bus.on("changed", (e) => seen.push(e.label));

		await expect(session.app.tasks.create({ title: "Mine" })).resolves.toBeDefined();
		expect(seen).toHaveLength(1);
		expect(notices.errors).toEqual([failure]);

		// The file changes outside Obsidian while that edit waits to be saved.
		fake.files.set(A, descendant(fake.files.get(A)!, (d) => d, "r-theirs000001"));
		await session.store.handleExternalChange();
		expect(notices.actions.some((n) => n.labels.includes("Keep mine") && n.labels.includes("Keep theirs"))).toBe(true);
		expect(seen).toHaveLength(2);
	});
});

describe("the active database deleted, then recreated", () => {
	// Sync or git deletes the file and brings it back: the plugin reopens it instead of staying on "Loading" until a
	// restart.

	async function openThenDelete() {
		const fake = fakeApp();
		fake.files.set(PATH, emptyDbText("db-1"));
		const plugin = await loadPlugin(fake, PATH);
		expect(plugin.session).not.toBeNull();
		const content = fake.files.get(PATH)!;
		fake.files.delete(PATH);
		fake.fire("delete", fileOf(PATH));
		await plugin.ready();
		expect(plugin.session).toBeNull();
		notices.plain.length = 0;
		return { fake, plugin, content };
	}

	it("deleting it shows exactly one notice, naming the file, and closes the session", async () => {
		const fake = fakeApp();
		const plugin = await loadPlugin(fake, PATH);
		const close = vi.fn(() => Promise.resolve());
		plugin.session = { close, settleSync: () => Promise.resolve(), store: {} } as unknown as typeof plugin.session;
		notices.plain.length = 0;
		fake.fire("delete", fileOf(PATH));
		await plugin.ready();
		expect(close).toHaveBeenCalledTimes(1);
		expect(notices.plain).toHaveLength(1);
		expect(notices.plain[0]).toContain(PATH);
	});

	it("edits pending when the file was deleted are announced once as a conflict copy", async () => {
		const fake = fakeApp();
		fake.files.set(PATH, emptyDbText("db-1"));
		const plugin = await loadPlugin(fake, PATH);
		await plugin.session!.app.tasks.create({ title: "unsaved" });
		fake.files.delete(PATH);
		notices.actions.length = 0;
		fake.fire("delete", fileOf(PATH));
		await plugin.ready();
		expect(notices.actions).toHaveLength(1);
		expect(notices.actions[0]!.labels).toEqual(["Open conflict view"]);
		expect(conflictCopies(fake)).toHaveLength(1);
	});

	it("reopens when the file is created again", async () => {
		const { fake, plugin, content } = await openThenDelete();
		fake.files.set(PATH, content);
		fake.fire("create", fileOf(PATH));
		await plugin.ready();
		expect(plugin.session).not.toBeNull();
		expect(plugin.session!.path).toBe(PATH);
		expect(notices.plain).toEqual([]);
	});

	it("reopens when another file is renamed into the active path", async () => {
		const { fake, plugin, content } = await openThenDelete();
		fake.files.set("Temp.cpbase", content);
		fake.files.delete("Temp.cpbase");
		fake.files.set(PATH, content);
		fake.fire("rename", fileOf(PATH), "Temp.cpbase");
		await plugin.ready();
		expect(plugin.session).not.toBeNull();
		expect(plugin.session!.path).toBe(PATH);
	});

	it("does not reopen for an unrelated new file, nor when a session is already open", async () => {
		const { fake, plugin, content } = await openThenDelete();
		const open = vi.spyOn(plugin, "openActiveDatabase");
		fake.files.set("Other.cpbase", content);
		fake.fire("create", fileOf("Other.cpbase"));
		await plugin.ready();
		expect(open).not.toHaveBeenCalled();
		expect(plugin.session).toBeNull();

		fake.files.set(PATH, content);
		fake.fire("create", fileOf(PATH));
		await plugin.ready();
		const first = plugin.session;
		expect(first).not.toBeNull();
		fake.fire("create", fileOf(PATH)); // a duplicate event
		await plugin.ready();
		expect(plugin.session).toBe(first);
	});

	it("two create events in a row open the database once", async () => {
		const { fake, plugin, content } = await openThenDelete();
		fake.files.set(PATH, content);
		fake.fire("create", fileOf(PATH));
		fake.fire("create", fileOf(PATH));
		await plugin.ready();
		const session = plugin.session;
		await plugin.ready();
		expect(plugin.session).toBe(session);
		expect(session).not.toBeNull();
	});
});

describe("unloading while a database opens or a switch runs", () => {
	// Unloading the plugin while the database opens closes the opening session; the rest of its open then fails
	// against the closed store. That is expected and shows no error once the plugin is gone.

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

	it("shows no error from the open the unload cut short", async () => {
		const fake = fakeApp();
		// Trash long expired: the open purges it, a write.
		const d = createEmptyDb({ dbId: "db-a", revision: "r-aaaaaaaaaaaa", deviceId: "d-other", now: "2020-01-01T00:00:00.000Z" });
		const old = makeTask("00000001-0000-4000-8000-000000000001", { title: "Old errand" });
		const trash = new Map([["b1", { batchId: "b1", deletedAt: "2020-01-01T00:00:00.000Z", tasks: [old] }]]);
		fake.files.set(A, serializeDb({ ...d, trash }));
		const { default: CheckpointPlugin } = await import("../../src/main");
		const Ctor = CheckpointPlugin as unknown as new (a: unknown, m: unknown) => InstanceType<typeof CheckpointPlugin>;
		const plugin = new Ctor(fake.app, { id: "logwell", dir: "config/plugins/logwell" });
		await plugin.onload();
		plugin.settings.activeDatabasePath = A;
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
		expect(notices.errors).toEqual([]);
	});

	it("#112: a switch still closing the old database at unload opens nothing afterwards", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const sessions = trackSessions();
		// The unload lands while the switch waits for the old database's sync request.
		vi.spyOn(DbSession.prototype, "settleSync").mockImplementation(async () => {
			plugin.onunload();
			await new Promise((r) => setTimeout(r, 10));
		});
		plugin.settings.activeDatabasePath = B;
		await plugin.openActiveDatabase();
		expect(sessions.opened.map((s) => s.path)).toEqual([]);
		expect(plugin.session).toBeNull();
		expect(notices.errors).toEqual([]);
	});

	it("#112: an open queued before the unload does not run after it", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const sessions = trackSessions();
		plugin.settings.activeDatabasePath = B;
		const first = plugin.openActiveDatabase();
		const second = plugin.openActiveDatabase();
		plugin.onunload();
		await first;
		await second;
		expect(sessions.opened.map((s) => s.path)).toEqual([]);
		expect(plugin.session).toBeNull();
	});

	it("#112: a database whose open fails after its file was read is closed", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const sessions = trackSessions();
		vi.spyOn(RecurrenceService.prototype, "endExhaustedSeries").mockRejectedValue(new Error("Could not end the series."));
		await plugin.setActiveDatabase(B);
		expect(plugin.session).toBeNull();
		expect(sessions.opened.map((s) => s.path)).toEqual([B]);
		expect(sessions.closed.has(sessions.opened[0]!)).toBe(true);
		expect(notices.errors).toHaveLength(1);
	});
});
