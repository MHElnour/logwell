import { DateTime } from "luxon";
import { DomainError } from "../domain/errors";
import { focusedSec } from "../domain/focus";
import { currentOccurrence, describeRule, indexOccurrenceRecords } from "../domain/recurrence";
import { compareSortKeys } from "../domain/sortKey";
import { tagDisplayPath } from "../domain/tags";
import { formatLatin } from "../domain/time";
import type { Task, WeekStart } from "../domain/types";
import { type LoadResult, loadText } from "../persistence/CpbaseStore";
import { serializeRecord } from "../persistence/serializer";
import {
	COLLECTIONS,
	type CollectionName,
	type DbCollections,
	type DbData,
	collectionsOf,
	emptyCollections,
} from "../persistence/schema";
import { repairReferences } from "../persistence/validate";
import type { AppStore } from "./store";

// Full JSON backup export and import.

export type ImportChangeKind = "add" | "overwrite" | "remove";

/** One record a merge would add, overwrite or remove. */
export interface ImportChange {
	kind: ImportChangeKind;
	collection: CollectionName;
	id: string;
	label: string;
}

export interface ImportPreview {
	schemaVersion: number;
	migratedFrom: number | null;
	counts: Record<CollectionName, number>;
	/**
	 * Every record a merge by ID would change, from the actual merge result:
	 * new records, overwrites, and Trash moves and removals.
	 */
	changes: ImportChange[];
	data: DbData;
	/** The state the preview was computed from; confirming refuses once it changed. */
	basis: DbData;
	/** The merge result the preview lists: exactly what "Merge by ID" applies. */
	merged: DbCollections;
}

const STALE_PREVIEW_MESSAGE = "The database changed since the preview. Review the import again.";

export type PreviewResult = { ok: true; preview: ImportPreview } | { ok: false; message: string };

/** The timestamp a merge compares: modifiedAt, or the closest equivalent. */
function recordTimestamp(record: unknown): string {
	const r = record as Record<string, unknown>;
	for (const k of ["modifiedAt", "deletedAt", "finalizedAt", "resolvedAt", "createdAt"]) {
		const v = r[k];
		if (typeof v === "string") return v;
	}
	return "";
}

function recordLabel(collection: CollectionName, id: string, record: unknown): string {
	const r = record as Record<string, unknown>;
	for (const k of ["title", "name", "displayName"]) {
		const v = r[k];
		if (typeof v === "string") return v;
	}
	if (collection === "trash") {
		const first = (r.tasks as Record<string, unknown>[] | undefined)?.[0];
		if (typeof first?.title === "string") return `Trash: ${first.title}`;
	}
	return id;
}

export function exportFileName(date: Date): string {
	return `logwell-backup-${date.toISOString().slice(0, 10)}.json`;
}

// -- CSV export -----------------------------------------------------------------------

/** One file of a CSV export. */
export interface CsvFile {
	name: string;
	content: string;
}

const CSV_BOM = "\uFEFF";

/** RFC 4180: a field with a comma, a quote, CR or LF is quoted, and its quotes are doubled. */
export function csvField(value: string): string {
	// CSV injection: a spreadsheet runs a cell that starts with =, +, -, @, tab or CR as a formula. Such a cell
	// gets a leading apostrophe, which spreadsheets show as text. A plain number ("-5") is left alone.
	const safe = /^[=+@\t\r]/u.test(value) || (value.startsWith("-") && !/^-\d+(\.\d+)?$/u.test(value)) ? `'${value}` : value;
	return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe;
}

/** A UTF-8 file with a byte order mark (so spreadsheets read it as UTF-8): the header row, then one row per record, CRLF line ends. */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
	return CSV_BOM + [header, ...rows].map((r) => r.map(csvField).join(",") + "\r\n").join("");
}

/** "Logwell export 2026-10-05 1430": the folder of one export, named by the local time in `zone`. */
export function exportFolderName(date: Date, zone: string): string {
	const dt = DateTime.fromJSDate(date, { zone });
	return `Logwell export ${formatLatin(dt.isValid ? dt : DateTime.fromJSDate(date), "yyyy-MM-dd HHmm")}`;
}

const bool = (b: boolean): string => (b ? "true" : "false");
const cell = (v: string | number | null | undefined): string => (v === null || v === undefined ? "" : String(v));
const json = (v: unknown): string => (v === null || v === undefined ? "" : JSON.stringify(v));

