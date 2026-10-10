// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/app/events";
import { syncLinkId } from "../../src/domain/types";
import { AppRoot } from "../../src/ui/AppRoot";
import { formatAgo } from "../../src/ui/format";
import type { TickTickUi } from "../../src/ui/host";
import { type SyncHarness, linkedList, syncHarness } from "../app/sync-harness";
import { U1Host, menuItem, settle } from "./u1-helpers";

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

let unmount: (() => void) | null = null;
afterEach(() => {
	unmount?.();
	unmount = null;
});

async function mount(withSync: boolean) {
	(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
	const s = await syncHarness();
	const host = withSync ? new SyncHost(s.h) : new U1Host(s.h);
	const root = document.createElement("div");
	document.body.appendChild(root);
	render(<AppRoot host={host} initialSection={null} handle={() => undefined} />, root);
	await settle();
	unmount = () => {
		render(null, root);
		root.remove();
	};
	return { s, host: host as SyncHost, root };
}

const side = (root: HTMLElement, name: string) => [...root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes(name))!;
const menuOf = (host: U1Host, root: HTMLElement, name: string) => {
	side(root, name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	return host.menus.at(-1)!;
};
const titles = (menu: ReturnType<typeof menuOf>) => menu.map((i) => (i === "separator" ? "-" : i.title));
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
		const menu = menuOf(host, root, "Study");
		expect(titles(menu)).toEqual(["Edit", "Change icon…", "Change color…", "-", "Sync with TickTick…", "-", "Move up", "Move down", "-", "Delete"]);
		menuItem(menu, "Sync with TickTick…").run();
		expect(host.linked).toEqual([list.id]);
	});

	it("offers Unlink from TickTick on a linked list", async () => {
		const { s, host, root } = await mount(true);
		const id = await linkedWork(s);
		const menu = menuOf(host, root, "Work");
		expect(titles(menu)).not.toContain("Sync with TickTick…");
		menuItem(menu, "Unlink from TickTick").run();
		expect(host.unlinked).toEqual([id]);
	});

	it("the Inbox menu has it too", async () => {
		const { host, root } = await mount(true);
		expect(titles(menuOf(host, root, "Inbox"))).toContain("Sync with TickTick…");
	});

	it("a host without the sync has no TickTick item (the marker still shows the link)", async () => {
		const { s, host, root } = await mount(false);
		await linkedWork(s);
		expect(titles(menuOf(host, root, "Work"))).toEqual(["Edit", "Change icon…", "Change color…", "Move up", "Move down", "-", "Delete"]);
		expect(root.querySelector(".cp-sync-mark")).not.toBeNull();
	});
});

describe("marker and header line (screen 7)", () => {
	it("marks a synced list in the sidebar with a labelled image, and only that list", async () => {
		const { s, root } = await mount(true);
		await s.h.app.categories.create("Study");
		await linkedWork(s);
		const mark = side(root, "Work").querySelector(".cp-sync-mark")!;
		expect(mark.getAttribute("role")).toBe("img");
		expect(mark.getAttribute("aria-label")).toBe("Synced with TickTick");
		expect(mark.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("refresh-cw");
		expect(side(root, "Study").querySelector(".cp-sync-mark")).toBeNull();
		expect(side(root, "Inbox").querySelector(".cp-sync-mark")).toBeNull();
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
		side(root, "Work").click();
		await settle();
		const line = root.querySelector(".cp-main-header .cp-sync-status")!;
		expect(line.textContent).toBe("Synced with TickTick · Last sync 2 minutes ago");
	});

	it("says only 'Synced with TickTick' before this device has synced", async () => {
		const { s, root } = await mount(true);
		await linkedWork(s);
		side(root, "Work").click();
		await settle();
		expect(root.querySelector(".cp-sync-status")!.textContent).toBe("Synced with TickTick");
	});

	it("says so when this device does not sync", async () => {
		const { s, host, root } = await mount(true);
		await linkedWork(s);
		host.ready = false;
		side(root, "Work").click();
		await settle();
		expect(root.querySelector(".cp-sync-status")!.textContent).toBe("Linked to TickTick · sync is off on this device");
	});

	it("updates after a sync of this device", async () => {
		const { s, host, root } = await mount(true);
		await linkedWork(s);
		side(root, "Work").click();
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
		side(root, "Work").click();
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
		side(root, "Work").click();
		await settle();
		await new Promise((r) => setTimeout(r, 120));
		expect(set).toHaveBeenCalledWith(expect.any(Function), 60_000);
		side(root, "Inbox").click();
		await settle();
		await new Promise((r) => setTimeout(r, 120));
		expect(clear).toHaveBeenCalled();
	});

	it("has no line on a list that is not linked, on the Inbox, or without the sync", async () => {
		const { s, root } = await mount(true);
		await s.h.app.categories.create("Study");
		await settle();
		side(root, "Study").click();
		await settle();
		expect(root.querySelector(".cp-sync-status")).toBeNull();
		side(root, "Inbox").click();
		await settle();
		expect(root.querySelector(".cp-sync-status")).toBeNull();
	});

	it("no line for a host without the sync", async () => {
		const { s, root } = await mount(false);
		await linkedWork(s);
		side(root, "Work").click();
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
		side(root, "Work").click();
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
		side(root, "Work").click();
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
		side(root, "Work").click();
		await settle();
		expect(chip(root, "Water the plants")!.getAttribute("title")).toBe("This task repeats in TickTick, so it is not synced");
	});

	it("shows nothing in a list that is not synced, nor for a host without the sync", async () => {
		const { s, root } = await mount(true);
		const list = await s.h.app.categories.create("Study");
		await s.h.app.tasks.create({ title: "Weekly review", categoryId: list.id, repeat });
		await settle();
		side(root, "Study").click();
		await settle();
		expect(chip(root, "Weekly review")).toBeNull();
		expect(row(root, "Weekly review").querySelector(".cp-meta-repeat")).not.toBeNull();
	});

	it("is not drawn for a completed task", async () => {
		const { s, root } = await mount(true);
		const id = await linkedWork(s);
		const { task } = await s.h.app.tasks.create({ title: "Old", categoryId: id });
		await s.sync.sync();
		const link = s.h.app.store.state.syncLinks.get(syncLinkId("task", task.id))!;
		await s.h.app.store.run("test links", (tx) => void tx.put("syncLinks", { ...link, mode: "localOnly", modifiedAt: tx.now }), { undoable: false });
		await s.h.app.tasks.complete(task.id);
		side(root, "Work").click();
		await settle();
		expect(root.querySelectorAll(".cp-meta-notsynced")).toHaveLength(0);
	});
});

