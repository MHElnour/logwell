import type { App } from "obsidian";

/**
 * Reads a `{ v: 1, ... }` value from the vault's local storage. A value that cannot be read, is not
 * JSON, or has another version is dropped with a warning naming `what` and never deleted here (a newer
 * build may own it). Returns null for "nothing usable".
 */
export function loadVersionedLocal(app: Pick<App, "loadLocalStorage">, key: string, what: string): unknown {
	let stored: unknown;
	try {
		stored = app.loadLocalStorage(key);
	} catch (err) {
		console.warn(`Logwell: could not read the ${what}.`, err);
		return null;
	}
	if (stored === null || stored === undefined) return null;
	let value: unknown = stored;
	if (typeof stored === "string") {
		try {
			value = JSON.parse(stored) as unknown;
		} catch {
			console.warn(`Logwell: the stored ${what} is not valid JSON and was ignored.`);
			return null;
		}
	}
	if (typeof value !== "object" || value === null || (value as { v?: unknown }).v !== 1) {
		console.warn(`Logwell: the stored ${what} has an unknown format and was ignored.`);
		return null;
	}
	return value;
}
