// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/app/events";
import { type SyncLink, syncLinkId } from "../../src/domain/types";
import { formatAgo } from "../../src/ui/format";
import type { MenuSpec, TickTickUi } from "../../src/ui/host";
import { linkedList, type SyncHarness, syncHarness } from "../app/sync-harness";
import { contextMenu, menuItem, mountApp, settle, sidebarItem, U1Host } from "./app-helpers";
import { TickTickError } from "../../src/app/ports";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../../src/app/settings";
import { isListSynced, notSyncedReason } from "../../src/app/syncMarks";
import { countPushable, defaultOption, loadLinkOptions } from "../../src/app/tickTickLink";
import { isInboxProjectId } from "../../src/domain/ticktick/inbox";

describe("sync screens", () => {
	// The list menu item, the marker next to a synced list, the line under its title and the
	// "Not synced" chip.

	class SyncHost extends U1Host {
		ready = true;
		last: number | null = null;
		readonly linked: string[] = [];
		readonly unlinked: string[] = [];
		readonly status = new EventBus<{ changed: undefined }>();
		tickTick: TickTickUi = {
			ready: () => this.ready,
			link: async (id) => void this.linked.push(id),
			unlink: async (id) => void this.unlinked.push(id),
			lastSyncAt: () => this.last,
			onStatus: (l) => this.status.on("changed", () => l()),
		};
	}

	async function mount(withSync: boolean) {
		const s = await syncHarness();
		const { host, root } = await mountApp({}, { harness: s.h, host: (h) => (withSync ? new SyncHost(h) : new U1Host(h)) });
		return { s, host: host as SyncHost, root };
	}

	const menuOf = (host: U1Host, root: HTMLElement, name: string) => contextMenu({ host }, sidebarItem(root, name));
	const titles = (menu: MenuSpec) => menu.map((i) => (i === "separator" ? "-" : i.title));
	const row = (root: HTMLElement, title: string) => [...root.querySelectorAll<HTMLElement>(".cp-tasks .cp-task-row")].find((e) => e.textContent?.includes(title))!;
	const repeat = { rule: { freq: "weekly", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null } } as never;

	async function linkedWork(s: SyncHarness) {
		const { listId } = await linkedList(s, "Work");
		await settle();
		return listId;
	}

	describe("list menu (screen 4)", () => {
		it("offers Sync with TickTick… on a list that is not linked, between the editing and the moving items", async () => {
			const { s, host, root } = await mount(true);
			const list = await s.h.app.categories.create("Study");
			await settle();
			const menu = await menuOf(host, root, "Study");
			expect(titles(menu)).toEqual(["Edit", "Change icon…", "Change color…", "-", "Sync with TickTick…", "-", "Move up", "Move down", "-", "Delete"]);
			menuItem(menu, "Sync with TickTick…").run();
			expect(host.linked).toEqual([list.id]);
		});

		it("offers Unlink from TickTick on a linked list", async () => {
			const { s, host, root } = await mount(true);
			const id = await linkedWork(s);
			const menu = await menuOf(host, root, "Work");
			expect(titles(menu)).not.toContain("Sync with TickTick…");
			menuItem(menu, "Unlink from TickTick").run();
			expect(host.unlinked).toEqual([id]);
		});

		it("the Inbox menu has it too", async () => {
			const { host, root } = await mount(true);
			expect(titles(await menuOf(host, root, "Inbox"))).toContain("Sync with TickTick…");
		});

		it("a host without the sync has no TickTick item (the marker still shows the link)", async () => {
			const { s, host, root } = await mount(false);
			await linkedWork(s);
			expect(titles(await menuOf(host, root, "Work"))).toEqual(["Edit", "Change icon…", "Change color…", "Move up", "Move down", "-", "Delete"]);
			expect(root.querySelector(".cp-sync-mark")).not.toBeNull();
		});
	});

	describe("marker and header line (screen 7)", () => {
		it("marks a synced list in the sidebar with a labelled image, and only that list", async () => {
			const { s, root } = await mount(true);
			await s.h.app.categories.create("Study");
			await linkedWork(s);
			const mark = sidebarItem(root, "Work").querySelector(".cp-sync-mark")!;
			expect(mark.getAttribute("role")).toBe("img");
			expect(mark.getAttribute("aria-label")).toBe("Synced with TickTick");
			expect(mark.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("refresh-cw");
			expect(sidebarItem(root, "Study").querySelector(".cp-sync-mark")).toBeNull();
			expect(sidebarItem(root, "Inbox").querySelector(".cp-sync-mark")).toBeNull();
		});

		it("the marker follows an unlink", async () => {
			const { s, root } = await mount(true);
			const id = await linkedWork(s);
			await s.sync.unlinkList(id);
			await settle();
			expect(root.querySelector(".cp-sync-mark")).toBeNull();
		});

		it("shows 'Synced with TickTick · Last sync …' under a synced list's title", async () => {
			const { s, host, root } = await mount(true);
			await linkedWork(s);
			host.last = s.h.clock.now().getTime() - 2 * 60_000;
			sidebarItem(root, "Work").click();
			await settle();
			const line = root.querySelector(".cp-main-header .cp-sync-status")!;
			expect(line.textContent).toBe("Synced with TickTick · Last sync 2 minutes ago");
		});

		it("says only 'Synced with TickTick' before this device has synced", async () => {
			const { s, root } = await mount(true);
			await linkedWork(s);
			sidebarItem(root, "Work").click();
			await settle();
			expect(root.querySelector(".cp-sync-status")!.textContent).toBe("Synced with TickTick");
		});

		it("says so when this device does not sync", async () => {
			const { s, host, root } = await mount(true);
			await linkedWork(s);
			host.ready = false;
			sidebarItem(root, "Work").click();
			await settle();
			expect(root.querySelector(".cp-sync-status")!.textContent).toBe("Linked to TickTick · sync is off on this device");
		});

		it("updates after a sync of this device", async () => {
			const { s, host, root } = await mount(true);
			await linkedWork(s);
			sidebarItem(root, "Work").click();
			await settle();
			host.last = s.h.clock.now().getTime() - 5 * 60_000;
			host.status.emit("changed", undefined);
			await settle();
			expect(root.querySelector(".cp-sync-status")!.textContent).toContain("Last sync 5 minutes ago");
		});

		it("redraws when the device switch or the token changes (the scheduler announces it)", async () => {
			const { s, host, root } = await mount(true);
			await linkedWork(s);
			host.ready = false;
			sidebarItem(root, "Work").click();
			await settle();
			expect(root.querySelector(".cp-sync-status")!.textContent).toBe("Linked to TickTick · sync is off on this device");
			host.ready = true;
			host.status.emit("changed", undefined);
			await settle();
			expect(root.querySelector(".cp-sync-status")!.textContent).toBe("Synced with TickTick");
		});

		it("stops its minute timer when it goes away, on the element's own window", async () => {
			const { s, root } = await mount(true);
			await linkedWork(s);
			const win = root.ownerDocument.defaultView!;
			const set = vi.spyOn(win, "setInterval");
			const clear = vi.spyOn(win, "clearInterval");
			sidebarItem(root, "Work").click();
			await settle();
			await new Promise((r) => setTimeout(r, 120));
			expect(set).toHaveBeenCalledWith(expect.any(Function), 60_000);
			sidebarItem(root, "Inbox").click();
			await settle();
			await new Promise((r) => setTimeout(r, 120));
			expect(clear).toHaveBeenCalled();
		});

		it("has no line on a list that is not linked, on the Inbox, or without the sync", async () => {
			const { s, root } = await mount(true);
			await s.h.app.categories.create("Study");
			await settle();
			sidebarItem(root, "Study").click();
			await settle();
			expect(root.querySelector(".cp-sync-status")).toBeNull();
			sidebarItem(root, "Inbox").click();
			await settle();
			expect(root.querySelector(".cp-sync-status")).toBeNull();
		});

		it("no line for a host without the sync", async () => {
			const { s, root } = await mount(false);
			await linkedWork(s);
			sidebarItem(root, "Work").click();
			await settle();
			expect(root.querySelector(".cp-sync-status")).toBeNull();
		});

		it("formats how long ago", () => {
			const now = Date.parse("2026-10-01T10:00:00Z");
			expect([0, 30_000, 60_000, 59 * 60_000, 60 * 60_000, 25 * 3_600_000, 2 * 86_400_000].map((ago) => formatAgo(now - ago, now))).toEqual([
				"just now",
				"just now",
				"1 minute ago",
				"59 minutes ago",
				"1 hour ago",
				"1 day ago",
				"2 days ago",
			]);
			expect(formatAgo(now + 5_000, now)).toBe("just now");
		});
	});

	describe("Not synced chip (SYNC-06, SYNC-08)", () => {
		const chip = (root: HTMLElement, title: string) => row(root, title).querySelector<HTMLElement>(".cp-meta-notsynced");

		it("marks a repeating task of a synced list, not a plain one", async () => {
			const { s, root } = await mount(true);
			const id = await linkedWork(s);
			await s.h.app.tasks.create({ title: "Take out the trash", categoryId: id, repeat });
			await s.h.app.tasks.create({ title: "Call the bank", categoryId: id });
			sidebarItem(root, "Work").click();
			await settle();
			expect(chip(root, "Take out the trash")!.textContent).toBe("Not synced");
			expect(chip(root, "Take out the trash")!.getAttribute("title")).toBe("Repeating tasks are not synced with TickTick");
			expect(chip(root, "Call the bank")).toBeNull();
		});

		it("marks a task kept in Logwell only, with its own tooltip, as soon as its link changes", async () => {
			const { s, root } = await mount(true);
			const id = await linkedWork(s);
			const ids: string[] = [];
			for (let i = 1; i <= 5; i++) ids.push((await s.h.app.tasks.create({ title: `Errand ${i}`, categoryId: id })).task.id);
			await s.sync.sync();
			sidebarItem(root, "Work").click();
			await settle();
			expect(chip(root, "Errand 1")).toBeNull();
			await s.sync.keepMissing(id, ids.slice(0, 2), "many");
			await settle();
			expect(chip(root, "Errand 1")!.getAttribute("title")).toBe("Kept in Logwell only, not synced with TickTick");
			expect(chip(root, "Errand 2")).not.toBeNull();
			expect(chip(root, "Errand 3")).toBeNull();
		});

		it("marks a task whose link is excluded (it repeats in TickTick)", async () => {
			const { s, root } = await mount(true);
			const id = await linkedWork(s);
			const { task } = await s.h.app.tasks.create({ title: "Water the plants", categoryId: id });
			await s.sync.sync();
			const link = s.h.app.store.state.syncLinks.get(syncLinkId("task", task.id))!;
			await s.h.app.store.run("test links", (tx) => void tx.put("syncLinks", { ...link, mode: "excluded", modifiedAt: tx.now }), { undoable: false });
			sidebarItem(root, "Work").click();
			await settle();
			expect(chip(root, "Water the plants")!.getAttribute("title")).toBe("This task repeats in TickTick, so it is not synced");
		});

		it("shows nothing in a list that is not synced, nor for a host without the sync", async () => {
			const { s, root } = await mount(true);
			const list = await s.h.app.categories.create("Study");
			await s.h.app.tasks.create({ title: "Weekly review", categoryId: list.id, repeat });
			await settle();
			sidebarItem(root, "Study").click();
			await settle();
			expect(chip(root, "Weekly review")).toBeNull();
			expect(row(root, "Weekly review").querySelector(".cp-meta-repeat")).not.toBeNull();
		});

		it("#135: a board card shows the mark as the row does, as soon as its link changes", async () => {
			const { s, root } = await mount(true);
			const id = await linkedWork(s);
			const { task } = await s.h.app.tasks.create({ title: "Water the plants", categoryId: id });
			await s.sync.sync();
			sidebarItem(root, "Work").click();
			await settle();
			[...root.querySelectorAll<HTMLElement>(".cp-tasks .cp-mode-button")].find((b) => b.textContent?.trim() === "Board")!.click();
			await settle();
			const cardChip = () =>
				[...root.querySelectorAll<HTMLElement>(".cp-board-item")]
					.find((c) => c.querySelector(".cp-board-title")?.textContent?.trim() === "Water the plants")!
					.querySelector<HTMLElement>(".cp-meta-notsynced");
			expect(cardChip()).toBeNull();
			const link = s.h.app.store.state.syncLinks.get(syncLinkId("task", task.id))!;
			await s.h.app.store.run("test links", (tx) => void tx.put("syncLinks", { ...link, mode: "localOnly", modifiedAt: tx.now }), { undoable: false });
			await settle();
			expect(cardChip()!.getAttribute("title")).toBe("Kept in Logwell only, not synced with TickTick");
		});

		it("is not drawn for a completed task", async () => {
			const { s, root } = await mount(true);
			const id = await linkedWork(s);
			const { task } = await s.h.app.tasks.create({ title: "Old", categoryId: id });
			await s.sync.sync();
			const link = s.h.app.store.state.syncLinks.get(syncLinkId("task", task.id))!;
			await s.h.app.store.run("test links", (tx) => void tx.put("syncLinks", { ...link, mode: "localOnly", modifiedAt: tx.now }), { undoable: false });
			await s.h.app.tasks.complete(task.id);
			sidebarItem(root, "Work").click();
			await settle();
			expect(root.querySelectorAll(".cp-meta-notsynced")).toHaveLength(0);
		});
	});
});

describe("sync screen logic", () => {
	// The logic behind the sync screens that needs no DOM: the secret id setting, what marks a list or a task
	// as (not) synced, and the options of the link dialog.

	describe("the TickTick secret id setting", () => {
		it("defaults to the plugin's secret and keeps a valid id or an empty one", () => {
			expect(DEFAULT_SETTINGS.tickTickSecretId).toBe("logwell-ticktick-token");
			expect(sanitizeSettings({}).tickTickSecretId).toBe("logwell-ticktick-token");
			expect(sanitizeSettings({ tickTickSecretId: "my-ticktick-2" }).tickTickSecretId).toBe("my-ticktick-2");
			expect(sanitizeSettings({ tickTickSecretId: "" }).tickTickSecretId).toBe("");
		});

		it.each(["Has Upper", "a b", "-lead", "trail-", "dou--ble", "ünï", 5, null])("falls back to the default for %s", (bad) => {
			expect(sanitizeSettings({ tickTickSecretId: bad }).tickTickSecretId).toBe("logwell-ticktick-token");
		});
	});

	function link(kind: SyncLink["kind"], id: string, mode?: SyncLink["mode"]): [string, SyncLink] {
		return [syncLinkId(kind, id), { kind, logwellId: id, ttId: `tt-${id}`, ttProjectId: null, etag: null, base: {}, noteBySync: false, lastPulledAt: null, modifiedAt: "x", ...(mode === undefined ? {} : { mode }) }];
	}

	describe("sync marks", () => {
		const task = (over: Partial<{ id: string; categoryId: string; status: "open" | "completed"; recurrence: object | null }> = {}) =>
			({ id: "t1", categoryId: "L", status: "open", recurrence: null, ...over }) as never;

		it("a list is synced when it has a list link", () => {
			expect(isListSynced(new Map([link("list", "L")]), "L")).toBe(true);
			expect(isListSynced(new Map([link("list", "L")]), "M")).toBe(false);
			expect(isListSynced(new Map([link("task", "L")]), "L")).toBe(false);
		});

		it("an open repeating task of a synced list is Not synced; a plain one is not", () => {
			const links = new Map([link("list", "L")]);
			expect(notSyncedReason(links, task({ recurrence: {} }))).toBe("repeats");
			expect(notSyncedReason(links, task())).toBeNull();
		});

		it("excluded and localOnly links mark the task; a sync-mode link does not", () => {
			const base = [link("list", "L")];
			expect(notSyncedReason(new Map([...base, link("task", "t1", "excluded")]), task())).toBe("excluded");
			expect(notSyncedReason(new Map([...base, link("task", "t1", "localOnly")]), task())).toBe("kept");
			expect(notSyncedReason(new Map([...base, link("task", "t1", "sync")]), task())).toBeNull();
			expect(notSyncedReason(new Map([...base, link("task", "t1")]), task())).toBeNull();
		});

		it("nothing is marked outside a synced list, for a completed task or without links", () => {
			const links = new Map([link("list", "L"), link("task", "t1", "localOnly")]);
			expect(notSyncedReason(links, task({ categoryId: "M", recurrence: {} }))).toBeNull();
			expect(notSyncedReason(links, task({ status: "completed" }))).toBeNull();
			expect(notSyncedReason(new Map(), task({ recurrence: {} }))).toBeNull();
		});
	});

	describe("link dialog options", () => {
		async function setup() {
			const s = await syncHarness();
			const work = await s.h.app.categories.create("Work");
			return { s, work };
		}
		const load = (s: SyncHarness, listId: string, state = s.h.app.store.state) => loadLinkOptions(s.tt, state, listId);

		it("offers create first, then the Inbox under its alias, then the projects", async () => {
			const { s, work } = await setup();
			s.tt.addProject("Exercise");
			s.tt.addProject("Study");
			const options = await load(s, work.id);
			expect(options.map((o) => [o.label, o.detail, o.disabled])).toEqual([
				["Create “Work” in TickTick", "new, empty", false],
				["Inbox", "", false],
				["Exercise", "", false],
				["Study", "", false],
			]);
			expect(options[1]!.target).toEqual({ kind: "existing", projectId: "inbox", name: "Inbox" });
			expect(options[0]!.target).toEqual({ kind: "create", name: "Work" });
		});

		it("makes no request for the Inbox, so it is linkable when empty or unreadable", async () => {
			const { s, work } = await setup();
			await load(s, work.id);
			expect(s.tt.calls).toEqual(["listProjects"]);
		});

		it("greys out a note list and a project another list is already linked to", async () => {
			const { s, work } = await setup();
			s.tt.addProject("Reading notes", "NOTE");
			const { listId } = await linkedList(s, "Home");
			expect(listId).not.toBe(work.id);
			const options = await load(s, work.id);
			const byLabel = (l: string) => options.find((o) => o.label === l)!;
			expect(byLabel("Reading notes")).toMatchObject({ detail: "Note list: can't sync", disabled: true });
			expect(byLabel("Home")).toMatchObject({ detail: "Linked to Home", disabled: true });
		});

		it.each(["inbox", "inbox121212"])("greys out the Inbox when a list is linked to it (%s), and leaves out closed projects", async (ttId) => {
			const { s, work } = await setup();
			const archived = s.tt.addProject("Old");
			archived.closed = true;
			const links = new Map(s.h.app.store.state.syncLinks);
			links.set(syncLinkId("list", "x"), { ...link("list", "x")[1], ttId });
			const options = await load(s, work.id, { ...s.h.app.store.state, syncLinks: links });
			expect(options.find((o) => o.label === "Inbox")).toMatchObject({ disabled: true });
			expect(options.map((o) => o.label)).not.toContain("Old");
		});

		it("never lists a project that is the Inbox under its real id", async () => {
			const { s, work } = await setup();
			s.tt.projects.set("inbox77", { id: "inbox77", name: "Inbox" });
			expect((await load(s, work.id)).filter((o) => o.label === "Inbox")).toHaveLength(1);
		});

		it("a failing project list rejects with its error", async () => {
			const { s, work } = await setup();
			s.tt.fail("listProjects", new TickTickError("unauthorized", "TickTick: the API token was refused"));
			await expect(load(s, work.id)).rejects.toThrow("the API token was refused");
		});

		it("starts on the project named like the list, else on creating one", async () => {
			const { s, work } = await setup();
			s.tt.addProject("work");
			let options = await load(s, work.id);
			expect(defaultOption(options, "Work")?.label).toBe("work");
			options = options.map((o) => (o.label === "work" ? { ...o, disabled: true } : o));
			expect(defaultOption(options, "Work")?.key).toBe("create");
		});

		it("counts the open, non-repeating tasks a first sync sends", async () => {
			const { s, work } = await setup();
			await s.h.app.tasks.create({ title: "A", categoryId: work.id });
			await s.h.app.tasks.create({ title: "B", categoryId: work.id });
			const done = await s.h.app.tasks.create({ title: "C", categoryId: work.id });
			await s.h.app.tasks.complete(done.task.id);
			await s.h.app.tasks.create({
				title: "Weekly",
				categoryId: work.id,
				repeat: { rule: { freq: "weekly", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null } },
			});
			expect(countPushable(s.h.app.store.state, s.h.app.tasks.lists, work.id)).toBe(2);
		});
	});

	describe("isInboxProjectId", () => {
		it.each([["inbox", true], ["inbox121212", true], ["inbox", true], ["Inbox", false], ["inbox-1", false], ["inboxx1", false], ["xinbox1", false], ["inbox1a", false], ["", false], ["6ac694f38f08", false]])("%s is %s", (id, expected) => {
			expect(isInboxProjectId(id)).toBe(expected);
		});
	});
});
