// @vitest-environment happy-dom
import { SecretComponent } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { settle } from "../ui/app-helpers";
import { DEFAULT_SETTINGS } from "../../src/app/settings";
import type { SyncStatus } from "../../src/obsidian/tickTickScheduler";
import { ONE_DEVICE_TEXT, type TickTickSettingsDeps, type TickTickSettingsSession, tickTickSettingItems } from "../../src/obsidian/tickTickSettings";
import { CheckpointSettingTab } from "../../src/obsidian/SettingTab";
import { createEmptyDb } from "../../src/persistence/schema";
import type { DbData } from "../../src/persistence/schema";
import type { Category, SyncLink } from "../../src/domain/types";

// The "TickTick sync" group of the settings tab. The group is data (definitions with render
// callbacks), driven here with a fake Setting that records what a row adds.

const NOW = "2026-10-01T09:59:00.000Z";
const WORK = "00000000-0000-4000-8000-00000000000a";
const HOME = "00000000-0000-4000-8000-00000000000b";

/** The stub's SecretComponent (tests/app/obsidian-stub.ts) keeps what the code under test sets. */
type StubSecret = SecretComponent & { value: string; changed: (value: string) => unknown };

class FakeSetting {
	name = "";
	desc = "";
	buttons: { text: string; disabled: boolean; click: () => void }[] = [];
	toggle: { value: boolean; disabled: boolean; change: (v: boolean) => void } | null = null;
	secret: StubSecret | null = null;
	setName(n: string) {
		this.name = n;
		return this;
	}
	setDesc(d: string) {
		this.desc = d;
		return this;
	}
	addToggle(cb: (t: unknown) => unknown) {
		const state: { value: boolean; disabled: boolean; change: (v: boolean) => void } = { value: false, disabled: false, change: () => undefined };
		this.toggle = state;
		const t = {
			setValue: (v: boolean) => ((state.value = v), t),
			setDisabled: (d: boolean) => ((state.disabled = d), t),
			onChange: (f: (v: boolean) => void) => ((state.change = f), t),
		};
		cb(t);
		return this;
	}
	addButton(cb: (b: unknown) => unknown) {
		const state: { text: string; disabled: boolean; click: () => void } = { text: "", disabled: false, click: () => undefined };
		const b = {
			setButtonText: (x: string) => ((state.text = x), b),
			setDisabled: (d: boolean) => ((state.disabled = d), b),
			onClick: (f: () => void) => ((state.click = f), b),
		};
		cb(b);
		this.buttons.push(state);
		return this;
	}
	addComponent(cb: (el: HTMLElement) => unknown) {
		this.secret = cb(document.createElement("div")) as StubSecret;
		return this;
	}
}

type Row = { name: string; desc?: string; visible?: boolean | (() => boolean); render?: (s: never, g: never) => void; control?: Record<string, unknown> };

function dbState(linked: string[]): DbData {
	const d = createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-1", now: NOW });
	const categories = new Map(d.categories);
	const make = (id: string, name: string): Category => ({ id, name, icon: null, color: null, nameKey: name.toLowerCase(), isInbox: false, sortKey: id, createdAt: NOW, modifiedAt: NOW });
	categories.set(WORK, make(WORK, "Work"));
	categories.set(HOME, make(HOME, "Home"));
	const syncLinks = new Map<string, SyncLink>();
	for (const id of linked) syncLinks.set(`list:${id}`, { kind: "list", logwellId: id, ttId: `p-${id}`, ttProjectId: null, etag: null, base: {}, noteBySync: false, lastPulledAt: null, modifiedAt: NOW });
	return { ...d, categories, syncLinks };
}