/** A date or a wall time as stored: "2026-10-05" or "2026-10-05T09:00" (the zone goes in its own column). */
function specParts(spec: Task["scheduled"]): [string, string] {
	return spec === null ? ["", ""] : spec.kind === "date" ? [spec.date, ""] : [spec.local, spec.tz];
}

export class DataService {
	constructor(private readonly store: AppStore) {}

	/**
	 * The database content, schema version included. Refused while
	 * read-only: the in-memory state is then a downgraded or recovered view.
	 */
	exportJson(): string {
		if (this.store.readOnlyState !== null) {
			throw new DomainError("ReadOnly", "Export is unavailable while the database is read-only.");
		}
		return this.store.host.serialize();
	}

	/**
	 * One CSV file per entity, content only (the host writes them). Columns are documented in
	 * docs/export.md. Refused while read-only, like the JSON export. `weekStart` is the setting that
	 * weekly repeats with an interval count from (the nextOccurrence column).
	 */
	exportCsv(weekStart: WeekStart = "MO"): CsvFile[] {
		if (this.store.readOnlyState !== null) {
			throw new DomainError("ReadOnly", "Export is unavailable while the database is read-only.");
		}
		const state = this.store.state;
		const listName = (id: string): string => state.categories.get(id)?.name ?? id;
		const habitName = (id: string): string => state.habits.get(id)?.name ?? "";
		const tagName = (key: string): string => tagDisplayPath(state.tags, key);
		const records = indexOccurrenceRecords(state.occurrenceRecords);
		// The engine reads no clock (the current occurrence does not move with the date), so any date will do.
		const today = this.store.now().slice(0, 10);

		const tasks = [...state.tasks.values()]
			.sort((a, b) => compareSortKeys(a.createdAt, b.createdAt) || compareSortKeys(a.id, b.id))
			.map((t) => {
				// Raw on purpose: the file shows what is stored (null for a repeating task; see nextOccurrence).
				const [scheduled, scheduledTz] = specParts(t.scheduled);
				const [deadline, deadlineTz] = specParts(t.deadline);
				const next = t.recurrence === null ? null : currentOccurrence(t, records.get(t.id) ?? [], today, weekStart);
				return [
					t.id,
					t.title,
					listName(t.categoryId),
					t.sectionId === null ? "" : (state.sections.get(t.sectionId)?.name ?? ""),
					t.tagKeys.map(tagName).join("; "),
					cell(t.parentId),
					scheduled,
					scheduledTz,
					deadline,
					deadlineTz,
					cell(t.plannedDurationMin),
					bool(t.urgent),
					bool(t.important),
					String(t.priority),
					t.status,
					cell(t.completedAt),
					t.recurrence === null ? "" : describeRule(t.recurrence),
					json(t.recurrence),
					cell(next),
					t.sortKey,
					t.createdAt,
					t.modifiedAt,
					cell(t.descriptionNote?.path),
				];
			});

		const lists = [...state.categories.values()]
			.sort((a, b) => compareSortKeys(a.sortKey, b.sortKey) || compareSortKeys(a.id, b.id))
			.map((c) => [c.id, c.name, cell(c.icon), cell(c.color), bool(c.isInbox), c.sortKey, c.createdAt, c.modifiedAt]);

		const sections = [...state.sections.values()]
			.sort((a, b) => compareSortKeys(a.categoryId, b.categoryId) || compareSortKeys(a.sortKey, b.sortKey) || compareSortKeys(a.id, b.id))
			.map((s) => [s.id, listName(s.categoryId), s.categoryId, s.name, s.sortKey, s.createdAt, s.modifiedAt]);

		const tags = [...state.tags.values()]
			.sort((a, b) => compareSortKeys(a.key, b.key))
			.map((t) => [t.key, t.displayName, cell(t.color), t.createdAt, t.modifiedAt]);

		// The records of a series in the Trash keep their rows: the title comes from the trash entry (`trashed` true).
		const trashedTitles = new Map<string, string>();
		for (const e of state.trash.values()) for (const t of e.tasks) trashedTitles.set(t.id, t.title);
		const occurrences = [...state.occurrenceRecords.values()]
			.sort((a, b) => compareSortKeys(a.taskId, b.taskId) || compareSortKeys(a.occurrenceDate, b.occurrenceDate))
			.map((r) => {
				const live = state.tasks.get(r.taskId);
				const title = live?.title ?? trashedTitles.get(r.taskId) ?? "";
				return [r.taskId, title, bool(live === undefined && trashedTitles.has(r.taskId)), r.occurrenceDate, r.status, r.resolvedAt, bool(r.auto), cell(r.completedOn)];
			});

		const sessions = [...state.focusSessions.values()]
			.sort((a, b) => compareSortKeys(a.startedAt, b.startedAt) || compareSortKeys(a.id, b.id))
			.map((f) => [
				f.id,
				f.deviceId,
				cell(f.taskId),
				f.taskTitleSnapshot,
				String(f.plannedSec),
				f.status,
				f.startedAt,
				f.endedAt,
				f.finalizedAt,
				String(focusedSec(f)),
				cell(f.splitFrom),
				cell(f.setId),
				cell(f.setRounds),
				cell(f.setRound),
				json(f.segments),
				json(f.unobserved),
				cell(f.modifiedAt),
			]);

		const habits = [...state.habits.values()]
			.sort((a, b) => compareSortKeys(a.sortKey, b.sortKey) || compareSortKeys(a.id, b.id))
			.map((h) => {
				const now = h.versions[h.versions.length - 1];
				return [
					h.id,
					h.name,
					cell(h.icon),
					cell(h.color),
					h.timeOfDay,
					cell(h.reminder?.time),
					cell(h.archivedAt),
					cell(now?.goal.type),
					cell(now?.goal.target),
					cell(now?.goal.unit),
					cell(now?.goal.period),
					json(now?.schedule),
					h.sortKey,
					h.createdAt,
					h.modifiedAt,
					json(h.versions),
				];
			});

		const checkins = [...state.checkins.values()]
			.sort((a, b) => compareSortKeys(a.habitId, b.habitId) || compareSortKeys(a.date, b.date) || compareSortKeys(a.createdAt, b.createdAt) || compareSortKeys(a.id, b.id))
			.map((c) => [c.id, c.habitId, habitName(c.habitId), c.date, String(c.value), cell(c.note), c.createdAt, c.modifiedAt, cell(c.deletedAt)]);

		return [
			{
				name: "tasks.csv",
				content: toCsv(
					["id", "title", "list", "section", "tags", "parentId", "scheduled", "scheduledTz", "deadline", "deadlineTz", "plannedDurationMin", "urgent", "important", "priority", "status", "completedAt", "repeat", "repeatJson", "nextOccurrence", "sortKey", "createdAt", "modifiedAt", "note"],
					tasks,
				),
			},
			{ name: "lists.csv", content: toCsv(["id", "name", "icon", "color", "isInbox", "sortKey", "createdAt", "modifiedAt"], lists) },
			{ name: "sections.csv", content: toCsv(["id", "list", "listId", "name", "sortKey", "createdAt", "modifiedAt"], sections) },
			{ name: "tags.csv", content: toCsv(["key", "displayName", "color", "createdAt", "modifiedAt"], tags) },
			{ name: "occurrences.csv", content: toCsv(["taskId", "task", "trashed", "occurrenceDate", "status", "resolvedAt", "auto", "completedOn"], occurrences) },
			{
				name: "focus-sessions.csv",
				content: toCsv(
					["id", "deviceId", "taskId", "taskTitle", "plannedSec", "status", "startedAt", "endedAt", "finalizedAt", "focusedSec", "splitFrom", "setId", "setRounds", "setRound", "segmentsJson", "unobservedJson", "modifiedAt"],
					sessions,
				),
			},
			{
				name: "habits.csv",
				content: toCsv(
					["id", "name", "icon", "color", "timeOfDay", "reminder", "archivedAt", "goalType", "goalTarget", "goalUnit", "goalPeriod", "scheduleJson", "sortKey", "createdAt", "modifiedAt", "versionsJson"],
					habits,
				),
			},
			{ name: "check-ins.csv", content: toCsv(["id", "habitId", "habit", "date", "value", "note", "createdAt", "modifiedAt", "deletedAt"], checkins) },
		];
	}

