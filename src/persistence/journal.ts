import { type CollectionName, type DbData, isCollectionName } from "./schema";
import { readRecord } from "./validate";

// Record-level mutation log. Each save appends one line;
// recovery = newest valid snapshot + replay of the entries after it.

export interface JournalOp {
	c: CollectionName;
	id: string;
	/** The full record after the change, or null when it was removed. */
	v: unknown;
}

export interface JournalEntry {
	rev: string;
	base: string | null;
	at: string;
	ops: JournalOp[];
}

export function journalLine(entry: JournalEntry): string {
	return `${JSON.stringify(entry)}\n`;
}

/**
 * Parses the journal. A torn line (a crash during an append) is skipped, not
 * the end of the log: appends go on after a restart, and replay ignores the
 * dead end it leaves.
 */
export function parseJournal(text: string): JournalEntry[] {
	const entries: JournalEntry[] = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const e = JSON.parse(line) as JournalEntry;
			if (typeof e.rev === "string" && Array.isArray(e.ops)) entries.push(e);
		} catch {
			// A torn line.
		}
	}
	return entries;
}

/** Applies ops to a copy of the data. Records are validated like file records. */
export function applyOps(data: DbData, ops: readonly JournalOp[]): DbData {
	const next: Record<string, unknown> = { ...data };
	const copied = new Set<CollectionName>();
	for (const op of ops) {
		if (!isCollectionName(op.c)) continue;
		if (!copied.has(op.c)) {
			next[op.c] = new Map(data[op.c] as ReadonlyMap<string, unknown>);
			copied.add(op.c);
		}
		const map = next[op.c] as Map<string, unknown>;
		if (op.v === null) map.delete(op.id);
		else {
			const record = readRecord(op.c, op.v, op.id);
			if (record === null) map.delete(op.id); // a damaged section record is dropped
			else map.set(op.id, record);
		}
	}
	return next as unknown as DbData;
}

/**
 * Replays the entries that continue the chain from `fromRevision`, stopping at
 * `untilRevision` if given. Returns the revision reached and the revisions
 * applied in order: the lineage after `fromRevision`.
 *
 * A write refused by the compare-and-swap leaves an entry whose revision never
 * reached the file, and the retry appends a second entry with the same base. The
 * store re-queues the failed entry's ops, so the retry's entry carries them too.
 * The last entry for a base is therefore the one that continues the chain; an
 * earlier one with the same base is a dead end. A write that threw may have
 * landed, so its retry continues from the attempted revision instead.
 */
export function replayJournal(
	data: DbData,
	entries: readonly JournalEntry[],
	fromRevision: string,
	untilRevision: string | null = null,
): { data: DbData; revision: string; revisions: string[] } {
	const next = new Map<string, JournalEntry>();
	for (const e of entries) if (e.base !== null) next.set(e.base, e);
	let current = data;
	let revision = fromRevision;
	const revisions: string[] = [];
	const seen = new Set<string>([revision]);
	while (revision !== untilRevision) {
		const e = next.get(revision);
		if (e === undefined || seen.has(e.rev)) break;
		seen.add(e.rev);
		current = applyOps(current, e.ops);
		revision = e.rev;
		revisions.push(revision);
	}
	return { data: current, revision, revisions };
}