function setup(options: { token?: boolean; device?: boolean; session?: boolean; linked?: string[]; status?: SyncStatus; secretId?: string } = {}) {
	let device = options.device ?? false;
	const token = options.token ?? true;
	const status: SyncStatus = options.status ?? { lastSyncAt: null, error: null };
	const tickTick = { status: () => status, refresh: vi.fn(), syncNow: vi.fn(async () => null) };
	const sync = { unlinkList: vi.fn(async () => ({ wrote: true, label: "x" })) };
	const session: TickTickSettingsSession = {
		app: {
			tickTickSecret: { get: () => (token ? "tok" : null) },
			tickTickDevice: { isEnabled: () => device, setEnabled: (on) => void (device = on) },
			store: { state: dbState(options.linked ?? []) },
		},
		tickTick: tickTick,
		sync: sync,
	};
	const saved: [string, string][] = [];
	const notices: string[] = [];
	const refresh = vi.fn();
	const deps: TickTickSettingsDeps = {
		app: {} as never,
		settings: () => ({ ...DEFAULT_SETTINGS, tickTickSecretId: options.secretId ?? "logwell-ticktick-token" }),
		setSetting: async (k, v) => void saved.push([k, v]),
		session: () => (options.session === false ? null : session),
		refresh,
		notify: (m) => notices.push(m),
		error: (e) => void notices.push(`error: ${String(e)}`),
		now: () => Date.parse(NOW) + 2 * 60_000,
	};
	const group = () => tickTickSettingItems(deps)[0] as unknown as { type: string; heading: string; items: Row[] };
	const rows = () => group().items;
	const visible = (r: Row) => (typeof r.visible === "function" ? r.visible() : (r.visible ?? true));
	const shown = () => rows().filter(visible).map((r) => r.name);
	const render = (name: string): FakeSetting => {
		const row = rows().find((r) => r.name === name)!;
		const s = new FakeSetting();
		row.render!(s as never, {} as never);
		return s;
	};
	return { rows, shown, render, saved, notices, refresh, tickTick, sync, device: () => device, status };
}

