// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { descendant, emptyDbText } from "../persistence/fixtures";
import { type FakeApp, fakeApp, fileOf, loadPlugin } from "./fake-vault";
import { CURRENT_SCHEMA_VERSION } from "../../src/persistence/schema";

// Session and database lifecycle checks at the plugin level.

interface Recorded {
	message: string;
	labels: string[];
	timeout: number | undefined;
}
const notices = vi.hoisted(() => ({ list: [] as Recorded[], errors: [] as unknown[], contexts: [] as (string | undefined)[] }));

vi.mock("../../src/obsidian/notices", () => ({
	actionNotice: (message: string, actions: { label: string }[], timeout?: number) => {
		notices.list.push({ message, labels: actions.map((a) => a.label), timeout });
		return {};
	},
	showError: (err: unknown, context?: string) => {
		notices.errors.push(err);
		notices.contexts.push(context);
	},
	syncNotice: () => ({}),
}));

// Create database asks for a folder and a name: the vault root and "New".
vi.mock("../../src/obsidian/modals", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	pickFolder: () => Promise.resolve({ isRoot: () => true, path: "/" }),
	prompt: () => Promise.resolve({ name: "New" }),
}));

const A = "A.cpbase";
const B = "B.cpbase";

function setup(): FakeApp {
	const fake = fakeApp();
	fake.files.set(A, emptyDbText("db-a", "r-aaaaaaaaaaaa"));
	fake.files.set(B, emptyDbText("db-b", "r-bbbbbbbbbbbb"));
	notices.list.length = 0;
	notices.errors.length = 0;
	notices.contexts.length = 0;
	return fake;
}

afterEach(() => vi.restoreAllMocks());

type Emitter = { onStoreEvent(e: unknown): void };

describe("edits that could not be kept", () => {
	it("a persistent notice names the database and the reason, and never says Retrying", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		(plugin.session as unknown as Emitter).onStoreEvent({ type: "edits-lost", message: "disk full" });
		expect(notices.list).toHaveLength(1);
		const n = notices.list[0]!;
		expect(n.timeout).toBe(0);
		expect(n.message).toContain(A);
		expect(n.message).toContain("disk full");
		expect(n.message).toMatch(/unsaved/i);
		expect(n.message).toMatch(/could not be kept/i);
		expect(n.message).not.toMatch(/retry/i);
	});

	it("closing a database whose file and conflict copy cannot be written ends with that notice, not a retry promise", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		await plugin.session!.app.tasks.create({ title: "pending" });
		const origProcess = fake.app.vault.process;
		fake.app.vault.process = (f, fn) => (f.path === A ? Promise.reject(new Error("EACCES")) : origProcess(f, fn));
		fake.plugin.failNextWrite((p) => p.includes("/conflicts/"));

		await plugin.setActiveDatabase(B);

		expect(plugin.session?.path).toBe(B);
		const lost = notices.list.filter((n) => n.timeout === 0 && /could not be kept/i.test(n.message));
		expect(lost).toHaveLength(1);
		expect(lost[0]!.message).toContain(A);
		expect(notices.list.some((n) => /retrying/i.test(n.message))).toBe(false);
	});

	it("the generic save error says Retrying while the session is open", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		(plugin.session as unknown as Emitter).onStoreEvent({ type: "save-error", message: "EACCES" });
		expect(notices.list).toHaveLength(1);
		expect(notices.list[0]!.message).toBe("Could not save the database: EACCES Retrying.");
		expect(notices.list[0]!.timeout).toBeUndefined();
	});

	it("the generic save error never says Retrying once the session is closing", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const session = plugin.session!;
		vi.spyOn(session.store, "close").mockImplementation(() => {
			(session as unknown as Emitter).onStoreEvent({ type: "save-error", message: "EACCES" });
			return Promise.resolve();
		});
		await session.close();
		expect(notices.list).toHaveLength(1);
		expect(notices.list[0]!.message).toContain("EACCES");
		expect(notices.list[0]!.message).not.toMatch(/retry/i);
	});
});

describe("#134: failures that used to show nothing", () => {
	it("#134: a backup that cannot be written says the database file is not affected, never Retrying", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		(plugin.session as unknown as Emitter).onStoreEvent({ type: "backup-error", message: "ENOSPC" });
		expect(notices.list).toHaveLength(1);
		const message = notices.list[0]!.message;
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

describe("a failing rename flush never skips closing the store", () => {
	it("a rename queue that throws on save: the store still closes, and the user is told", async () => {
		const fake = setup();
		// The database is newer than this plugin: it is read-only, so renames wait.
		fake.files.set(A, emptyDbText("db-a", "r-aaaaaaaaaaaa").replace(`"schemaVersion":${CURRENT_SCHEMA_VERSION}`, '"schemaVersion":7'));
		const plugin = await loadPlugin(fake, A);
		const session = plugin.session!;
		await session.app.noteRenames.rewriteNotePaths("X.md", "Y.md", false); // saved at once; the cooldown starts
		void session.app.noteRenames.rewriteNotePaths("Y.md", "Z.md", false); // held back by the cooldown
		await new Promise((r) => setTimeout(r, 0));
		fake.app.saveLocalStorage = (k: string) => {
			if (k.startsWith("checkpoint-pending-renames")) throw new Error("quota exceeded");
		};
		const close = vi.spyOn(session.store, "close");

		await expect(session.close()).resolves.toBeUndefined();

		expect(close).toHaveBeenCalledTimes(1);
		expect(notices.list.some((n) => n.message.includes("quota exceeded") && /rename/i.test(n.message))).toBe(true);
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
		expect(notices.list.some((n) => n.message.includes("boom"))).toBe(true);
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

describe("'Open conflict view' when the database file is missing", () => {
	it("the plugin's current session still opens the Data view", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const session = plugin.session!;
		fake.files.delete(A); // momentarily missing, for example while a sync tool rewrites it
		const openApp = vi.spyOn(plugin, "openApp").mockResolvedValue(null);
		const setActive = vi.spyOn(plugin, "setActiveDatabase");

		await session.openConflictView();

		expect(openApp).toHaveBeenCalledWith("data");
		expect(setActive).not.toHaveBeenCalled();
		expect(notices.list).toEqual([]);
	});

	it("a closed session names where its conflict copies are kept and opens nothing", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const old = plugin.session!;
		await plugin.setActiveDatabase(B);
		expect(plugin.session).not.toBe(old);
		fake.files.delete(A);
		const openApp = vi.spyOn(plugin, "openApp").mockResolvedValue(null);
		const setActive = vi.spyOn(plugin, "setActiveDatabase");

		await old.openConflictView();

		expect(openApp).not.toHaveBeenCalled();
		expect(setActive).not.toHaveBeenCalled();
		expect(notices.list).toHaveLength(1);
		expect(notices.list[0]!.message).toContain("backups/db-a/conflicts");
	});
});

describe("a change listener that throws", () => {
	it("#118: the write still succeeds, the other listeners run, the error is shown, and an outside change still offers Keep mine", async () => {
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
		expect(notices.list.some((n) => n.labels.includes("Keep mine") && n.labels.includes("Keep theirs"))).toBe(true);
		expect(seen).toHaveLength(2);
	});
});
