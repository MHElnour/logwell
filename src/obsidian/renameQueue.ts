import type { App } from "obsidian";
import type { NoteRename, RenameQueuePort } from "../app/ports";

/**
 * Queued note renames in the vault's local storage, per database.
 * Device-local on purpose: this device saw the rename events.
 */
export class LocalStorageRenameQueue implements RenameQueuePort {
	constructor(private readonly app: App) {}

	private key(dbId: string): string {
		return `checkpoint-pending-renames-${dbId}`;
	}

	load(dbId: string): NoteRename[] {
		const v: unknown = this.app.loadLocalStorage(this.key(dbId));
		return Array.isArray(v) ? v.filter(isNoteRename) : [];
	}

	save(dbId: string, renames: readonly NoteRename[]): void {
		this.app.saveLocalStorage(this.key(dbId), renames.length === 0 ? null : renames);
	}
}

function isNoteRename(v: unknown): v is NoteRename {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Record<string, unknown>;
	return typeof r.oldPath === "string" && typeof r.newPath === "string" && typeof r.isFolder === "boolean";
}
