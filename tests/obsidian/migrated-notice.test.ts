// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadText } from "../../src/persistence/CpbaseStore";
import { fakeApp, fileOf, loadPlugin } from "./fake-vault";

// Opening an older database shows "The database was upgraded from schema X to Y"
// exactly once per migration.

const notices = vi.hoisted(() => ({ messages: [] as string[] }));

vi.mock("../../src/obsidian/notices", () => ({
	actionNotice: (message: string) => {
		notices.messages.push(message);
		return {};
	},
	showError: () => undefined,
}));

const V1 = readFileSync(join(import.meta.dirname, "..", "fixtures", "schema-v1.cpbase"), "utf8");
const PATH = "Checkpoint.cpbase";
const upgrades = () => notices.messages.filter((m) => m.includes("was upgraded from schema"));

beforeEach(() => {
	notices.messages.length = 0;
});

describe("migration notice", () => {
	it("opening a v1 database shows the upgrade notice once", async () => {
		const fake = fakeApp();
		fake.files.set(PATH, V1);
		await loadPlugin(fake, PATH);
		expect(upgrades()).toHaveLength(1);
		expect(upgrades()[0]).toContain("from schema 1 to 6");
	});

	it("the modify event for the migration's own save does not announce it again", async () => {
		const fake = fakeApp();
		fake.files.set(PATH, V1);
		const plugin = await loadPlugin(fake, PATH);
		await plugin.session!.store.flush();
		fake.fire("modify", fileOf(PATH));
		await plugin.ready();
		await new Promise((r) => setTimeout(r, 0));
		expect(upgrades()).toHaveLength(1);
	});

	it("re-selecting the already active v1 database announces its migration once per migration", async () => {
		const fake = fakeApp();
		fake.files.set(PATH, V1);
		const plugin = await loadPlugin(fake, PATH);
		await plugin.setActiveDatabase(PATH);
		// The first open rewrote the file at the current schema, so the second open has nothing to migrate.
		expect(upgrades()).toHaveLength(1);
	});

	it("two opens queued at start-up (layout ready plus a settings change) announce once", async () => {
		const fake = fakeApp();
		fake.files.set(PATH, V1);
		const plugin = await loadPlugin(fake, PATH);
		await Promise.all([plugin.openActiveDatabase(), plugin.onSettingChanged("activeDatabasePath")]);
		expect(upgrades()).toHaveLength(1);
	});

	// The e2e vault (test-vault, plugin data.json names its Checkpoint.cpbase as active) migrated
	// on every start-up, and e2e/helpers freshDatabase re-seeds the same file: two real v1
	// opens, two identical notices on screen. The seeds are current-schema now.
	it.each([
		["e2e/fixtures/seed.cpbase", join(import.meta.dirname, "..", "..", "e2e", "fixtures", "seed.cpbase")],
		["test-vault/Checkpoint.cpbase", join(import.meta.dirname, "..", "..", "test-vault", "Checkpoint.cpbase")],
	])("the e2e seed %s needs no migration", (_name, path) => {
		const r = loadText(readFileSync(path, "utf8"), "2026-10-01T10:00:00.000Z");
		expect(r.kind).toBe("ok");
		if (r.kind === "ok") expect(r.migratedFrom).toBeNull();
		// Both seeds carry the current schema (6), so the e2e vault never migrates.
		if (r.kind === "ok") expect(r.data.meta.schemaVersion).toBe(6);
	});

	it("opening a current-schema database shows no upgrade notice", async () => {
		const fake = fakeApp();
		fake.files.set(PATH, readFileSync(join(import.meta.dirname, "..", "fixtures", "schema-v6.cpbase"), "utf8"));
		await loadPlugin(fake, PATH);
		expect(upgrades()).toHaveLength(0);
	});

	it("opening a v3 database (D1) shows the upgrade notice once", async () => {
		const fake = fakeApp();
		fake.files.set(PATH, readFileSync(join(import.meta.dirname, "..", "fixtures", "schema-v3.cpbase"), "utf8"));
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
		fake.files.set(PATH, readFileSync(join(import.meta.dirname, "..", "fixtures", "schema-v2.cpbase"), "utf8"));
		const plugin = await loadPlugin(fake, PATH);
		await plugin.setActiveDatabase(PATH);
		expect(upgrades()).toHaveLength(1);
		expect(upgrades()[0]).toContain("from schema 2 to 6");
	});
});
