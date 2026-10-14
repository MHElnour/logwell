import type { App } from "obsidian";
import type { NoteRename, RenameQueuePort } from "../app/ports";
import { loadVersionedLocal } from "./localJson";

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
		if (stored === null) return [];
		const renames = (stored as { renames?: unknown }).renames;
		return Array.isArray(renames) ? renames.filter(isNoteRename) : [];
	}

	save(dbId: string, renames: readonly NoteRename[]): void {
		this.app.saveLocalStorage(this.key(dbId), renames.length === 0 ? null : { v: 1, renames });
	}
}

function isNoteRename(v: unknown): v is NoteRename {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Record<string, unknown>;
	return typeof r.oldPath === "string" && typeof r.newPath === "string" && typeof r.isFolder === "boolean";
}
