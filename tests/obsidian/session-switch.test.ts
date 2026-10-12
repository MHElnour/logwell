// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { SAVE_DEBOUNCE_MS } from "../../src/persistence/CpbaseStore";
import { descendant, emptyDbText, load, makeTask, withTask } from "../persistence/fixtures";
import { type FakeApp, fakeApp, fileOf, loadPlugin } from "./fake-vault";

// A database session keeps writing to the file it opened, even after
// settings.activeDatabasePath names another database.

interface Recorded {
	message: string;
	labels: string[];
	run: () => unknown;
}
const notices = vi.hoisted(() => ({ actions: [] as Recorded[], errors: [] as unknown[] }));

vi.mock("../../src/obsidian/notices", () => ({
	actionNotice: (message: string, actions: { label: string; run: () => unknown }[]) => {
		notices.actions.push({ message, labels: actions.map((a) => a.label), run: () => actions[0]?.run() });
		return {};
	},
	showError: (err: unknown) => void notices.errors.push(err),
}));

const A = "A.cpbase";
const B = "B.cpbase";

function setup(): FakeApp {
	const fake = fakeApp();
	fake.files.set(A, emptyDbText("db-a", "r-aaaaaaaaaaaa"));
	fake.files.set(B, emptyDbText("db-b", "r-bbbbbbbbbbbb"));
	notices.actions.length = 0;
	notices.errors.length = 0;
	return fake;
}

const titles = (text: string | undefined) => [...load(text ?? "").tasks.values()].map((t) => t.title);

describe("pinning the database path per session (N7)", () => {
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
		const conflicts = [...fake.plugin.files.keys()].filter((p) => p.includes("/conflicts/"));
		expect(conflicts).toEqual([]);
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
});

describe("closing a session", () => {
	it("flushes held-back renames before the store closes", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const session = plugin.session!;
		const order: string[] = [];
		vi.spyOn(session.app.tasks, "flushRenames").mockImplementation(() => void order.push("flushRenames"));
		const close = session.store.close.bind(session.store);
		vi.spyOn(session.store, "close").mockImplementation(() => {
			order.push("store.close");
			return close();
		});
		await plugin.setActiveDatabase(B);
		expect(order).toEqual(["flushRenames", "store.close"]);
	});
});

describe("a conflict copy written while a session closes is announced", () => {
	it("one notice offers 'Open conflict view', never Keep mine / Keep theirs", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		await plugin.session!.app.tasks.create({ title: "mine" });
		// Another device's save lands before our pending save does.
		fake.files.set(A, descendant(fake.files.get(A)!, (d) => withTask(d, makeTask("remote")).next, "r-remote000001"));

		await plugin.setActiveDatabase(B); // closing A saves, finds the fork, keeps "mine" as a conflict copy

		const conflicts = [...fake.plugin.files.keys()].filter((p) => p.includes("/conflicts/"));
		expect(conflicts).toHaveLength(1);
		expect(notices.actions).toHaveLength(1);
		expect(notices.actions[0]!.labels).toEqual(["Open conflict view"]);
		expect(notices.actions[0]!.message).toContain(A);
		expect(notices.errors).toEqual([]);
	});

	it("the action makes the closed database active again, then opens the conflict view", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		await plugin.session!.app.tasks.create({ title: "mine" });
		fake.files.set(A, descendant(fake.files.get(A)!, (d) => withTask(d, makeTask("remote")).next, "r-remote000001"));
		await plugin.setActiveDatabase(B);
		const openApp = vi.spyOn(plugin, "openApp").mockResolvedValue(null);
		await notices.actions[0]!.run();
		expect(plugin.settings.activeDatabasePath).toBe(A);
		expect(plugin.session!.path).toBe(A);
		expect(openApp).toHaveBeenCalledWith("data");
	});

	it("the store's pending-saved-as-conflict event is announced once, even if a conflict event names the same copy", async () => {
		const fake = setup();
		const plugin = await loadPlugin(fake, A);
		const session = plugin.session!;
		const emit = (e: unknown) => (session as unknown as { onStoreEvent(e: unknown): void }).onStoreEvent(e);
		emit({ type: "pending-saved-as-conflict", path: "plugin/backups/db-a/conflicts/x.cpbase" });
		emit({ type: "pending-saved-as-conflict", path: "plugin/backups/db-a/conflicts/x.cpbase" });
		expect(notices.actions).toHaveLength(1);
		expect(notices.actions[0]!.labels).toEqual(["Open conflict view"]);
		expect(notices.actions[0]!.message).toContain(A);
	});
});
