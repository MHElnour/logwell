// Windowed lists in the real app: a 2,000-task Inbox draws only the
// rows near the viewport, and keyboard, drag, completion with Undo, a collapsed group and a board column drag still
// work there. The database is built here with the project's own types and serializer (as e2e/limits/generate.ts
// does) and loaded the way freshDatabase() loads the seed. Every DOM read is scoped to the visible Tasks section.
// Drags use the real pointer: keep the mouse off the Obsidian window.
import { randomUUID } from "node:crypto";
import { browser, expect } from "@wdio/globals";
import { INBOX_ID, type Section, type Task } from "../../src/domain/types";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import {
	DB_PATH,
	allTasks,
	centerOf,
	dragPointer,
	freshDatabase,
	getTask,
	rectOf,
	restoreMenus,
	setGroupBy,
	setLayout,
	showSidebarView,
	useDomMenus,
	visibleTasksSection,
	waitForStableRect,
} from "../helpers";

const COUNT = 2000;
/** Rows 0..999 have no section; rows 1000..1999 are in "Later". */
const LATER = "00000000-0000-4000-8000-00000000a001";
const NOW = "2026-10-01T08:00:00.000Z";

const id = (i: number) => `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`;
const indexOf = (taskId: string | undefined | null) => (taskId == null ? -1 : parseInt(taskId.slice(-12), 16) - 1);

function bigDatabase(): string {
	const db = createEmptyDb({ dbId: randomUUID(), revision: "r-perfvirtual1", deviceId: "d-e2e", now: NOW });
	const later: Section = { id: LATER, categoryId: INBOX_ID, name: "Later", nameKey: "later", sortKey: "V00001", createdAt: NOW, modifiedAt: NOW };
	const tasks = new Map<string, Task>();
	for (let i = 0; i < COUNT; i++) {
		tasks.set(id(i), {
			id: id(i),
			title: `Row ${String(i).padStart(4, "0")}`,
			descriptionNote: null,
			categoryId: INBOX_ID,
			tagKeys: [],
			parentId: null,
			sectionId: i < COUNT / 2 ? null : LATER,
			scheduled: null,
			deadline: null,
			plannedDurationMin: null,
			urgent: false,
			important: false,
			priority: 0,
			status: "open",
			completedAt: null,
			recurrence: null,
			sortKey: `V${i.toString(36).padStart(5, "0")}`,
			createdAt: NOW,
			modifiedAt: NOW,
		});
	}
	return serializeDb({ ...db, sections: new Map([[LATER, later]]), tasks });
}

/** Loads the 2,000-task database, opens the Inbox and returns the visible Tasks section. */
async function openBigInbox(): Promise<WebdriverIO.Element> {
	await freshDatabase();
	await browser.executeObsidian(
		async ({ app, plugins }, dbPath, text) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const plugin = (plugins as any).logwell;
			await plugin.setActiveDatabase("");
			const file = app.vault.getFileByPath(dbPath);
			if (file === null) throw new Error("missing database");
			await app.vault.process(file, () => text);
			await plugin.setActiveDatabase(dbPath);
			await plugin.ready();
		},
		DB_PATH,
		bigDatabase(),
	);
	const section = await visibleTasksSection();
	await showSidebarView(section, "Inbox");
	await section.$(`.cp-task-row[data-task-id="${id(0)}"]`).waitForExist({ timeout: 10000, timeoutMsg: "the Inbox did not show its first row" });
	return section;
}

/** The visible list: how many rows are drawn, which row has focus, whether it is inside the scroller's viewport. */
async function listState(): Promise<{ drawn: number; focused: number; focusedInView: boolean; scrollTop: number }> {
	const s = await browser.execute(() => {
		const tasks = Array.from(document.querySelectorAll<HTMLElement>(".cp-tasks")).find((e) => e.offsetParent !== null);
		const main = tasks?.querySelector<HTMLElement>(".cp-main");
		if (tasks === undefined || main == null) return null;
		const active = document.activeElement as HTMLElement | null;
		const row = active !== null && active.classList.contains("cp-task-row") && tasks.contains(active) ? active : null;
		const r = row?.getBoundingClientRect();
		const m = main.getBoundingClientRect();
		return {
			drawn: main.querySelectorAll(".cp-task-row").length,
			focused: row?.dataset.taskId ?? null,
			focusedInView: r !== undefined && r.top >= m.top - 1 && r.bottom <= m.bottom + 1,
			scrollTop: main.scrollTop,
		};
	});
	if (s === null) throw new Error("no visible Tasks list");
	return { ...s, focused: indexOf(s.focused) };
}

