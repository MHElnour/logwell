// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { emptyDbText } from "../persistence/fixtures";
import { fakeApp, fileOf, loadPlugin } from "./fake-vault";

// The active database is deleted and then recreated (sync, git);
// the plugin must reopen it instead of staying on "Loading" until a restart.

const notices = vi.hoisted(() => ({ plain: [] as string[] }));

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: unknown) {
			notices.plain.push(String(message));
		}
	},
}));
const actions = vi.hoisted(() => [] as { message: string; labels: string[] }[]);
vi.mock("../../src/obsidian/notices", () => ({
	actionNotice: (message: string, a: { label: string }[]) => {
		actions.push({ message, labels: a.map((x) => x.label) });
		return {};
	},
	showError: () => undefined,
}));

const DB = "Checkpoint.cpbase";

async function openThenDelete() {
	const fake = fakeApp();
	fake.files.set(DB, emptyDbText("db-1"));
	const plugin = await loadPlugin(fake, DB);
	expect(plugin.session).not.toBeNull();
	const content = fake.files.get(DB)!;
	fake.files.delete(DB);
	fake.fire("delete", fileOf(DB));
	await plugin.ready();
	expect(plugin.session).toBeNull();
	notices.plain.length = 0;
	return { fake, plugin, content };
}

describe("active database deleted then recreated (N6)", () => {
	it("reopens when the file is created again", async () => {
		const { fake, plugin, content } = await openThenDelete();
		fake.files.set(DB, content);
		fake.fire("create", fileOf(DB));
		await plugin.ready();
		expect(plugin.session).not.toBeNull();
		expect(plugin.session!.path).toBe(DB);
		expect(notices.plain).toEqual([]);
	});

	it("reopens when another file is renamed into the active path", async () => {
		const { fake, plugin, content } = await openThenDelete();
		fake.files.set("Temp.cpbase", content);
		fake.files.delete("Temp.cpbase");
		fake.files.set(DB, content);
		fake.fire("rename", fileOf(DB), "Temp.cpbase");
		await plugin.ready();
		expect(plugin.session).not.toBeNull();
		expect(plugin.session!.path).toBe(DB);
	});

	it("does not reopen for an unrelated new file, nor when a session is already open", async () => {
		const { fake, plugin, content } = await openThenDelete();
		const open = vi.spyOn(plugin, "openActiveDatabase");
		fake.files.set("Other.cpbase", content);
		fake.fire("create", fileOf("Other.cpbase"));
		await plugin.ready();
		expect(open).not.toHaveBeenCalled();
		expect(plugin.session).toBeNull();

		fake.files.set(DB, content);
		fake.fire("create", fileOf(DB));
		await plugin.ready();
		const first = plugin.session;
		expect(first).not.toBeNull();
		fake.fire("create", fileOf(DB)); // a duplicate event
		await plugin.ready();
		expect(plugin.session).toBe(first);
	});

	it("two create events in a row open the database once", async () => {
		const { fake, plugin, content } = await openThenDelete();
		fake.files.set(DB, content);
		fake.fire("create", fileOf(DB));
		fake.fire("create", fileOf(DB));
		await plugin.ready();
		const session = plugin.session;
		await plugin.ready();
		expect(plugin.session).toBe(session);
		expect(session).not.toBeNull();
	});

	it("edits pending when the file was deleted are announced once as a conflict copy", async () => {
		const fake = fakeApp();
		fake.files.set(DB, emptyDbText("db-1"));
		const plugin = await loadPlugin(fake, DB);
		await plugin.session!.app.tasks.create({ title: "unsaved" });
		fake.files.delete(DB);
		actions.length = 0;
		fake.fire("delete", fileOf(DB));
		await plugin.ready();
		expect(actions).toHaveLength(1);
		expect(actions[0]!.labels).toEqual(["Open conflict view"]);
		expect([...fake.plugin.files.keys()].filter((p) => p.includes("/conflicts/"))).toHaveLength(1);
	});
});
