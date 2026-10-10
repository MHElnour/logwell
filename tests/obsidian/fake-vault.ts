import { TFile } from "obsidian";
import { MemoryFileGateway } from "../persistence/memoryGateway";

// A fake Obsidian App for plugin-level tests: an in-memory vault with the
// calls DbSession and CheckpointPlugin use, a DataAdapter over the same
// memory gateway as the backups, and per-vault local storage.

export type Handler = (...args: unknown[]) => unknown;

export function fileOf(path: string): TFile {
	const name = path.split("/").pop() ?? path;
	const dot = name.lastIndexOf(".");
	return Object.assign(new TFile(), {
		path,
		name,
		extension: dot < 0 ? "" : name.slice(dot + 1),
		basename: dot < 0 ? name : name.slice(0, dot),
	});
}

export function fakeApp() {
	const files = new Map<string, string>();
	const plugin = new MemoryFileGateway();
	const handlers = new Map<string, Handler>();
	const local = new Map<string, unknown>();
	const secrets = new Map<string, string>();
	let layoutReady: (() => void) | null = null;
	const log = { processed: [] as string[] };

	const vault = {
		configDir: "config",
		on: (name: string, fn: Handler) => {
			handlers.set(name, fn);
			return {};
		},
		getFileByPath: (path: string) => (files.has(path) ? fileOf(path) : null),
		getAbstractFileByPath: (path: string) => (files.has(path) ? fileOf(path) : null),
		read: (file: TFile) => Promise.resolve(files.get(file.path) ?? ""),
		cachedRead: (file: TFile) => Promise.resolve(files.get(file.path) ?? ""),
		process: (file: TFile, fn: (data: string) => string) => {
			const current = files.get(file.path);
			if (current === undefined) return Promise.reject(new Error("missing file"));
			const next = fn(current); // a throw here aborts the write, like Obsidian
			files.set(file.path, next);
			log.processed.push(file.path);
			return Promise.resolve(next);
		},
		adapter: {
			exists: (p: string) => plugin.exists(p),
			read: (p: string) => plugin.read(p).then((v) => v ?? ""),
			write: (p: string, d: string) => plugin.write(p, d),
			append: (p: string, d: string) => plugin.append(p, d),
			list: (p: string) => plugin.list(p).then((f) => ({ files: f, folders: [] as string[] })),
			remove: (p: string) => plugin.remove(p),
			mkdir: (p: string) => plugin.mkdir(p),
		},
	};
	const app = {
		workspace: {
			onLayoutReady: (fn: () => void) => {
				layoutReady = fn;
			},
			on: () => ({}),
			getLeavesOfType: () => [],
		},
		vault,
		loadLocalStorage: (k: string) => local.get(k) ?? null,
		saveLocalStorage: (k: string, v: unknown) => void local.set(k, v),
		secretStorage: {
			getSecret: (id: string) => secrets.get(id) ?? null,
			setSecret: (id: string, secret: string) => void secrets.set(id, secret),
			listSecrets: () => [...secrets.keys()],
		},
	};
	return {
		app,
		files,
		local,
		secrets,
		plugin,
		log,
		fire: (name: string, ...args: unknown[]) => handlers.get(name)?.(...args),
		layoutReady: () => layoutReady?.(),
	};
}

export type FakeApp = ReturnType<typeof fakeApp>;

export async function loadPlugin(fake: FakeApp, activePath: string) {
	const { default: CheckpointPlugin } = await import("../../src/main");
	const Ctor = CheckpointPlugin as unknown as new (a: unknown, m: unknown) => InstanceType<typeof CheckpointPlugin>;
	const plugin = new Ctor(fake.app, { id: "logwell", dir: "config/plugins/logwell" });
	await plugin.onload();
	plugin.settings.activeDatabasePath = activePath;
	fake.layoutReady();
	await plugin.ready();
	return plugin;
}
