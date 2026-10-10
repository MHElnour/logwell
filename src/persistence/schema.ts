import type { Category, Checkin, FocusSession, Habit, Instant, OccurrenceRecord, OpaqueRecord, Section, SyncLink, Tag, Task, TrashEntry } from "../domain/types";
import { INBOX_ID, isRecord, syncLinkId } from "../domain/types";

// The `.cpbase` data model. One JSON document with a header
// and one array per collection. In memory each collection is a Map by ID.

export const DB_FORMAT = "checkpoint-db";
/** The file extension of a database, without the dot (the form of `TFile.extension`). */
export const DB_EXTENSION = "cpbase";
/**
 * v4 types `Task.recurrence` and `occurrenceRecords`. The bump exists so a schema 3 device
 * opens a database with repeating tasks read-only instead of completing a whole series.
 * v5 adds `syncLinks`, so a schema 4 device opens it read-only instead of
 * writing the file back without the TickTick links.
 */
export const CURRENT_SCHEMA_VERSION = 5;
export const HISTORY_LIMIT = 50;
/**
 * The `dbId` the store holds for a damaged database it never knew (no readable
 * header, no id remembered for the path). It names no database: nothing is
 * stored under it.
 */
export const PLACEHOLDER_DB_ID = "unknown";

/**
 * The id device-local state may be stored under, or null while the store holds only the placeholder of a
 * read-only damaged database: that id names no database.
 */
