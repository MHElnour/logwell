import type { App } from "obsidian";
import type { ReminderStatePort } from "../app/ports";
import type { ReminderState } from "../domain/habitReminders";
import { loadVersionedLocal } from "./localJson";

/**
 * The habit reminder state (fired, snoozed, the times last seen) in the vault's local storage,
 * per database. Device-local on purpose: every open device reminds on its own.
 * Modeled on LocalStorageActiveTimer: an unreadable value or another version is ignored with a warning
 * and never deleted here (a newer build may own it); the next save overwrites it.
 */
export class LocalStorageReminderState implements ReminderStatePort {
	constructor(private readonly app: Pick<App, "loadLocalStorage" | "saveLocalStorage">) {}

	private key(dbId: string): string {
		return `logwell-habit-reminders-${dbId}`;
	}

	load(dbId: string): unknown {
		return loadVersionedLocal(this.app, this.key(dbId), "habit reminder state");
	}

	/**
	 * null removes the entry (Obsidian's `saveLocalStorage` removes a key saved as null). A storage that
	 * fails throws: the host keeps its state in memory and logs the failure once per attach.
	 */
	save(dbId: string, state: ReminderState | null): void {
		this.app.saveLocalStorage(this.key(dbId), state);
	}
}
