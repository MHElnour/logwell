import type { App } from "obsidian";
import type { ActiveTimer } from "../domain/focus";
import type { ActiveTimerPort } from "../app/ports";
import { loadVersionedLocal } from "./localJson";

/**
 * The running focus timer in the vault's local storage, per database. Device-local on purpose:
 * only this device knows the timer is running. An unreadable value is dropped with a warning; it is
 * never deleted here (a newer build may own it), the next start overwrites it.
 */
export class LocalStorageActiveTimer implements ActiveTimerPort {
	constructor(private readonly app: App) {}

	private key(dbId: string): string {
		return `logwell-active-timer-${dbId}`;
	}

	load(dbId: string): unknown {
		return loadVersionedLocal(this.app, this.key(dbId), "focus timer");
	}

	save(dbId: string, timer: ActiveTimer | null): void {
		try {
			this.app.saveLocalStorage(this.key(dbId), timer);
		} catch (err) {
			console.warn("Logwell: could not save the focus timer.", err);
		}
	}
}
