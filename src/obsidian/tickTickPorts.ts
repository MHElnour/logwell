import type { App, SecretStorage } from "obsidian";
import type { TickTickDevicePort, TickTickPending, TickTickPendingPort, TickTickSecretPort } from "../app/ports";
import { loadVersionedLocal } from "./localJson";
import { TICKTICK_DEFAULT_SECRET_ID } from "../app/settings";

// Where the TickTick token and this device's sync switch live. The session's sync reads them.

/** Obsidian secret ids are lowercase letters, digits and dashes. One token per vault. */
export const TICKTICK_SECRET_ID = TICKTICK_DEFAULT_SECRET_ID;

/**
 * The token in Obsidian's secret storage (1.11.4+), never in the database or `data.json`. The secret's id is the
 * `tickTickSecretId` setting: Obsidian's secret field (`SecretComponent`) lets the user pick or create a secret and
 * hands back its name. An empty id reads as no token. The settings screen never calls `set` or `clear`: removing the
 * token there clears the id (the storage has no delete), so the unverified `setSecret(id, "")` is not relied on.
 */
export class SecretStorageTickTickSecret implements TickTickSecretPort {
	constructor(
		private readonly app: { secretStorage: Pick<SecretStorage, "getSecret" | "setSecret"> },
		private readonly secretId: () => string = () => TICKTICK_SECRET_ID,
	) {}

	get(): string | null {
		const id = this.secretId();
		if (id === "") return null;
		const v: unknown = this.app.secretStorage.getSecret(id);
		return typeof v === "string" && v.length > 0 ? v : null;
	}

	set(token: string): void {
		const id = this.secretId();
		if (id !== "") this.app.secretStorage.setSecret(id, token);
	}

	clear(): void {
		const id = this.secretId();
		if (id !== "") this.app.secretStorage.setSecret(id, "");
	}
}

/**
 * "Sync with TickTick on this device" in the vault's local storage, per database
 * (`logwell-ticktick-device-<dbId>`). Only `true` reads as on; anything else is off and left alone. Turning
 * it off removes the entry. `dbId` is null while no real database is open: then it reads off and
 * `setEnabled` does nothing.
 */
export class LocalStorageTickTickDevice implements TickTickDevicePort {
	constructor(
		private readonly app: Pick<App, "loadLocalStorage" | "saveLocalStorage">,
		private readonly dbId: () => string | null,
	) {}

	private key(): string | null {
		const id = this.dbId();
		return id === null ? null : `logwell-ticktick-device-${id}`;
	}

	isEnabled(): boolean {
		const key = this.key();
		return key !== null && this.app.loadLocalStorage(key) === true;
	}

	setEnabled(on: boolean): void {
		const key = this.key();
		if (key === null) return;
		this.app.saveLocalStorage(key, on ? true : null);
	}
}

/**
 * The tasks the sync created in TickTick and has not linked yet, in the vault's local storage per database
 * (`logwell-ticktick-pending-<dbId>`), so a restart neither sends them again nor imports their copies. An unreadable
 * value or another version is ignored with a warning and never deleted here; the next save overwrites it.
 */
export class LocalStorageTickTickPending implements TickTickPendingPort {
	constructor(private readonly app: Pick<App, "loadLocalStorage" | "saveLocalStorage">) {}

	private key(dbId: string): string {
		return `logwell-ticktick-pending-${dbId}`;
	}

	load(dbId: string): unknown {
		return loadVersionedLocal(this.app, this.key(dbId), "TickTick tasks waiting to be linked");
	}

	/** null removes the entry. */
	save(dbId: string, pending: TickTickPending | null): void {
		this.app.saveLocalStorage(this.key(dbId), pending);
	}
}
