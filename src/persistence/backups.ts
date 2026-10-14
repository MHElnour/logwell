import type { Clock } from "../domain/ports";
import { fileNameOf, joinPath } from "../domain/notes";
import { instantFromNow } from "../domain/time";
import type { FileGateway } from "./gateway";
import { type JournalEntry, journalLine, parseJournal } from "./journal";
import { DB_EXTENSION, isSafeId } from "./schema";
import { readHeader } from "./serializer";

// Snapshot + journal backups and conflict copies in the plugin folder
// Device-local recovery data; never inside the vault
// proper.
//
// <root>/snapshots/hourly-<stamp><meta>.cpbase     session start, then hourly; newest 5 kept
// <root>/snapshots/reload-<stamp><meta>.cpbase     first save after an external reload; newest 5 kept
// <root>/snapshots/daily-<stamp><meta>.cpbase      one per (UTC) day; kept 14 days
// <root>/snapshots/<reason>-<stamp><meta>.cpbase   pre-migration, pre-repair, pre-import, pre-restore, pre-sync; newest 5 each
// <root>/journal.ndjson                           mutations since the newest snapshot
// <root>/conflicts/<stamp>-<label><meta>.cpbase    forked, damaged or lost versions
//
// <meta> is "~<writtenAt>~<revision>" from the content's header, so listing
// needs no file reads. writtenAt is compacted like <stamp>. A name
// without <meta> (older files, or a header value that cannot go in a file
// name) is listed by reading its header.
//
// <stamp> is this device's clock at write time. Snapshots are ordered by it,
// never by the header's writtenAt, which may come from another device's clock.
// Older daily names carry only <YYYY-MM-DD>.
//
// A stamp later than the current time means the clock was corrected backwards
// after the snapshot was written. Such a snapshot ranks below every other
// one, in listings, recovery and pruning, so it cannot stay "newest" for as long
// as the wrong date lasts.
//
// Header values come from a synced file, so none reaches a path unchecked:
// the dbId folder must be a safe id, labels are sanitized, and reads, moves and
// removals stay inside the root.

/** `pre-sync`: before the first sync of a list linked to TickTick. */
export type SnapshotKind = "hourly" | "daily" | "reload" | "pre-migration" | "pre-repair" | "pre-import" | "pre-restore" | "pre-sync";

const SNAPSHOT_KINDS: readonly SnapshotKind[] = ["hourly", "daily", "reload", "pre-migration", "pre-repair", "pre-import", "pre-restore", "pre-sync"];
const HOURLY_KEEP = 5;
const DAILY_KEEP_DAYS = 14;
const OTHER_KEEP = 5;
export const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;

export interface BackupInfo {
	path: string;
	kind: SnapshotKind | "conflict";
	/** From the file header; empty when the header is unreadable. */
	revision: string;
	writtenAt: string;
	/** Sortable creation stamp from the file name. */
	stamp: string;
}

function fileStamp(date: Date): string {
	return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}

/** The backup folder of a database. Throws for a dbId that is not a safe folder name. */
export function dbBackupRoot(parent: string, dbId: string): string {
	if (!isSafeId(dbId)) throw new Error("The database id is not valid, so its backup folder cannot be used.");
	return joinPath(parent, dbId);
}

