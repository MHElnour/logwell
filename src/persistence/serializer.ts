import { compareSortKeys } from "../domain/sortKey";
import {
	COLLECTIONS,
	COLLECTION_SPECS,
	type CollectionName,
	type DbData,
	type DbMeta,
	DB_FORMAT,
	HEADER_KEYS,
	compactRecord,
	orderKeys,
} from "./schema";

// Deterministic one-record-per-line writer.
//
//   {"format":"checkpoint-db","schemaVersion":…,"writtenAt":"…",   <- header line
//   "categories":[
//   {…},
//   {…}
//   ],
//   "sections":[],
//   …
//   "trash":[]
//   }
//
// The file is valid JSON. Collections are sorted by ID and keys are in a fixed
// order, so a git diff shows exactly the records that changed.

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value).sort()) {
			const v = (value as Record<string, unknown>)[k];
			if (v !== undefined) out[k] = canonical(v);
		}
		return out;
	}
	return value;
}

/** Canonicalizes the values of an already key-ordered record, keeping its key order. */
function canonicalValues(record: unknown): unknown {
	if (typeof record !== "object" || record === null) return record;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(record)) out[k] = canonical(v);
	return out;
}

export function serializeRecord(collection: CollectionName, record: object): string {
	const compact = compactRecord(collection, record);
	const top: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(compact)) {
		top[k] = collection === "trash" && k === "tasks" && Array.isArray(v) ? v.map(canonicalValues) : canonical(v);
	}
	return JSON.stringify(orderKeys(COLLECTION_SPECS[collection].keyOrder, top));
}

/**
 * Cached record lines (architecture.md, Saving, backups and recovery). Records are immutable, so a record
 * object's line never changes; a save re-serializes only new objects.
 */
export class RecordLineCache {
	private lines = new WeakMap<object, string>();

	line(collection: CollectionName, record: object): string {
		let line = this.lines.get(record);
		if (line === undefined) {
			line = serializeRecord(collection, record);
			this.lines.set(record, line);
		}
		return line;
	}
}

function serializeHeader(meta: DbMeta): string {
	const ordered: Record<string, unknown> = {};
	for (const k of HEADER_KEYS) ordered[k] = meta[k];
	const json = JSON.stringify(ordered);
	// Drop the closing brace: the header line opens the document.
	return `${json.slice(0, -1)},`;
}

export function serializeDb(data: DbData, cache: RecordLineCache = new RecordLineCache()): string {
	const out: string[] = [serializeHeader(data.meta)];
	COLLECTIONS.forEach((name, index) => {
		const trailer = index === COLLECTIONS.length - 1 ? "" : ",";
		const map = data[name] as ReadonlyMap<string, object>;
		if (map.size === 0) {
			out.push(`${JSON.stringify(name)}:[]${trailer}`);
			return;
		}
		out.push(`${JSON.stringify(name)}:[`);
		const ids = [...map.keys()].sort(compareSortKeys);
		ids.forEach((id, i) => {
			const record = map.get(id) as object;
			out.push(cache.line(name, record) + (i === ids.length - 1 ? "" : ","));
		});
		out.push(`]${trailer}`);
	});
	out.push("}");
	return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Reading

export type ParseFailure = "merge-markers" | "parse" | "not-a-database";

export type RawParse =
	| { ok: true; raw: Record<string, unknown> }
	| { ok: false; reason: ParseFailure; detail: string };

const MERGE_MARKER_RE = /^(<{7}|={7}|>{7})(\s|$)/m;

/** Parses the document into plain JSON. Validation happens separately. */
export function parseDbText(text: string): RawParse {
	if (MERGE_MARKER_RE.test(text)) {
		return { ok: false, reason: "merge-markers", detail: "The file contains git merge markers." };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return { ok: false, reason: "parse", detail: err instanceof Error ? err.message : String(err) };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, reason: "not-a-database", detail: "The file is not a JSON object." };
	}
	const obj = raw as Record<string, unknown>;
	if (obj.format !== DB_FORMAT || typeof obj.schemaVersion !== "number") {
		return { ok: false, reason: "not-a-database", detail: "The file is not a Logwell database." };
	}
	return { ok: true, raw: obj };
}

export interface HeaderInfo {
	revision: string;
	history: string[];
	schemaVersion: number;
	dbId: string;
	writtenAt: string;
}

/**
 * Reads only the header line. Returns null when the first line is
 * not a well-formed header, for example in a hand-edited file.
 */
export function readHeader(text: string): HeaderInfo | null {
	const end = text.indexOf("\n");
	// A CRLF checkout (git core.autocrlf) is the same header.
	const first = (end === -1 ? text : text.slice(0, end)).replace(/\r$/, "");
	if (!first.startsWith("{") || !first.endsWith(",")) return null;
	try {
		const h = JSON.parse(`${first.slice(0, -1)}}`) as Record<string, unknown>;
		if (h.format !== DB_FORMAT || typeof h.revision !== "string") return null;
		return {
			revision: h.revision,
			history: Array.isArray(h.history) ? h.history.filter((x): x is string => typeof x === "string") : [],
			schemaVersion: typeof h.schemaVersion === "number" ? h.schemaVersion : 0,
			dbId: typeof h.dbId === "string" ? h.dbId : "",
			writtenAt: typeof h.writtenAt === "string" ? h.writtenAt : "",
		};
	} catch {
		return null;
	}
}

/**
 * The file's revision: from the header line, or, for a file that is not in the
 * one-record-per-line layout (for example re-saved by another tool), from a
 * full parse. Null when the file is not a readable database.
 */
export function revisionOf(text: string): string | null {
	const header = readHeader(text);
	if (header !== null) return header.revision;
	const parsed = parseDbText(text);
	return parsed.ok && typeof parsed.raw.revision === "string" ? parsed.raw.revision : null;
}
