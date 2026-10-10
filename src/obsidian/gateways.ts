import { type App, type DataAdapter, TFile, normalizePath } from "obsidian";
import type { NotePort } from "../app/ports";
import { basenameOf, joinPath, noteNameCandidate } from "../domain/notes";
import type { StoreLocalState } from "../persistence/CpbaseStore";
import type { DbFile, FileGateway, WriteResult } from "../persistence/gateway";

// Obsidian implementations of the persistence and note ports.

/**
 * The database file: read fresh from disk, written with vault.process.
 * `path` must stay fixed for the session's life (DbSession pins it), never the
 * live "active database" setting.
 */
export class VaultDbFile implements DbFile {
	constructor(
		private readonly app: App,
		private readonly path: () => string,
	) {}

	private file(): TFile | null {
		return this.app.vault.getFileByPath(this.path());
	}

	async read(): Promise<string | null> {
		const file = this.file();
		return file === null ? null : this.app.vault.read(file);
	}

	async write(content: string, expected: (current: string) => boolean): Promise<WriteResult> {
		const file = this.file();
		// Never recreate a database file the user deleted or moved away.
		if (file === null) return { written: false, current: null };
		try {
			// Compare-and-swap: the check runs on the text vault.process
			// read, so a write that landed before its modify event is never
			// overwritten. Throwing from the callback aborts before anything is written.
			await this.app.vault.process(file, (data) => {
				if (!expected(data)) throw new WriteAborted(data);
				return content;
			});
		} catch (err) {
			if (err instanceof WriteAborted) return { written: false, current: err.current };
			throw err;
		}
		return { written: true };
	}
}

class NoteChanged extends Error {
	constructor() {
		super("The note changed before the sync could write it.");
		this.name = "NoteChanged";
	}
}

class WriteAborted extends Error {
	constructor(readonly current: string) {
		super("The database file changed before it could be saved.");
		this.name = "WriteAborted";
	}
}

/** Plugin-folder files (backups, journal, conflict copies) through the DataAdapter. */
export class AdapterGateway implements FileGateway {
	constructor(private readonly adapter: DataAdapter) {}

	async read(path: string): Promise<string | null> {
		return (await this.adapter.exists(path)) ? this.adapter.read(path) : null;
	}

	async write(path: string, data: string): Promise<void> {
		await this.adapter.write(path, data);
	}

	async append(path: string, data: string): Promise<void> {
		if (await this.adapter.exists(path)) await this.adapter.append(path, data);
		else await this.adapter.write(path, data);
	}

	async exists(path: string): Promise<boolean> {
		return this.adapter.exists(path);
	}

	async list(dir: string): Promise<string[]> {
		if (!(await this.adapter.exists(dir))) return [];
		return (await this.adapter.list(dir)).files;
	}

	async remove(path: string): Promise<void> {
		if (await this.adapter.exists(path)) await this.adapter.remove(path);
	}

	async mkdir(path: string): Promise<void> {
		if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
	}
}

const LS_PREFIX = "checkpoint";

/**
 * Device-local state with App.saveLocalStorage (vault-scoped, never synced).
 * `dbPath` is the session's pinned path.
 */
export class LocalStorageState implements StoreLocalState {
	constructor(
		private readonly app: App,
		private readonly dbPath: () => string,
	) {}

	getLastWritten(dbId: string): string | null {
		const v: unknown = this.app.loadLocalStorage(`${LS_PREFIX}-last-written-${dbId}`);
		return typeof v === "string" ? v : null;
	}

	setLastWritten(dbId: string, revision: string): void {
		this.app.saveLocalStorage(`${LS_PREFIX}-last-written-${dbId}`, revision);
	}

	getKnownDbId(): string | null {
		const v: unknown = this.app.loadLocalStorage(`${LS_PREFIX}-db-id-${this.dbPath()}`);
		return typeof v === "string" ? v : null;
	}

	setKnownDbId(dbId: string): void {
		this.app.saveLocalStorage(`${LS_PREFIX}-db-id-${this.dbPath()}`, dbId);
	}
}

export function deviceId(app: App): string {
	const key = `${LS_PREFIX}-device-id`;
	const existing: unknown = app.loadLocalStorage(key);
	if (typeof existing === "string" && existing.length > 0) return existing;
	const id = `d-${crypto.randomUUID().slice(0, 13)}`;
	app.saveLocalStorage(key, id);
	return id;
}

/**
 * Description notes in the vault. Never deletes or renames a note; modifies one only through `replaceText`,
 * which only the TickTick sync calls, for the notes it created.
 */
export class VaultNotes implements NotePort {
	constructor(private readonly app: App) {}

	exists(path: string): boolean {
		return this.app.vault.getFileByPath(path) !== null;
	}

	modifiedAt(path: string): number | null {
		return this.app.vault.getFileByPath(path)?.stat.mtime ?? null;
	}

	async replaceText(path: string, expected: string, next: string): Promise<boolean> {
		const file = this.app.vault.getFileByPath(path);
		if (file === null) return false;
		try {
			// Compare-and-swap on the text vault.process read: throwing from the callback aborts before anything is
			// written, so an edit that landed after the sync read the note is never overwritten.
			await this.app.vault.process(file, (data) => {
				if (data !== expected) throw new NoteChanged();
				return next;
			});
		} catch (err) {
			if (err instanceof NoteChanged) return false;
			throw err;
		}
		return true;
	}

	async createNote(folder: string, baseName: string, content = ""): Promise<string> {
		const dir = normalizePath(folder.trim() === "" ? "/" : folder);
		const folderPath = dir === "/" ? "" : dir;
		if (folderPath !== "" && this.app.vault.getFolderByPath(folderPath) === null) {
			// The folder is created on first use.
			await this.app.vault.createFolder(folderPath);
		}
		for (let attempt = 1; attempt < 1000; attempt++) {
			const path = normalizePath(joinPath(folderPath, noteNameCandidate(baseName, attempt)));
			// Probe; an existing file is never overwritten.
			if (this.app.vault.getAbstractFileByPath(path) === null) {
				const file = await this.app.vault.create(path, content);
				return file.path;
			}
		}
		throw new Error("Could not find a free note name.");
	}

	async read(path: string): Promise<string | null> {
		const file = this.app.vault.getFileByPath(path);
		return file === null ? null : this.app.vault.cachedRead(file);
	}

	findByBasename(basename: string): string[] {
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => basenameOf(f.path) === basename)
			.map((f) => f.path);
	}
}
