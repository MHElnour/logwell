// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportFileName, exportFolderName } from "../../src/app/DataService";
import { ViewHost } from "../../src/obsidian/host";
import { emptyDbText } from "../persistence/fixtures";
import { type FakeApp, fakeApp, loadPlugin } from "./fake-vault";

// Where the exports and "Create database" put their files in the vault: the vault root or a folder the user picked,
// the "(n)" suffix when the name is taken, and every path going through normalizePath.

const picked = vi.hoisted(() => ({ folder: "/", name: "New" }));

vi.mock("../../src/obsidian/modals", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	pickFolder: () => Promise.resolve({ path: picked.folder }),
	prompt: () => Promise.resolve({ name: picked.name }),
}));

vi.mock("../../src/obsidian/notices", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	syncNotice: () => ({}),
}));

// The stub's normalizePath keeps its input; Obsidian turns backslashes and repeated slashes into single slashes.
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	normalizePath: (path: string) => path.replace(/[\\/]+/g, "/").replace(/^\/|\/$/g, ""),
}));

const A = "A.cpbase";
const NOW = new Date("2026-10-01T10:00:00.000Z");

async function setup(): Promise<{ fake: FakeApp; plugin: Awaited<ReturnType<typeof loadPlugin>>; host: ViewHost; backupName: string; csvFolder: string }> {
	const fake = fakeApp();
	fake.files.set(A, emptyDbText("db-a", "r-aaaaaaaaaaaa"));
	const plugin = await loadPlugin(fake, A);
	const session = plugin.session!;
	vi.spyOn(session.app.clock, "now").mockReturnValue(NOW);
	const backupName = exportFileName(NOW).replace(/\.json$/, "");
	const csvFolder = exportFolderName(NOW, session.app.settings.zone());
	return { fake, plugin, host: new ViewHost(plugin, session, null), backupName, csvFolder };
}

beforeEach(() => {
	picked.folder = "/";
	picked.name = "New";
});
afterEach(() => vi.restoreAllMocks());

describe("Export backup", () => {
	it.each([
		{ name: "the vault root", folder: "/", dir: "", taken: [] as number[], n: 1 },
		{ name: "a folder", folder: "Archive", dir: "Archive/", taken: [] as number[], n: 1 },
		{ name: "a nested folder with backslashes and doubled slashes", folder: "Archive\\\\Old//2026", dir: "Archive/Old/2026/", taken: [] as number[], n: 1 },
		{ name: "a name that is taken", folder: "Archive", dir: "Archive/", taken: [1], n: 2 },
		{ name: "names 1 and 2 taken", folder: "/", dir: "", taken: [1, 2], n: 3 },
	])("writes into $name", async ({ folder, dir, taken, n }) => {
		const { fake, host, backupName } = await setup();
		picked.folder = folder;
		const nameOf = (k: number) => `${dir}${backupName}${k === 1 ? "" : ` (${k})`}.json`;
		for (const k of taken) fake.files.set(nameOf(k), "kept");
		await host.exportBackup();
		expect(fake.files.get(nameOf(n))).toContain('"dbId"');
		for (const k of taken) expect(fake.files.get(nameOf(k))).toBe("kept");
	});
});

describe("Export CSV", () => {
	it.each([
		{ name: "a free folder name", taken: [] as number[], suffix: "" },
		{ name: "a taken folder name", taken: [1], suffix: " (2)" },
		{ name: "folder names 1 and 2 taken", taken: [1, 2], suffix: " (3)" },
	])("creates the export folder for $name", async ({ taken, suffix }) => {
		const { fake, host, csvFolder } = await setup();
		for (const n of taken) fake.folders.add(n === 1 ? csvFolder : `${csvFolder} (${n})`);
		await host.exportCsv();
		const folder = `${csvFolder}${suffix}`;
		expect(fake.folders.has(folder)).toBe(true);
		expect(fake.files.has(`${folder}/tasks.csv`)).toBe(true);
	});
});

describe("Create database", () => {
	it.each([
		{ name: "the vault root", folder: "/", typed: "Work", expected: "Work.cpbase" },
		{ name: "a folder", folder: "Databases", typed: "Work", expected: "Databases/Work.cpbase" },
		{ name: "a folder with backslashes and doubled slashes", folder: "Databases\\\\2026//", typed: "Work", expected: "Databases/2026/Work.cpbase" },
		{ name: "a name with spaces around it and the extension typed", folder: "Databases", typed: "  Work.CPBASE ", expected: "Databases/Work.cpbase" },
	])("puts the new file in $name", async ({ folder, typed, expected }) => {
		const { fake, plugin } = await setup();
		picked.folder = folder;
		picked.name = typed;
		await plugin.createDatabase();
		expect(fake.files.has(expected)).toBe(true);
	});

	it("does not overwrite a file that already has the name", async () => {
		const { fake, plugin } = await setup();
		fake.files.set("Databases/Work.cpbase", "mine");
		picked.folder = "Databases";
		picked.name = "Work";
		await plugin.createDatabase();
		expect(fake.files.get("Databases/Work.cpbase")).toBe("mine");
	});
});
