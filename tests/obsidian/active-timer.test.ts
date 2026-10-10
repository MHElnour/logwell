import { describe, expect, it, vi } from "vitest";
import { startSet } from "../../src/domain/focus";
import { LocalStorageActiveTimer } from "../../src/obsidian/activeTimer";

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

const config = { rounds: 4, focusSec: 1500, breakSec: 300, longBreakSec: 900 };
const timer = () => startSet(config, null, "2026-10-04T10:00:00.000Z", () => "s-1").timer!;

describe("LocalStorageActiveTimer (D11)", () => {
	it("stores the timer under logwell-active-timer-<dbId> and reads it back", () => {
		const f = fakeLocal();
		const port = new LocalStorageActiveTimer(f.app as never);
		port.save("db-1", timer());
		expect([...f.store.keys()]).toEqual(["logwell-active-timer-db-1"]);
		expect(port.load("db-1")).toEqual(JSON.parse(JSON.stringify(timer())));
	});

	it("null clears the entry", () => {
		const f = fakeLocal();
		const port = new LocalStorageActiveTimer(f.app as never);
		port.save("db-1", timer());
		port.save("db-1", null);
		expect(f.store.size).toBe(0);
		expect(port.load("db-1")).toBeNull();
	});

	it("is per database", () => {
		const f = fakeLocal();
		const port = new LocalStorageActiveTimer(f.app as never);
		port.save("db-1", timer());
		expect(port.load("db-2")).toBeNull();
	});

	it("drops bad JSON with a console warning and no throw", () => {
		const f = fakeLocal();
		f.store.set("logwell-active-timer-db-1", "{not json");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(new LocalStorageActiveTimer(f.app as never).load("db-1")).toBeNull();
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it("drops a value with a wrong version with a console warning", () => {
		const f = fakeLocal();
		f.store.set("logwell-active-timer-db-1", { ...timer(), v: 2 });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(new LocalStorageActiveTimer(f.app as never).load("db-1")).toBeNull();
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it("drops a value that is not an object", () => {
		const f = fakeLocal();
		f.store.set("logwell-active-timer-db-1", 42);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(new LocalStorageActiveTimer(f.app as never).load("db-1")).toBeNull();
		warn.mockRestore();
	});

	it("a throwing localStorage does not throw", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const port = new LocalStorageActiveTimer({
			loadLocalStorage: () => {
				throw new Error("denied");
			},
			saveLocalStorage: () => {
				throw new Error("full");
			},
		} as never);
		expect(port.load("db-1")).toBeNull();
		expect(() => port.save("db-1", timer())).not.toThrow();
		warn.mockRestore();
	});
});