	previewImport(text: string): PreviewResult {
		const result: LoadResult = loadText(text, this.store.now());
		if (result.kind === "newer") {
			return { ok: false, message: `This backup uses schema version ${result.version}. Update the plugin to import it.` };
		}
		if (result.kind === "failed") {
			return { ok: false, message: `This file is not a readable Logwell backup (${result.detail}).` };
		}
		const data = result.data;
		const counts = {} as Record<CollectionName, number>;
		for (const c of COLLECTIONS) counts[c] = (data[c] as ReadonlyMap<string, unknown>).size;
		const basis = this.store.state;
		const merged = mergeCollections(basis, data, this.store.now());
		const changes = diffCollections(basis, merged);
		return {
			ok: true,
			preview: { schemaVersion: data.meta.schemaVersion, migratedFrom: result.migratedFrom, counts, changes, data, basis, merged },
		};
	}

	/** Replace all: a snapshot of the current state is taken first. */
	importReplace(preview: ImportPreview): Promise<void> {
		return this.store.replaceAll(collectionsOf(preview.data), "pre-import", (current) => assertUnchanged(current, preview));
	}

	/**
	 * Merge by ID: new records are added; on both sides the newer modifiedAt wins.
	 * Applies the previewed result, so nothing the preview did not list can change
	 * (for example a silent reload while the preview is open).
	 */
	importMerge(preview: ImportPreview): Promise<void> {
		return this.store.replaceAll(preview.merged, "pre-import", (current) => assertUnchanged(current, preview));
	}
}