async function setScrollTop(selector: string, top: number): Promise<void> {
	await browser.execute(
		(sel, y) => {
			const el = Array.from(document.querySelectorAll<HTMLElement>(sel)).find((e) => e.offsetParent !== null);
			if (el === undefined) throw new Error(`no visible ${sel}`);
			el.scrollTop = y;
		},
		selector,
		top,
	);
}

/** The stored manual order of the Inbox tasks with this section (null: No section). */
async function storedOrder(sectionId: string | null): Promise<string[]> {
	return (await allTasks())
		.filter((t) => t.categoryId === INBOX_ID && t.sectionId === sectionId && t.status === "open")
		.sort((a, b) => ((a.sortKey as string) < (b.sortKey as string) ? -1 : 1))
		.map((t) => t.id as string);
}

describe("Long lists draw only the rows near the viewport (performance release B)", function () {
	beforeEach(async function () {
		await browser.executeObsidian(({ app }) => {
			app.workspace.detachLeavesOfType("checkpoint-app");
		});
	});

	afterEach(async function () {
		await browser.releaseActions();
	});

	it("the arrow keys walk all 2,000 rows, each drawn and scrolled into view, then back", async function () {
		this.timeout(240_000);
		await openBigInbox();
		const first = await listState();
		expect(first.drawn).toBeLessThan(120);
		await browser.execute((rid) => {
			Array.from(document.querySelectorAll<HTMLElement>(`.cp-task-row[data-task-id="${rid}"]`))
				.find((e) => e.offsetParent !== null)!
				.focus();
		}, id(0));
		for (let at = 0; at < COUNT - 1; ) {
			const n = Math.min(100, COUNT - 1 - at);
			await browser.keys(Array.from({ length: n }, () => "ArrowDown"));
			at += n;
			await browser.waitUntil(async () => (await listState()).focused === at, { timeout: 10000, timeoutMsg: `ArrowDown did not reach row ${at}` });
			const s = await listState();
			expect(s.focusedInView).toBe(true);
			expect(s.drawn).toBeLessThan(120);
		}
		for (let at = COUNT - 1; at > 0; ) {
			const n = Math.min(250, at);
			await browser.keys(Array.from({ length: n }, () => "ArrowUp"));
			at -= n;
			await browser.waitUntil(async () => (await listState()).focused === at, { timeout: 10000, timeoutMsg: `ArrowUp did not reach row ${at}` });
		}
		const last = await listState();
		expect(last.focusedInView).toBe(true);
		expect(last.scrollTop).toBeLessThan(80);
	});

	it("a row dragged far down the list lands among rows that are not drawn, ordered from the data", async function () {
		this.timeout(120_000);
		const section = await openBigInbox();
		// Far down: rows 0..1450 are not drawn.
		await setScrollTop(".cp-tasks .cp-main", 1500 * 52);
		const moving = section.$(`.cp-task-row[data-task-id="${id(1500)}"]`);
		const target = section.$(`.cp-task-row[data-task-id="${id(1506)}"]`);
		await moving.waitForExist({ timeout: 5000, timeoutMsg: "row 1500 is not drawn after scrolling to it" });
		await target.waitForExist({ timeout: 5000 });
		await waitForStableRect(target);
		expect((await listState()).drawn).toBeLessThan(120);
		await dragPointer(
			() => centerOf(moving.$(".cp-task-title")),
			async (from) => {
				const r = await rectOf(target);
				return { x: from.x, y: Math.round(r.top + r.height * 0.75) };
			},
		);
		await browser.waitUntil(
			async () => {
				const order = await storedOrder(LATER);
				return order.indexOf(id(1500)) === order.indexOf(id(1506)) + 1;
			},
			{ timeout: 5000, timeoutMsg: "row 1500 is not right after row 1506 in the stored order" },
		);
		const order = await storedOrder(LATER);
		expect(order).toHaveLength(COUNT / 2);
		expect(order.indexOf(id(1500))).toBe(506);
	});

	it("auto-scroll while dragging keeps the dragged row drawn and dragging, far past where it was", async function () {
		this.timeout(120_000);
		const section = await openBigInbox();
		const first = section.$(`.cp-task-row[data-task-id="${id(0)}"] .cp-task-title`);
		await waitForStableRect(first);
		await dragPointer(
			() => centerOf(first),
			async (from) => {
				const main = await rectOf(section.$(".cp-main"));
				const bottom = await browser.execute(() => window.innerHeight);
				return { x: from.x, y: Math.round(Math.min(main.bottom, bottom) - 6) };
			},
			{ release: false },
		);
		// Well past the overscan: without the pin the row would have left the DOM and the drag would have ended.
		await browser.waitUntil(async () => (await listState()).scrollTop > 2000, {
			timeout: 15000,
			interval: 100,
			timeoutMsg: "holding the drag at the bottom edge did not scroll the list far enough",
		});
		const dragged = await browser.execute((rid) => {
			const row = Array.from(document.querySelectorAll<HTMLElement>(`.cp-task-row[data-task-id="${rid}"]`)).find((e) => e.closest(".cp-tasks")?.clientHeight);
			return row !== undefined && row.classList.contains("is-dragging") && row.closest(".cp-task-list")!.classList.contains("is-reordering");
		}, id(0));
		expect(dragged).toBe(true);
		await browser.keys("Escape");
		await browser.releaseActions();
		expect(await storedOrder(null).then((o) => o[0])).toBe(id(0));
	});

	it("completing a row far down: it lingers, leaves without moving the scroll position, and Undo puts it back in place", async function () {
		this.timeout(120_000);
		const section = await openBigInbox();
		await setScrollTop(".cp-tasks .cp-main", 1200 * 52);
		const row = section.$(`.cp-task-row[data-task-id="${id(1204)}"]`);
		await row.waitForExist({ timeout: 5000 });
		await waitForStableRect(row);
		// Clicked in the page (a WebDriver click may scroll first), reading the scroll position at the same moment.
		const before = await browser.execute((rid) => {
			const tasks = Array.from(document.querySelectorAll<HTMLElement>(".cp-tasks")).find((e) => e.offsetParent !== null)!;
			tasks.querySelector<HTMLElement>(`.cp-task-row[data-task-id="${rid}"] .cp-task-checkbox`)!.click();
			return tasks.querySelector<HTMLElement>(".cp-main")!.scrollTop;
		}, id(1204));
		await browser.waitUntil(async () => (await getTask(id(1204)))?.status === "completed", { timeout: 5000, interval: 50, timeoutMsg: "the row was not completed" });
		// It lingers for the check animation, then leaves the open rows; the rows below move up, the list does not scroll.
		await row.waitForExist({ timeout: 5000, reverse: true, timeoutMsg: "the completed row did not leave the list" });
		expect(Math.abs((await listState()).scrollTop - before)).toBeLessThanOrEqual(1);
		// Completing shows no notice; Undo is the "Undo last task change" command (or Cmd/Ctrl+Z in the list).
		await browser.executeObsidian(({ app }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(app as any).commands.executeCommandById("logwell:undo-last-change");
		});
		await browser.waitUntil(async () => (await getTask(id(1204)))?.status === "open", { timeout: 5000, timeoutMsg: "Undo did not reopen the row" });
		await section.$(`.cp-task-row[data-task-id="${id(1204)}"]`).waitForExist({ timeout: 5000, timeoutMsg: "the restored row is not drawn" });
		// Back between its old neighbours.
		const neighbours = await browser.execute((rid) => {
			const row = Array.from(document.querySelectorAll<HTMLElement>(`.cp-task-row[data-task-id="${rid}"]`)).find((e) => e.offsetParent !== null)!;
			return [(row.previousElementSibling as HTMLElement | null)?.dataset.taskId ?? null, (row.nextElementSibling as HTMLElement | null)?.dataset.taskId ?? null];
		}, id(1204));
		expect(neighbours).toEqual([id(1203), id(1205)]);
		expect(Math.abs((await listState()).scrollTop - before)).toBeLessThanOrEqual(1);
	});

	it("collapsing a section of 1,000 rows is instant and the next section draws right under it", async function () {
		this.timeout(120_000);
		const section = await openBigInbox();
		const was = await useDomMenus();
		try {
			await setGroupBy("Section");
			const toggle = section.$('.cp-section-group[data-section-id="none"] .cp-section-toggle');
			await toggle.waitForExist({ timeout: 5000, timeoutMsg: "no No section heading" });
			const ms = await browser.executeAsync((done: (ms: number) => void) => {
				const tasks = Array.from(document.querySelectorAll<HTMLElement>(".cp-tasks")).find((e) => e.offsetParent !== null)!;
				const button = tasks.querySelector<HTMLElement>('.cp-section-group[data-section-id="none"] .cp-section-toggle')!;
				const t0 = performance.now();
				button.click();
				requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now() - t0)));
			});
			expect(ms).toBeLessThan(500);
			await section.$('.cp-section-group[data-section-id="none"].is-collapsed').waitForExist({ timeout: 5000 });
			const laterRow = section.$(`.cp-task-row[data-task-id="${id(1000)}"]`);
			await laterRow.waitForExist({ timeout: 5000, timeoutMsg: "the Later section did not draw its first row" });
			const r = await rectOf(laterRow);
			const main = await rectOf(section.$(".cp-main"));
			expect(r.top).toBeGreaterThanOrEqual(main.top);
			expect(r.bottom).toBeLessThanOrEqual(main.bottom);
			expect(await section.$(`.cp-task-row[data-task-id="${id(0)}"]`).isExisting()).toBe(false);
		} finally {
			await restoreMenus(was);
		}
	});

	it("a card dragged into a long board column lands among cards that are not drawn, ordered from the data", async function () {
		this.timeout(120_000);
		const section = await openBigInbox();
		await setLayout(section, "Board");
		const body = `.cp-tasks .cp-board-col[data-column="${LATER}"] .cp-board-col-body`;
		await section.$(`.cp-board-col[data-column="${LATER}"] .cp-board-card`).waitForExist({ timeout: 10000 });
		const drawnCards = await browser.execute(
			(sel) => Array.from(document.querySelectorAll<HTMLElement>(sel)).find((e) => e.offsetParent !== null)!.querySelectorAll(".cp-board-card").length,
			body,
		);
		expect(drawnCards).toBeLessThan(120);
		// Far down the Later column, then pick a card that is fully in view there.
		await setScrollTop(body, 30000);
		let targetId = "";
		await browser.waitUntil(
			async () => {
				targetId = await browser.execute((sel) => {
					const col = Array.from(document.querySelectorAll<HTMLElement>(sel)).find((e) => e.offsetParent !== null)!;
					const box = col.getBoundingClientRect();
					const inView = Array.from(col.querySelectorAll<HTMLElement>(".cp-board-card")).filter((c) => {
						const r = c.getBoundingClientRect();
						return r.top >= box.top + 40 && r.bottom <= box.bottom - 40;
					});
					return inView[1]?.dataset.taskId ?? "";
				}, body);
				return targetId !== "";
			},
			{ timeout: 5000, timeoutMsg: "no card in view far down the Later column" },
		);
		expect(indexOf(targetId)).toBeGreaterThan(1300);
		const target = section.$(`.cp-board-card[data-task-id="${targetId}"]`);
		await waitForStableRect(target);
		const card = section.$(`.cp-board-card[data-task-id="${id(0)}"] .cp-board-title`);
		await waitForStableRect(card);
		await dragPointer(
			async () => {
				const r = await rectOf(card);
				return { x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + r.height / 2) };
			},
			async () => {
				const r = await rectOf(target);
				return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.75) };
			},
		);
		await browser.waitUntil(async () => (await getTask(id(0)))?.sectionId === LATER, { timeout: 5000, timeoutMsg: "the card did not move to Later" });
		const order = await storedOrder(LATER);
		expect(order).toHaveLength(COUNT / 2 + 1);
		expect(order.indexOf(id(0))).toBe(order.indexOf(targetId) + 1);
	});
});
