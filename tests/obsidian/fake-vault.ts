import { TFile, TFolder } from "obsidian";
import { MemoryFileGateway } from "../persistence/memoryGateway";

// A fake Obsidian App for plugin-level tests: an in-memory vault with the
// calls DbSession and CheckpointPlugin use (files and folders), a DataAdapter over the same
// memory gateway as the backups, and per-vault local storage.

export type Handler = (...args: unknown[]) => unknown;

/** A workspace event the plugin registered: its name and handler. */
export interface WorkspaceRef {
	name: string;
	callback: Handler;
}

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
	const folders = new Set<string>();
	const plugin = new MemoryFileGateway();
	const handlers = new Map<string, Handler>();
	const local = new Map<string, unknown>();
	const secrets = new Map<string, string>();
	const workspaceRefs: WorkspaceRef[] = [];
	let layoutReady: (() => void) | null = null;
	const log = { processed: [] as string[] };

	const vault = {
		configDir: "config",
		on: (name: string, fn: Handler) => {
			handlers.set(name, fn);
			return {};
		},
		getFileByPath: (path: string) => (files.has(path) ? fileOf(path) : null),
		getAbstractFileByPath: (path: string) => (files.has(path) ? fileOf(path) : folders.has(path) ? Object.assign(new TFolder(), { path }) : null),
		create: (path: string, data: string) => {
			if (files.has(path) || folders.has(path)) return Promise.reject(new Error("File already exists."));
			files.set(path, data);
			return Promise.resolve(fileOf(path));
		},
		createFolder: (path: string) => {
			if (files.has(path) || folders.has(path)) return Promise.reject(new Error("Folder already exists."));
			folders.add(path);
			return Promise.resolve(Object.assign(new TFolder(), { path }));
		},
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
			on: (name: string, callback: Handler): WorkspaceRef => {
				const ref = { name, callback };
				workspaceRefs.push(ref);
				return ref;
			},
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
		folders,
		local,
		secrets,
		plugin,
		log,
		workspaceRefs,
		fire: (name: string, ...args: unknown[]) => handlers.get(name)?.(...args),
		layoutReady: () => layoutReady?.(),
	};
}

export type FakeApp = ReturnType<typeof fakeApp>;

/** Obsidian's per-vault local storage alone, for a port under test: saving null removes the key. */
export function fakeLocal() {
	const store = new Map<string, unknown>();
	return {
		store,
		app: {
			loadLocalStorage: (k: string) => store.get(k) ?? null,
			saveLocalStorage: (k: string, v: unknown) => void (v === null ? store.delete(k) : store.set(k, v)),
		},
	};
}

/**
 * Loads the plugin over `fake` with `activePath` as its database and waits until it is ready. With `ready: false` it
 * stops after `onload`: the layout never gets ready, so no database is opened.
 */
export async function loadPlugin(fake: FakeApp, activePath: string, { ready = true }: { ready?: boolean } = {}) {
	const { default: CheckpointPlugin } = await import("../../src/main");
	const Ctor = CheckpointPlugin as unknown as new (a: unknown, m: unknown) => InstanceType<typeof CheckpointPlugin>;
	const plugin = new Ctor(fake.app, { id: "logwell", dir: "config/plugins/logwell" });
	await plugin.onload();
	if (!ready) return plugin;
	plugin.settings.activeDatabasePath = activePath;
	fake.layoutReady();
	await plugin.ready();
	return plugin;
}