describe("TickTick sync settings (screens 1 to 3)", () => {
	it("is one group named TickTick sync", () => {
		const t = setup();
		expect(t.rows().length).toBeGreaterThan(0);
		const tab = new CheckpointSettingTab({} as never, {} as never);
		const groups = (tab.getSettingDefinitions() as unknown as { heading?: string }[]).map((g) => g.heading);
		expect(groups).toContain("TickTick sync");
	});

	it("with no token (screen 1): the token field, a disabled switch, a disabled interval and nothing else", () => {
		const t = setup({ token: false });
		expect(t.shown()).toEqual(["TickTick token", "Sync with TickTick on this device", "Pull from TickTick every", "Create notes from TickTick descriptions"]);
		expect(t.render("Sync with TickTick on this device").toggle).toMatchObject({ value: false, disabled: true });
		const interval = t.rows().find((r) => r.name === "Pull from TickTick every")!;
		expect((interval.control!.disabled as () => boolean)()).toBe(true);
		const notes = t.rows().find((r) => r.name === "Create notes from TickTick descriptions")!;
		expect((notes.control!.disabled as () => boolean)()).toBe(true);
	});

	it("has the description-notes switch: a toggle of tickTickNotes, enabled while sync is on, that names the note folder", () => {
		const t = setup({ device: true });
		const row = t.rows().find((r) => r.name === "Create notes from TickTick descriptions")!;
		expect(row.control).toMatchObject({ type: "toggle", key: "tickTickNotes" });
		expect((row.control!.disabled as () => boolean)()).toBe(false);
		expect(row.desc).toContain("description note folder");
	});

	it("the token help says where to find it and that it is kept in secret storage", () => {
		const desc = setup().rows()[0]!.desc!;
		expect(desc).toContain("avatar > Settings > Account > API Token");
		expect(desc).toContain("secret storage");
	});

	it("the token field is Obsidian's secret field; a chosen secret is saved by name and the schedule follows", async () => {
		const t = setup({ secretId: "my-secret" });
		const row = t.render("TickTick token");
		expect(row.secret).toBeInstanceOf(SecretComponent);
		expect(row.secret!.value).toBe("my-secret");
		row.secret!.changed("other-secret");
		await settle();
		expect(t.saved).toEqual([["tickTickSecretId", "other-secret"]]);
		expect(t.tickTick.refresh).toHaveBeenCalled();
		expect(t.refresh).toHaveBeenCalled();
	});

	it("removing the secret saves an empty id (nothing is written to secret storage)", async () => {
		const t = setup();
		t.render("TickTick token").secret!.changed("");
		await settle();
		expect(t.saved).toEqual([["tickTickSecretId", ""]]);
	});

	it("the field shows no secret while the named one is missing", () => {
		expect(setup({ token: false, secretId: "logwell-ticktick-token" }).render("TickTick token").secret!.value).toBe("");
	});

	it("with a token but the device off (screen 2): the switch is enabled and off; status and linked lists are hidden", () => {
		const t = setup({ token: true, device: false });
		expect(t.shown()).toEqual(["TickTick token", "Sync with TickTick on this device", "Pull from TickTick every", "Create notes from TickTick descriptions"]);
		expect(t.render("Sync with TickTick on this device").toggle).toMatchObject({ value: false, disabled: false });
	});

	it("turning the switch on stores it for this device, restarts the schedule and says only one device should sync", () => {
		const t = setup({ token: true, device: false });
		t.render("Sync with TickTick on this device").toggle!.change(true);
		expect(t.device()).toBe(true);
		expect(t.tickTick.refresh).toHaveBeenCalled();
		expect(t.notices).toEqual([ONE_DEVICE_TEXT]);
		expect(ONE_DEVICE_TEXT).toContain("only one device should sync");
		expect(t.refresh).toHaveBeenCalled();
	});

	it("turning it off is silent", () => {
		const t = setup({ token: true, device: true });
		t.render("Sync with TickTick on this device").toggle!.change(false);
		expect(t.device()).toBe(false);
		expect(t.notices).toEqual([]);
	});

	it("without an open database the switch cannot be used", () => {
		const t = setup({ session: false });
		expect(t.render("Sync with TickTick on this device").toggle).toMatchObject({ value: false, disabled: true });
	});

	it("syncing on this device (screen 3): status, the interval, and the linked lists with Unlink, in sidebar order", () => {
		const t = setup({ device: true, linked: [HOME, WORK], status: { lastSyncAt: Date.parse(NOW), error: null } });
		expect(t.shown()).toEqual([
			"TickTick token",
			"Sync with TickTick on this device",
			"Sync status",
			"Pull from TickTick every",
			"Create notes from TickTick descriptions",
			"Linked lists",
			"Work",
			"Home",
		]);
		expect(t.render("Sync status").name).toBe("Synced 2 minutes ago · 2 lists");
	});

	it("the status line before any sync, and with a failure", () => {
		const before = setup({ device: true, linked: [WORK] });
		expect(before.render("Sync status").name).toBe("Not synced yet · 1 list");
		const failed = setup({ device: true, linked: [WORK], status: { lastSyncAt: null, error: "TickTick: server error" } });
		expect(failed.render("Sync status").desc).toBe("The last sync stopped: TickTick: server error");
	});

	it("Sync now runs the sync, is off while it runs and draws the group again after", async () => {
		const t = setup({ device: true, linked: [WORK] });
		const status = t.render("Sync status");
		expect(status.buttons.map((b) => b.text)).toEqual(["Sync now"]);
		status.buttons[0]!.click();
		expect(status.buttons[0]!.disabled).toBe(true);
		await settle();
		expect(t.tickTick.syncNow).toHaveBeenCalledTimes(1);
		expect(t.refresh).toHaveBeenCalled();
	});

	it("the interval is a whole number from 5 to 60 and follows the device switch", () => {
		const t = setup({ device: true });
		const c = t.rows().find((r) => r.name === "Pull from TickTick every")!.control as { min: number; max: number; key: string; disabled: () => boolean; validate: (v: number) => string | undefined };
		expect([c.key, c.min, c.max]).toEqual(["tickTickPullMinutes", 5, 60]);
		expect(c.disabled()).toBe(false);
		expect(c.validate(5)).toBeUndefined();
		expect(c.validate(60)).toBeUndefined();
		for (const bad of [0, 4, 61, 7.5]) expect(c.validate(bad)).toBe("Use a whole number from 5 to 60.");
	});

	it("Unlink removes that list's link, keeps its tasks and says so", async () => {
		const t = setup({ device: true, linked: [WORK] });
		const row = t.render("Work");
		expect(row.buttons.map((b) => b.text)).toEqual(["Unlink"]);
		row.buttons[0]!.click();
		await settle();
		expect(t.sync.unlinkList).toHaveBeenCalledWith(WORK);
		expect(t.notices).toEqual(["Work is no longer synced with TickTick. Its tasks stay on both sides."]);
		expect(t.refresh).toHaveBeenCalled();
	});

	it("#135: Unlink here is the list menu's unlink: a list that was unlinked meanwhile writes nothing and says nothing", async () => {
		const t = setup({ device: true, linked: [WORK] });
		t.sync.unlinkList.mockResolvedValueOnce({ wrote: false, label: "x" });
		t.render("Work").buttons[0]!.click();
		await settle();
		expect(t.sync.unlinkList).toHaveBeenCalledWith(WORK);
		expect(t.notices).toEqual([]);
		expect(t.refresh).toHaveBeenCalled();
	});

	it("the linked lists row carries the limits note", () => {
		const desc = setup({ device: true }).rows().find((r) => r.name === "Linked lists")!.desc!;
		expect(desc).toContain("999 open tasks");
		expect(desc).toContain("9 lists and 99 open tasks per list");
	});
});