/**
 * The preview must describe what is applied. Any commit, undo or reload
 * replaces a collection map; a save only replaces the meta, which is ignored.
 */
function assertUnchanged(current: DbData, preview: ImportPreview): void {
	if (COLLECTIONS.some((c) => current[c] !== preview.basis[c])) {
		throw new DomainError("StalePreview", STALE_PREVIEW_MESSAGE);
	}
}

/** Lists the records that differ between the current state and a merge result. */
function diffCollections(current: DbData, merged: DbCollections): ImportChange[] {
	const changes: ImportChange[] = [];
	const trashedIds = new Set<string>();
	for (const e of merged.trash.values()) for (const t of e.tasks) trashedIds.add(t.id);
	for (const c of COLLECTIONS) {
		const before = current[c] as ReadonlyMap<string, object>;
		const after = merged[c] as ReadonlyMap<string, object>;
		for (const [id, rec] of after) {
			const mine = before.get(id);
			if (mine === undefined) changes.push({ kind: "add", collection: c, id, label: recordLabel(c, id, rec) });
			else if (mine !== rec && serializeRecord(c, mine) !== serializeRecord(c, rec)) {
				changes.push({ kind: "overwrite", collection: c, id, label: recordLabel(c, id, rec) });
			}
		}
		for (const [id, mine] of before) {
			if (after.has(id)) continue;
			let label = recordLabel(c, id, mine);
			if (c === "tasks" && trashedIds.has(id)) label = `${label} (moved to Trash)`;
			else if (c === "trash") label = `${label} (removed from Trash)`;
			changes.push({ kind: "remove", collection: c, id, label });
		}
	}
	return changes;
}

export function mergeCollections(current: DbData, incoming: DbData, now: string): DbCollections {
	const merged = emptyCollections();
	for (const c of COLLECTIONS) {
		const target = merged[c] as Map<string, unknown>;
		for (const [id, rec] of current[c] as ReadonlyMap<string, unknown>) target.set(id, rec);
		for (const [id, rec] of incoming[c] as ReadonlyMap<string, unknown>) {
			const mine = target.get(id);
			if (mine === undefined || recordTimestamp(rec) > recordTimestamp(mine)) target.set(id, rec);
		}
	}
	// A task can be live on one side and in Trash on the other. The newer action
	// wins: a deletion after the last edit keeps it in Trash, otherwise it stays live.
	for (const entry of [...merged.trash.values()]) {
		const live = entry.tasks.map((t) => merged.tasks.get(t.id)).filter((t) => t !== undefined);
		if (live.length === 0) continue;
		const lastEdit = live.reduce((max, t) => (t.modifiedAt > max ? t.modifiedAt : max), "");
		if (entry.deletedAt >= lastEdit) for (const t of live) merged.tasks.delete(t.id);
		else merged.trash.delete(entry.batchId);
	}
	repairReferences(merged, now, []);
	return merged;
}