export function storableDbId(dbId: string, readOnly: boolean): string | null {
	return dbId === PLACEHOLDER_DB_ID && readOnly ? null : dbId;
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A dbId or revision that can be used as a file or folder name. Both come
 * from a synced file and end up in backup paths. Generated values (UUIDs,
 * "r-" + hex) always match.
 */
export function isSafeId(value: string): boolean {
	return SAFE_ID_RE.test(value);
}

export interface DbMeta {
	format: typeof DB_FORMAT;
	schemaVersion: number;
	dbId: string;
	revision: string;
	baseRevision: string | null;
	history: string[];
	writtenBy: string;
	writtenAt: Instant;
}

export const HEADER_KEYS = [
	"format",
	"schemaVersion",
	"dbId",
	"revision",
	"baseRevision",
	"history",
	"writtenBy",
	"writtenAt",
] as const satisfies readonly (keyof DbMeta)[];

export interface DbCollections {
	categories: ReadonlyMap<string, Category>;
	sections: ReadonlyMap<string, Section>;
	tags: ReadonlyMap<string, Tag>;
	tasks: ReadonlyMap<string, Task>;
	occurrenceRecords: ReadonlyMap<string, OccurrenceRecord>;
	habits: ReadonlyMap<string, Habit>;
	checkins: ReadonlyMap<string, Checkin>;
	focusSessions: ReadonlyMap<string, FocusSession>;
	savedFilters: ReadonlyMap<string, OpaqueRecord>;
	trash: ReadonlyMap<string, TrashEntry>;
	syncLinks: ReadonlyMap<string, SyncLink>;
}

export type CollectionName = keyof DbCollections;
export type RecordOf<C extends CollectionName> = DbCollections[C] extends ReadonlyMap<string, infer R> ? R : never;

export interface DbData extends DbCollections {
	meta: DbMeta;
}

/** File order of the collections. */
export const COLLECTIONS: readonly CollectionName[] = [
	"categories",
	"sections",
	"tags",
	"tasks",
	"occurrenceRecords",
	"habits",
	"checkins",
	"focusSessions",
	"savedFilters",
	"trash",
	"syncLinks",
];

export function isCollectionName(value: unknown): value is CollectionName {
	return typeof value === "string" && (COLLECTIONS as readonly string[]).includes(value);
}

interface CollectionSpec {
	/** Fixed key order on write; unknown keys follow in sorted order. */
	keyOrder: readonly string[];
	/** Fields equal to these values are left out on write and restored on read. */
	defaults: Readonly<Record<string, unknown>>;
	idOf(record: Record<string, unknown>): string;
}

const byField =
	(field: string) =>
	(r: Record<string, unknown>): string =>
		String(r[field]);

const TASK_SPEC: CollectionSpec = {
	keyOrder: [
		"id",
		"title",
		"descriptionNote",
		"categoryId",
		"tagKeys",
		"parentId",
		"sectionId",
		"scheduled",
		"deadline",
		"plannedDurationMin",
		"urgent",
		"important",
		"priority",
		"status",
		"completedAt",
		"recurrence",
		"sortKey",
		"createdAt",
		"modifiedAt",
	],
	defaults: {
		descriptionNote: null,
		tagKeys: [],
		parentId: null,
		sectionId: null,
		scheduled: null,
		deadline: null,
		plannedDurationMin: null,
		urgent: false,
		important: false,
		priority: 0,
		completedAt: null,
		recurrence: null,
	},
	idOf: byField("id"),
};

export const COLLECTION_SPECS: Readonly<Record<CollectionName, CollectionSpec>> = {
	categories: {
		keyOrder: ["id", "name", "icon", "color", "nameKey", "isInbox", "sortKey", "createdAt", "modifiedAt"],
		defaults: { icon: null, color: null, isInbox: false },
		idOf: byField("id"),
	},
	sections: {
		keyOrder: ["id", "categoryId", "name", "nameKey", "sortKey", "createdAt", "modifiedAt"],
		defaults: {},
		idOf: byField("id"),
	},
	tags: {
		keyOrder: ["key", "displayName", "color", "createdAt", "modifiedAt"],
		defaults: { color: null },
		idOf: byField("key"),
	},
	tasks: TASK_SPEC,
	// Typed in v4. `auto: false` and `completedOn: null` are left out on write.
	occurrenceRecords: {
		keyOrder: ["taskId", "occurrenceDate", "status", "resolvedAt", "auto", "completedOn"],
		defaults: { auto: false, completedOn: null },
		idOf: (r) => `${String(r.taskId)}:${String(r.occurrenceDate)}`,
	},
	// Typed without a schema bump (v3). Nested values (versions) are written with sorted keys.
	habits: {
		keyOrder: ["id", "name", "icon", "color", "timeOfDay", "reminder", "archivedAt", "sortKey", "createdAt", "modifiedAt", "versions"],
		defaults: { icon: null, color: null, timeOfDay: "anytime", reminder: null, archivedAt: null },
		idOf: byField("id"),
	},
	checkins: {
		keyOrder: ["id", "habitId", "date", "value", "note", "createdAt", "modifiedAt", "deletedAt"],
		defaults: { note: null, deletedAt: null },
		idOf: byField("id"),
	},
	focusSessions: {
		keyOrder: [
			"id",
			"deviceId",
			"taskId",
			"taskTitleSnapshot",
			"plannedSec",
			"status",
			"segments",
			"unobserved",
			"splitFrom",
			"setId",
			"setRounds",
			"setRound",
			"startedAt",
			"endedAt",
			"finalizedAt",
			"modifiedAt",
		],
		defaults: { taskId: null, splitFrom: null, unobserved: [] },
		idOf: byField("id"),
	},
	savedFilters: { keyOrder: ["id"], defaults: {}, idOf: byField("id") },
	trash: { keyOrder: ["batchId", "deletedAt", "tasks"], defaults: {}, idOf: byField("batchId") },
	// Keyed `kind:logwellId`, derived like an occurrence record's key.
	syncLinks: {
		keyOrder: ["kind", "logwellId", "ttId", "ttProjectId", "etag", "base", "noteBySync", "noteBase", "noteItems", "lastPulledAt", "pendingDelete", "mode", "modifiedAt"],
		defaults: { ttProjectId: null, etag: null, base: {}, noteBySync: false, lastPulledAt: null, pendingDelete: false, mode: "sync" },
		idOf: (r) => syncLinkId(r.kind as SyncLink["kind"], String(r.logwellId)),
	},
};

export function recordId(collection: CollectionName, record: unknown): string {
	return COLLECTION_SPECS[collection].idOf(record as Record<string, unknown>);
}

/** A `[]` or `{}` default matches any empty list or object. */
function isDefault(value: unknown, def: unknown): boolean {
	if (Array.isArray(def)) return Array.isArray(value) && value.length === 0;
	if (isRecord(def)) return isRecord(value) && Object.keys(value).length === 0;
	return value === def;
}

/** A fresh copy of a `[]` or `{}` default, so no two records share one. */
function freshDefault(def: unknown): unknown {
	if (Array.isArray(def)) return [];
	if (isRecord(def)) return {};
	return def;
}

function compactWith(spec: CollectionSpec, record: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(record)) {
		if (v === undefined) continue;
		if (k in spec.defaults && isDefault(v, spec.defaults[k])) continue;
		out[k] = v;
	}
	return out;
}

