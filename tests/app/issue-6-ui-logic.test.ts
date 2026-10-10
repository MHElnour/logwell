import { describe, expect, it } from "vitest";
import { TickTickError } from "../../src/app/ports";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../../src/app/settings";
import { isListSynced, notSyncedReason } from "../../src/app/syncMarks";
import { countPushable, defaultOption, loadLinkOptions } from "../../src/app/tickTickLink";
import { isInboxProjectId } from "../../src/domain/ticktick/inbox";
import type { SyncLink } from "../../src/domain/types";
import { syncLinkId } from "../../src/domain/types";
import { type SyncHarness, linkedList, syncHarness } from "./sync-harness";

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