/** A file-name-safe label (for a revision from local state or from a file). */
function safeLabel(label: string): string {
	return label.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "copy";
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A stamp that sorts by local write time. An older day-only daily stamp sorts as the start of its day. */
function sortStamp(stamp: string): string {
	const day = DAY_RE.exec(stamp);
	return day === null ? stamp : `${day[1]}${day[2]}${day[3]}`;
}

/** The UTC day ("YYYY-MM-DD") of a stamp. */
function dayOf(stamp: string): string {
	return DAY_RE.test(stamp) ? stamp : `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
}

/** Of snapshots written in the same instant, one holding the state before a change ranks as older. */
function kindRank(kind: BackupInfo["kind"]): number {
	return kind.startsWith("pre-") ? 0 : 1;
}



const EXT = `.${DB_EXTENSION}`;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const COMPACT_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/;
const SAFE_REVISION_RE = /^[A-Za-z0-9_-]{0,64}$/;

/** "~<writtenAt>~<revision>" for the content's header, or "" when a value cannot go in a file name. */
function metaSuffix(content: string): string {
	const header = readHeader(content);
	const writtenAt = header?.writtenAt ?? "";
	const revision = header?.revision ?? "";
	if (writtenAt !== "" && !ISO_RE.test(writtenAt)) return "";
	if (!SAFE_REVISION_RE.test(revision)) return "";
	return `~${writtenAt.replace(/[-:.]/g, "")}~${revision}`;
}

/** Splits a backup file name into its base and the header values encoded in it (null: not encoded). */
function splitName(path: string): { base: string; meta: { revision: string; writtenAt: string } | null } | null {
	const name = fileNameOf(path);
	if (!name.endsWith(EXT)) return null;
	const [base = "", compact, revision, ...extra] = name.slice(0, -EXT.length).split("~");
	if (compact === undefined || revision === undefined || extra.length > 0) return { base, meta: null };
	const m = COMPACT_RE.exec(compact);
	if (compact !== "" && m === null) return { base, meta: null };
	const writtenAt = m === null ? "" : `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
	return { base, meta: { revision, writtenAt } };
}

function parseSnapshotName(path: string): { kind: SnapshotKind; stamp: string } | null {
	const split = splitName(path);
	if (split === null) return null;
	for (const kind of SNAPSHOT_KINDS) {
		if (split.base.startsWith(`${kind}-`)) return { kind, stamp: split.base.slice(kind.length + 1) };
	}
	return null;
}

export class BackupStore {
	constructor(
		private readonly fs: FileGateway,
		readonly root: string,
		private readonly clock: Clock,
	) {}

	get snapshotDir(): string {
		return joinPath(this.root, "snapshots");
	}

	get conflictDir(): string {
		return joinPath(this.root, "conflicts");
	}

	get journalPath(): string {
		return joinPath(this.root, "journal.ndjson");
	}

	async writeSnapshot(kind: SnapshotKind, content: string): Promise<string> {
		await this.fs.mkdir(this.root);
		await this.fs.mkdir(this.snapshotDir);
		const now = this.clock.now();
		const stamp = fileStamp(now);
		const path = joinPath(this.snapshotDir, `${kind}-${stamp}${metaSuffix(content)}${EXT}`);
		await this.fs.write(path, content);
		if (kind === "daily") this.dailyDate = dayOf(stamp);
		return path;
	}

	/** The date of a daily snapshot known to exist, so most saves need no folder listing. */
	private dailyDate: string | null = null;

	async hasDailySnapshot(date: Date): Promise<boolean> {
		const day = date.toISOString().slice(0, 10);
		if (this.dailyDate === day) return true;
		const found = (await this.fs.list(this.snapshotDir)).some((p) => {
			const parsed = parseSnapshotName(p);
			return parsed?.kind === "daily" && dayOf(parsed.stamp) === day;
		});
		if (found) this.dailyDate = day;
		return found;
	}

	/** The header values of a backup file: from its name, or from its header for older names. */
	private async headerOf(path: string): Promise<{ revision: string; writtenAt: string }> {
		const encoded = splitName(path)?.meta;
		if (encoded != null) return encoded;
		const text = await this.fs.read(path);
		const header = text === null ? null : readHeader(text);
		return { revision: header?.revision ?? "", writtenAt: header?.writtenAt ?? "" };
	}

	/** True when the stamp lies after the current time: the clock went back since it was written. */
	isFutureStamp(stamp: string): boolean {
		return sortStamp(stamp) > fileStamp(this.clock.now());
	}

	async listSnapshots(): Promise<BackupInfo[]> {
		const result: BackupInfo[] = [];
		for (const path of await this.fs.list(this.snapshotDir)) {
			const parsed = parseSnapshotName(path);
			if (parsed === null) continue;
			result.push({ path, kind: parsed.kind, ...(await this.headerOf(path)), stamp: parsed.stamp });
		}
		// Newest first by this device's write time; "before" states last on a
		// tie; stamps from the future after everything else.
		return result.sort((a, b) => {
			const fa = this.isFutureStamp(a.stamp);
			if (fa !== this.isFutureStamp(b.stamp)) return fa ? 1 : -1;
			const sa = sortStamp(a.stamp);
			const sb = sortStamp(b.stamp);
			if (sa !== sb) return sa < sb ? 1 : -1;
			return kindRank(b.kind) - kindRank(a.kind);
		});
	}

	/** Throws for a path outside this database's backup folder. */
	private assertInside(path: string): void {
		const segments = path.split("/");
		if (!path.startsWith(`${this.root}/`) || segments.includes("..") || segments.includes(".")) {
			throw new Error("The backup path is outside the backup folder.");
		}
	}

	async read(path: string): Promise<string | null> {
		this.assertInside(path);
		return this.fs.read(path);
	}

	/** True once this store knows the journal ends with a line break, so an append starts a line of its own. */
	private journalEndsLine = false;

	async appendJournal(entry: JournalEntry): Promise<void> {
		await this.fs.mkdir(this.root);
		let line = journalLine(entry);
		if (!this.journalEndsLine) {
			// A crash during an earlier append can leave a torn line without its end.
			const text = await this.fs.read(this.journalPath);
			if (text !== null && text !== "" && !text.endsWith("\n")) line = `\n${line}`;
		}
		this.journalEndsLine = false;
		await this.fs.append(this.journalPath, line);
		this.journalEndsLine = true;
	}

	async resetJournal(): Promise<void> {
		await this.fs.mkdir(this.root);
		this.journalEndsLine = false;
		await this.fs.write(this.journalPath, "");
		this.journalEndsLine = true;
	}

	async readJournal(): Promise<JournalEntry[]> {
		const text = await this.fs.read(this.journalPath);
		return text === null ? [] : parseJournal(text);
	}

	/** Writes a conflict copy; with `path` (from an earlier call) it rewrites that copy. */
	async writeConflict(content: string, revision: string, path?: string): Promise<string> {
		await this.fs.mkdir(this.root);
		await this.fs.mkdir(this.conflictDir);
		path ??= joinPath(this.conflictDir, `${fileStamp(this.clock.now())}-${safeLabel(revision)}${metaSuffix(content)}${EXT}`);
		this.assertInside(path);
		await this.fs.write(path, content);
		return path;
	}

	/** Removes a conflict copy that a newer copy of the same state replaced. */
	async removeConflict(path: string): Promise<void> {
		this.assertInside(path);
		await this.fs.remove(path);
	}

	async listConflicts(): Promise<BackupInfo[]> {
		const result: BackupInfo[] = [];
		for (const path of await this.fs.list(this.conflictDir)) {
			if (!path.endsWith(EXT)) continue;
			result.push({ path, kind: "conflict", ...(await this.headerOf(path)), stamp: fileNameOf(path).split("-")[0] ?? "" });
		}
		return result.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
	}

	/** Moves a handled conflict copy out of the open list. The content is kept. */
	async resolveConflict(path: string): Promise<void> {
		this.assertInside(path);
		const text = await this.fs.read(path);
		if (text === null) return;
		const dir = joinPath(this.conflictDir, "resolved");
		await this.fs.mkdir(dir);
		await this.fs.write(joinPath(dir, fileNameOf(path)), text);
		await this.fs.remove(path);
	}

	/** Applies the retention rules. */
	async prune(): Promise<void> {
		const snapshots = await this.fs.list(this.snapshotDir);
		const byKind = new Map<SnapshotKind, { path: string; stamp: string }[]>();
		for (const path of snapshots) {
			const parsed = parseSnapshotName(path);
			if (parsed === null) continue;
			const list = byKind.get(parsed.kind) ?? [];
			list.push({ path, stamp: parsed.stamp });
			byKind.set(parsed.kind, list);
		}
		const cutoff = instantFromNow(this.clock, -DAILY_KEEP_DAYS * 24 * 3600 * 1000).slice(0, 10);
		for (const [kind, list] of byKind) {
			// Newest first, snapshots stamped in the future after the rest, so a
			// future stamp evicts first and never keeps real snapshots out.
			list.sort((a, b) => {
				const fa = this.isFutureStamp(a.stamp);
				if (fa !== this.isFutureStamp(b.stamp)) return fa ? 1 : -1;
				return sortStamp(a.stamp) < sortStamp(b.stamp) ? 1 : -1;
			});
			let doomed: typeof list;
			if (kind === "daily") {
				// The age rule can never expire a future stamp, so those are capped by count.
				const real = list.filter((s) => !this.isFutureStamp(s.stamp));
				const future = list.filter((s) => this.isFutureStamp(s.stamp));
				doomed = [...real.filter((s) => dayOf(s.stamp) < cutoff), ...future.slice(OTHER_KEEP)];
			} else {
				doomed = list.slice(kind === "hourly" ? HOURLY_KEEP : OTHER_KEEP);
			}
			for (const s of doomed) await this.fs.remove(s.path);
		}
	}
}
