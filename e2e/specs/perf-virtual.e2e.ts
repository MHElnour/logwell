// Windowed lists in the real app: a 2,000-task Inbox draws only the rows near the viewport, and the arrow keys
// and auto-scroll while dragging still work there under real scrolling. The database is built here with the
// project's own types and serializer (as e2e/limits/generate.ts does) and loaded the way freshDatabase() loads
// the seed. Every DOM read is scoped to the visible Tasks section. Drags use the real pointer: keep the mouse off
// the Obsidian window.
import { randomUUID } from "node:crypto";
import { browser, expect } from "@wdio/globals";
import { INBOX_ID, type Section, type Task } from "../../src/domain/types";
import { createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { taskId } from "../../tests/helpers";
import {
	DB_PATH,
	allTasks,
	centerOf,
	dragPointer,
	freshDatabase,
	rectOf,
	showSidebarView,
	visibleTasksSection,
	waitForStableRect,
} from "../helpers";

const COUNT = 2000;
/** Rows 0..999 have no section; rows 1000..1999 are in "Later". */
const LATER = "00000000-0000-4000-8000-00000000a001";
const NOW = "2026-10-01T08:00:00.000Z";

const indexOf = (taskId: string | undefined | null) => (taskId == null ? -1 : parseInt(taskId.slice(-12), 16) - 1);

function bigDatabase(): string {
	const db = createEmptyDb({ dbId: randomUUID(), revision: "r-perfvirtual1", deviceId: "d-e2e", now: NOW });
	const later: Section = { id: LATER, categoryId: INBOX_ID, name: "Later", nameKey: "later", sortKey: "V00001", createdAt: NOW, modifiedAt: NOW };
	const tasks = new Map<string, Task>();
	for (let i = 0; i < COUNT; i++) {
		tasks.set(taskId(i + 1), {
			id: taskId(i + 1),
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
	await section.$(`.cp-task-row[data-task-id="${taskId(1)}"]`).waitForExist({ timeout: 10000, timeoutMsg: "the Inbox did not show its first row" });
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
		}, taskId(1));
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

	it("auto-scroll while dragging keeps the dragged row drawn and dragging, far past where it was", async function () {
		this.timeout(120_000);
		const section = await openBigInbox();
		const first = section.$(`.cp-task-row[data-task-id="${taskId(1)}"] .cp-task-title`);
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
		}, taskId(1));
		expect(dragged).toBe(true);
		await browser.keys("Escape");
		await browser.releaseActions();
		expect(await storedOrder(null).then((o) => o[0])).toBe(taskId(1));
	});
});
