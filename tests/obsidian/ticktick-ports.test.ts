// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { DbSession } from "../../src/obsidian/session";
import { LocalStorageTickTickDevice, SecretStorageTickTickSecret, TICKTICK_SECRET_ID } from "../../src/obsidian/tickTickPorts";
import { emptyDbText } from "../persistence/fixtures";
import { fakeApp, loadPlugin } from "./fake-vault";

// The token lives in Obsidian's secret storage; "Sync with TickTick on this device" lives in
// the vault's local storage, per database. Nothing reads either yet.

function fakeSecrets() {
	const secrets = new Map<string, string>();
	return {
		secrets,
		app: {
			secretStorage: {
				getSecret: (id: string) => secrets.get(id) ?? null,
				setSecret: (id: string, secret: string) => {
					// Obsidian: "Lowercase alphanumeric ID with optional dashes", else it throws.
					if (!/^[a-z0-9-]+$/u.test(id)) throw new Error("invalid id");
					secrets.set(id, secret);
				},
				listSecrets: () => [...secrets.keys()],
			},
		},
	};
}

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

describe("SecretStorageTickTickSecret", () => {
	it("stores the token under a valid secret id and reads it back", () => {
		const f = fakeSecrets();
		const port = new SecretStorageTickTickSecret(f.app);
		expect(port.get()).toBeNull();
		port.set("tok-1");
		expect([...f.secrets.keys()]).toEqual([TICKTICK_SECRET_ID]);
		expect(port.get()).toBe("tok-1");
	});

	it("clear empties the secret, which then reads as no token", () => {
		const f = fakeSecrets();
		const port = new SecretStorageTickTickSecret(f.app);
		port.set("tok-1");
		port.clear();
		expect(port.get()).toBeNull();
	});
});

describe("LocalStorageTickTickDevice", () => {
	it("is off by default and stored per database under logwell-ticktick-device-<dbId>", () => {
		const f = fakeLocal();
		let dbId: string | null = "db-1";
		const port = new LocalStorageTickTickDevice(f.app, () => dbId);
		expect(port.isEnabled()).toBe(false);
		port.setEnabled(true);
		expect([...f.store.entries()]).toEqual([["logwell-ticktick-device-db-1", true]]);
		expect(port.isEnabled()).toBe(true);
		dbId = "db-2";
		expect(port.isEnabled()).toBe(false);
		dbId = "db-1";
		port.setEnabled(false);
		expect(f.store.size).toBe(0);
		expect(port.isEnabled()).toBe(false);
	});

	it("reads an unreadable value as off and leaves it alone", () => {
		const f = fakeLocal();
		f.store.set("logwell-ticktick-device-db-1", "yes");
		const port = new LocalStorageTickTickDevice(f.app, () => "db-1");
		expect(port.isEnabled()).toBe(false);
		expect(f.store.get("logwell-ticktick-device-db-1")).toBe("yes");
	});

	it("with no known database it reads off and turning it on does nothing", () => {
		const f = fakeLocal();
		const port = new LocalStorageTickTickDevice(f.app, () => null);
		expect(port.isEnabled()).toBe(false);
		port.setEnabled(true);
		expect(f.store.size).toBe(0);
		expect(port.isEnabled()).toBe(false);
	});
});

describe("DbSession wiring", () => {
	it("hands the Obsidian ports to the app, keyed by the open database", async () => {
		const fake = fakeApp();
		fake.files.set("A.cpbase", emptyDbText("db-a", "r-aaaaaaaaaaaa"));
		const plugin = await loadPlugin(fake, "A.cpbase");
		const app = plugin.session!.app;
		expect(app.tickTickDevice).toBeInstanceOf(LocalStorageTickTickDevice);
		expect(app.tickTickSecret).toBeInstanceOf(SecretStorageTickTickSecret);
		app.tickTickDevice.setEnabled(true);
		expect(fake.app.loadLocalStorage("logwell-ticktick-device-db-a")).toBe(true);
		app.tickTickSecret.set("tok-1");
		expect(fake.secrets.get(TICKTICK_SECRET_ID)).toBe("tok-1");
	});

	it("before the session's store is open the switch reads off and setEnabled stores nothing", async () => {
		const fake = fakeApp();
		fake.files.set("A.cpbase", emptyDbText("db-a", "r-aaaaaaaaaaaa"));
		fake.files.set("B.cpbase", emptyDbText("db-b", "r-bbbbbbbbbbbb"));
		const plugin = await loadPlugin(fake, "A.cpbase");
		const keysBefore = [...fake.local.keys()].sort();
		const unopened = new DbSession(plugin, "B.cpbase");
		expect(unopened.store.isLoaded).toBe(false);
		const device = unopened.app.tickTickDevice;
		expect(device.isEnabled()).toBe(false);
		device.setEnabled(true);
		expect([...fake.local.keys()].sort()).toEqual(keysBefore);
		expect(device.isEnabled()).toBe(false);
	});
});
