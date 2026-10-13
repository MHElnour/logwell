import { CheckpointApp } from "../../src/app/App";
import type { NotePort, RenameQueuePort } from "../../src/app/ports";
import { basenameOf, joinPath, noteNameCandidate } from "../../src/domain/notes";
import { readHeader } from "../../src/persistence/serializer";
import type { DbFile } from "../../src/persistence/gateway";
import { DB_PATH, harness as storeHarness, type Harness } from "../persistence/fixtures";
import { sequentialIds } from "../helpers";

/** A fake vault: Markdown files by path. Records every call that writes, and every read. */
export class FakeNotes implements NotePort {
	readonly files = new Map<string, string>();
	readonly writes: string[] = [];
	readonly reads: string[] = [];
	private readonly mtimes = new Map<string, number>();
	private tick = 0;
	/** Called inside `replaceText` before the compare: lets a test edit the note at the last moment. */
	beforeReplace: ((path: string) => void) | null = null;

	exists(path: string): boolean {
		return this.files.has(path);
	}

	/** Sets a note's text as an edit in Obsidian would (a new modification time). */
	set(path: string, text: string): void {
		this.files.set(path, text);
		this.mtimes.set(path, ++this.tick);
	}

	/** A note deleted in Obsidian. */
	delete(path: string): void {
		this.files.delete(path);
		this.mtimes.delete(path);
	}

	/** A note renamed in Obsidian (the plugin's rename handler is the caller's job). */
	rename(from: string, to: string): void {
		const text = this.files.get(from)!;
		this.delete(from);
		this.set(to, text);
	}

	async createNote(folder: string, baseName: string, content = ""): Promise<string> {
		for (let attempt = 1; ; attempt++) {
			const path = joinPath(folder, noteNameCandidate(baseName, attempt));
			if (!this.files.has(path)) {
				this.set(path, content);
				this.writes.push(path);
				return path;
			}
		}
	}

	modifiedAt(path: string): number | null {
		return this.mtimes.get(path) ?? null;
	}

	async replaceText(path: string, expected: string, next: string): Promise<boolean> {
		this.beforeReplace?.(path);
		const current = this.files.get(path);
		if (current === undefined || current !== expected) return false;
		this.set(path, next);
		this.writes.push(path);
		return true;
	}

	async read(path: string): Promise<string | null> {
		this.reads.push(path);
		return this.files.get(path) ?? null;
	}

	findByBasename(basename: string): string[] {
		return [...this.files.keys()].filter((p) => basenameOf(p) === basename);
	}
}

export interface AppHarness extends Harness {
	app: CheckpointApp;
	notes: FakeNotes;
}

/** Damages the database file on disk, so the store turns read-only. */
export async function makeReadOnly(h: Harness): Promise<void> {
	h.fs.files.set(DB_PATH, `<<<<<<< HEAD\n${h.dbText()}`);
	await h.store.handleExternalChange();
	if (h.store.readOnlyState === null) throw new Error("expected the store to be read-only");
}

/** Waits until a condition holds, without depending on an exact number of ticks. */
export async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, 0));
	}
}

/**
 * Makes a read-only store writable again: the file is repaired outside Obsidian
 * (`saved` under a new revision) and DbSession's "writable" handling runs.
 */
export async function makeWritable(h: AppHarness, saved: string, revision = "r-repaired0001"): Promise<void> {
	const header = readHeader(saved);
	if (header === null) throw new Error("no header");
	h.fs.files.set(DB_PATH, saved.replace(`"revision":"${header.revision}"`, `"revision":"${revision}"`));
	await h.store.handleExternalChange();
	if (h.app.store.readOnlyState !== null) throw new Error("expected the store to be writable");
	h.app.store.notifyStatus();
}

// Each app gets its own copy, so a test that overrides one setting (weekStart) never changes another test's app.
const SETTINGS = { zone: () => "Europe/Berlin", noteFolder: () => "Task notes", upcomingDays: () => 14, weekStart: () => "MO" as const, eveningTime: () => "20:00" };

export interface AppHarnessOptions {
	/** Initial database text (default: an empty database). */
	initial?: string;
	renames?: RenameQueuePort;
	/** Wraps the database file, for example to make writes fail. */
	wrapFile?: (file: DbFile) => DbFile;
}

export async function appHarness(options: AppHarnessOptions = {}): Promise<AppHarness> {
	const h = storeHarness(options.initial, undefined, options.wrapFile);
	await h.store.open();
	const notes = new FakeNotes();
	const app = new CheckpointApp(h.store, h.clock, sequentialIds("a"), { ...SETTINGS }, notes, options.renames);
	return { ...h, app, notes };
}

/**
 * A new session on the same vault and database file, as after a reload:
 * closes the old store, opens a new one and resumes queued renames.
 */
export async function reopen(h: AppHarness, renames: RenameQueuePort): Promise<AppHarness> {
	await h.store.close();
	h.app.store.bus.clear();
	const store = h.newStore();
	await store.open();
	const app = new CheckpointApp(store, h.clock, sequentialIds("b"), h.app.settings, h.notes, renames);
	await app.noteRenames.resumeRenames();
	return { ...h, store, app };
}
