import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyReminderState, parseReminderState } from "../../src/domain/habitReminders";
import { LocalStorageReminderState } from "../../src/obsidian/reminderState";

// The habit reminder state in the vault's local storage, per database (modeled on activeTimer).

function fakeLocal() {
	const store = new Map<string, unknown>();
	return {
		store,
		app: {
			loadLocalStorage: (k: string) => store.get(k) ?? null,
			saveLocalStorage: (k: string, v: unknown) => void (v === null ? store.delete(k) : store.set(k, v)),
		},
	};
}

const state = () => ({ ...emptyReminderState("2026-10-14"), fired: { "h-1": true as const }, times: { "h-1": "20:00" } });

afterEach(() => vi.restoreAllMocks());

describe("LocalStorageReminderState (D10)", () => {
	it("stores the state under logwell-habit-reminders-<dbId> with v 1 and reads it back", () => {
		const f = fakeLocal();
		const port = new LocalStorageReminderState(f.app);
		port.save("db-1", state());
		expect([...f.store.keys()]).toEqual(["logwell-habit-reminders-db-1"]);
		const back = port.load("db-1");
		expect((back as { v: number }).v).toBe(1);
		expect(parseReminderState(back)).toEqual(state());
	});

	it("is per database", () => {
		const f = fakeLocal();
		const port = new LocalStorageReminderState(f.app);
		port.save("db-1", state());
		expect(port.load("db-2")).toBeNull();
	});

	it("null clears the entry", () => {
		const f = fakeLocal();
		const port = new LocalStorageReminderState(f.app);
		port.save("db-1", state());
		port.save("db-1", null);
		expect(f.store.size).toBe(0);
		expect(port.load("db-1")).toBeNull();
	});

	it("reads a value stored as JSON text", () => {
		const f = fakeLocal();
		f.store.set("logwell-habit-reminders-db-1", JSON.stringify(state()));
		const port = new LocalStorageReminderState(f.app);
		expect(parseReminderState(port.load("db-1"))).toEqual(state());
	});

	it("ignores bad JSON with a warning and never deletes it", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const f = fakeLocal();
		f.store.set("logwell-habit-reminders-db-1", "{not json");
		const port = new LocalStorageReminderState(f.app);
		expect(port.load("db-1")).toBeNull();
		expect(warn).toHaveBeenCalled();
		expect(f.store.get("logwell-habit-reminders-db-1")).toBe("{not json");
	});

	it("ignores another version (a newer build may own it) and never deletes it", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const f = fakeLocal();
		const newer = { v: 2, whatever: true };
		f.store.set("logwell-habit-reminders-db-1", newer);
		const port = new LocalStorageReminderState(f.app);
		expect(port.load("db-1")).toBeNull();
		expect(warn).toHaveBeenCalled();
		expect(f.store.get("logwell-habit-reminders-db-1")).toBe(newer);
	});

	it("a storage that cannot be read is reported with a warning; a failing save throws for the host to log once (review #2)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const app = {
			loadLocalStorage: () => {
				throw new Error("blocked");
			},
			saveLocalStorage: () => {
				throw new Error("full");
			},
		};
		const port = new LocalStorageReminderState(app);
		expect(port.load("db-1")).toBeNull();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(() => port.save("db-1", state())).toThrow("full");
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
