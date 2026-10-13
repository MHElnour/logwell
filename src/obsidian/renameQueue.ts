import type { App } from "obsidian";
import type { NoteRename, RenameQueuePort } from "../app/ports";
import { loadVersionedLocal } from "./localJson";

/** The key earlier builds saved the queue under, as a bare list; read once and moved to the current key. */
const LEGACY_PREFIX = "checkpoint-pending-renames-";

/**
 * Queued note renames in the vault's local storage, per database, under `logwell-pending-renames-<dbId>` as
 * `{ v: 1, renames }` (the other device-local keys' form). Device-local on purpose: this device saw the rename events.
 * A value that cannot be read is ignored with a warning, never deleted; reading never throws.
 */
export class LocalStorageRenameQueue implements RenameQueuePort {
	constructor(private readonly app: App) {}

	private key(dbId: string): string {
		return `logwell-pending-renames-${dbId}`;
	}

	load(dbId: string): NoteRename[] {
		const stored = loadVersionedLocal(this.app, this.key(dbId), "queued note renames");
		if (stored !== null) {
			const renames = (stored as { renames?: unknown }).renames;
			return Array.isArray(renames) ? renames.filter(isNoteRename) : [];
		}
		return this.moveLegacy(dbId);
	}

	save(dbId: string, renames: readonly NoteRename[]): void {
		this.app.saveLocalStorage(this.key(dbId), renames.length === 0 ? null : { v: 1, renames });
	}

	/** Renames an earlier build saved under the old key: moved to the current key, then the old entry is cleared. */
	private moveLegacy(dbId: string): NoteRename[] {
		let legacy: unknown;
		try {
			legacy = this.app.loadLocalStorage(LEGACY_PREFIX + dbId);
		} catch (err) {
			console.warn("Logwell: could not read the queued note renames.", err);
			return [];
		}
		if (!Array.isArray(legacy)) return [];
		const renames = legacy.filter(isNoteRename);
		// Nothing readable: the entry is left as it is, never deleted.
		if (renames.length === 0) return [];
		try {
			this.save(dbId, renames);
			this.app.saveLocalStorage(LEGACY_PREFIX + dbId, null);
		} catch (err) {
			// Kept where it is; the next load tries again.
			console.warn("Logwell: could not move the queued note renames.", err);
		}
		return renames;
	}
}

function isNoteRename(v: unknown): v is NoteRename {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Record<string, unknown>;
	return typeof r.oldPath === "string" && typeof r.newPath === "string" && typeof r.isFolder === "boolean";
}
