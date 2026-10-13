import type { App } from "obsidian";
import type { ActiveTimer } from "../domain/focus";
import type { ActiveTimerPort } from "../app/ports";
import { loadVersionedLocal } from "./localJson";
import { actionNotice } from "./notices";

/**
 * The running focus timer in the vault's local storage, per database. Device-local on purpose:
 * only this device knows the timer is running. An unreadable value is dropped with a warning; it is
 * never deleted here (a newer build may own it), the next start overwrites it.
 */
export class LocalStorageActiveTimer implements ActiveTimerPort {
	/** A failed save is told once per session; the timer keeps running in memory. */
	private saveFailed = false;

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
			if (this.saveFailed) return;
			this.saveFailed = true;
			const message = err instanceof Error ? err.message : String(err);
			actionNotice(`The focus timer could not be saved on this device: ${message} It keeps running, but if Obsidian restarts the current round is lost.`, []);
		}
	}
}
