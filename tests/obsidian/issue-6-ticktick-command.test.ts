// @vitest-environment happy-dom
import { Plugin } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncService } from "../../src/app/SyncService";
import type { Category, SyncLink } from "../../src/domain/types";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { TICKTICK_SECRET_ID } from "../../src/obsidian/tickTickPorts";
import { fakeApp, loadPlugin } from "./fake-vault";

// The sync is wired into the session, and "Sync with TickTick now" is available only
// while the sync is on for this device: the switch on, a token set and a list linked.

interface Cmd {
	id: string;
	name: string;
	hotkeys?: unknown;
	callback?: () => void;
	checkCallback?: (checking: boolean) => boolean;
}

const NOW = "2026-10-01T09:59:00.000Z";
const WORK = "00000000-0000-4000-8000-00000000000a";

function dbText(linked: boolean): string {
	const d = createEmptyDb({ dbId: "db-a", revision: "r-aaaaaaaaaaaa", deviceId: "d-other", now: NOW });
	const categories = new Map(d.categories);
	const work: Category = { id: WORK, name: "Work", icon: null, color: null, nameKey: "work", isInbox: false, sortKey: "V1", createdAt: NOW, modifiedAt: NOW };
	categories.set(WORK, work);
	const link: SyncLink = { kind: "list", logwellId: WORK, ttId: "p-work", ttProjectId: null, etag: null, base: {}, noteBySync: false, lastPulledAt: NOW, modifiedAt: NOW };
	return serializeDb({ ...d, categories, syncLinks: linked ? new Map([[`list:${WORK}`, link]]) : new Map() });
}

async function setup(options: { linked?: boolean; device?: boolean; token?: boolean; minutes?: number } = {}) {
	const commands: Cmd[] = [];
	vi.spyOn(Plugin.prototype, "addCommand").mockImplementation(((c: Cmd) => void commands.push(c)) as never);
	const sync = vi.spyOn(SyncService.prototype, "sync");
	const fake = fakeApp();
	fake.files.set("A.cpbase", dbText(options.linked ?? true));
	if (options.token ?? true) fake.secrets.set(TICKTICK_SECRET_ID, "token");
	if (options.device ?? true) fake.local.set("logwell-ticktick-device-db-a", true);
	const { default: CheckpointPlugin } = await import("../../src/main");
	const loadData = vi.spyOn(CheckpointPlugin.prototype, "loadData").mockResolvedValue({ tickTickPullMinutes: options.minutes ?? 5 });
	const plugin = await loadPlugin(fake, "A.cpbase");
	loadData.mockRestore();
	return { fake, plugin, sync, cmd: commands.find((c) => c.id === "sync-ticktick-now") };
}

let unload: (() => void) | null = null;
afterEach(() => {
	unload?.();
	unload = null;
	vi.restoreAllMocks();
});

describe("Sync with TickTick now (issue #6)", () => {
	it("is registered with its name, a check callback and no hotkey", async () => {
		const { plugin, cmd } = await setup();
		unload = () => plugin.onunload();
		expect(cmd).toMatchObject({ id: "sync-ticktick-now", name: "Sync with TickTick now" });
		expect(cmd!.hotkeys).toBeUndefined();
		expect(cmd!.callback).toBeUndefined();
		expect(typeof cmd!.checkCallback).toBe("function");
	});

	for (const [name, options] of [
		["the device switch is off", { device: false }],
		["no token is set", { token: false }],
		["no list is linked", { linked: false }],
	] as const) {
		it(`is unavailable when ${name}, and nothing syncs on open`, async () => {
			const { plugin, cmd, sync } = await setup(options);
			unload = () => plugin.onunload();
			expect(cmd!.checkCallback!(true)).toBe(false);
			expect(sync).not.toHaveBeenCalled();
		});
	}

	it("is available while sync is on, and runs a sync", async () => {
		const { plugin, cmd, sync } = await setup();
		unload = () => plugin.onunload();
		// The pull when the database opens (always).
		expect(sync).toHaveBeenCalledTimes(1);
		await plugin.session!.sync.idle();
		expect(cmd!.checkCallback!(true)).toBe(true);
		expect(cmd!.checkCallback!(false)).toBe(true);
		await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
		await plugin.session!.sync.idle();
	});

	it("the open session pulls once when it opens, and closing it stops the scheduler", async () => {
		const { plugin, sync } = await setup({ minutes: 5 });
		unload = () => plugin.onunload();
		expect(sync).toHaveBeenCalledTimes(1);
		const session = plugin.session!;
		expect(session.sync).toBeInstanceOf(SyncService);
		const dispose = vi.spyOn(session.tickTick, "dispose");
		await session.sync.idle();
		await plugin.openActiveDatabase();
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(session.tickTick.isActive()).toBe(false);
	});
});
