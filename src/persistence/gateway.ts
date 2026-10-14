// FileGateway port (architecture.md, Overview). The Obsidian adapter implements it with
// vault.process for the database file and the DataAdapter for the plugin
// folder; tests use MemoryFileGateway (tests/persistence/memoryGateway.ts) with fault injection.

export interface FileGateway {
	read(path: string): Promise<string | null>;
	/** Creates or replaces the file. */
	write(path: string, data: string): Promise<void>;
	append(path: string, data: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	/** Full paths of the files directly inside `dir`. Missing folder → []. */
	list(dir: string): Promise<string[]>;
	remove(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
}

/**
 * Outcome of a compare-and-swap write. `current` is the text found instead of
 * the expected one, or null when the file no longer exists (it is never
 * recreated). Nothing is written in either case.
 */
export type FileWriteResult = { written: true } | { written: false; current: string | null };

/** The database file, bound to its current path (which can change on rename). */
export interface DbFile {
	read(): Promise<string | null>;
	/**
	 * Compare-and-swap: reads the file and, in the same atomic step,
	 * writes `content` only if `expected(currentText)` is true. A change that
	 * landed after our last read is therefore never overwritten.
	 */
	write(content: string, expected: (current: string) => boolean): Promise<FileWriteResult>;
}