function expandWith(spec: CollectionSpec, record: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...record };
	for (const [k, def] of Object.entries(spec.defaults)) {
		if (!(k in out) || out[k] === undefined) out[k] = freshDefault(def);
	}
	return out;
}

/** Leaves out default-valued fields. Trash entries compact their nested tasks too. */
export function compactRecord(collection: CollectionName, record: object): Record<string, unknown> {
	const r = compactWith(COLLECTION_SPECS[collection], record as Record<string, unknown>);
	if (collection === "trash" && Array.isArray(r.tasks)) {
		r.tasks = (r.tasks as Record<string, unknown>[]).map((t) => orderKeys(TASK_SPEC.keyOrder, compactWith(TASK_SPEC, t)));
	}
	return r;
}

/** Restores default-valued fields left out by compactRecord. */
export function expandRecord(collection: CollectionName, record: Record<string, unknown>): Record<string, unknown> {
	const r = expandWith(COLLECTION_SPECS[collection], record);
	if (collection === "trash" && Array.isArray(r.tasks)) {
		r.tasks = (r.tasks as unknown[]).map((t) =>
			typeof t === "object" && t !== null ? expandWith(TASK_SPEC, t as Record<string, unknown>) : t,
		);
	}
	return r;
}

export function orderKeys(keyOrder: readonly string[], record: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of keyOrder) if (k in record) out[k] = record[k];
	for (const k of Object.keys(record).sort()) if (!(k in out)) out[k] = record[k];
	return out;
}

export function emptyCollections(): { [C in CollectionName]: Map<string, RecordOf<C>> } {
	return {
		categories: new Map(),
		sections: new Map(),
		tags: new Map(),
		tasks: new Map(),
		occurrenceRecords: new Map(),
		habits: new Map(),
		checkins: new Map(),
		focusSessions: new Map(),
		savedFilters: new Map(),
		trash: new Map(),
		syncLinks: new Map(),
	};
}

export function inboxCategory(now: Instant): Category {
	return {
		id: INBOX_ID,
		name: "Inbox",
		icon: "📥",
		color: null,
		nameKey: "inbox",
		isInbox: true,
		sortKey: "0V",
		createdAt: now,
		modifiedAt: now,
	};
}

/** A new database: header plus the permanent Inbox. */
export function createEmptyDb(opts: { dbId: string; revision: string; deviceId: string; now: Instant }): DbData {
	const collections = emptyCollections();
	collections.categories.set(INBOX_ID, inboxCategory(opts.now));
	return {
		meta: {
			format: DB_FORMAT,
			schemaVersion: CURRENT_SCHEMA_VERSION,
			dbId: opts.dbId,
			revision: opts.revision,
			baseRevision: null,
			history: [],
			writtenBy: opts.deviceId,
			writtenAt: opts.now,
		},
		...collections,
	};
}

export function collectionsOf(data: DbData): DbCollections {
	const { meta: _meta, ...rest } = data;
	return rest;
}
