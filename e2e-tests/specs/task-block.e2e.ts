// The `logwell` code block in real Obsidian. A note holds a block; the block lists the open tasks its filters
// match, ticks them through the app's own services and follows the database. Covered here: reading view and Live
// Preview, typing next to a block, ticking from the note and from the service, a block in a callout (collapsed and
// open), a block in an embedded note (which anchors `linked: this note` on the embedded note), many blocks in one
// note, and a block over 2,000 matching tasks that scrolls. Every DOM read is scoped to the active tab, because
// background tabs keep their own copies. The database for the long list is built here with the project's own types and
// serializer, as perf-virtual.e2e.ts does.
import { randomUUID } from "node:crypto";
import { browser, expect } from "@wdio/globals";
import { INBOX_ID, type Task } from "../../src/domain/types";
import { createEmptyDb } from "../../src/persistence/schema";
import { taskId } from "../../tests/helpers";
import { serializeDb } from "../../src/persistence/serializer";
import { DB_PATH, clickUndoNotice, createCategory, createTask, flush, freshDatabase, getTask, waitForNotice } from "../helpers";

const ACTIVE = ".workspace-leaf.mod-active";
/** The mode of the note opened last. A note's tab keeps the other mode's view (hidden, never drawn), so every query is scoped to the one on screen. */
let currentMode: Mode = "reading";
const scope = () => `${ACTIVE} ${currentMode === "reading" ? ".markdown-reading-view" : ".markdown-source-view"}`;
const NOW = "2026-10-01T08:00:00.000Z";

type Mode = "reading" | "live";

interface BlockState {
	chips: string[];
	count: string;
	titles: string[];
	message: string | null;
	isError: boolean;
	/** The height of the block's frame, in px. */
	height: number;
	/** The rows drawn (a long list draws only those near the viewport). */
	drawn: number;
}

async function writeNote(path: string, content: string): Promise<void> {
	await browser.executeObsidian(
		async ({ app }, p, c) => {
			const file = app.vault.getFileByPath(p);
			if (file === null) await app.vault.create(p, c);
			else await app.vault.modify(file, c);
		},
		path,
		content,
	);
}

/** Opens the note in a new tab, in reading view or in Live Preview, and makes that tab the active one. */
async function openNote(path: string, mode: Mode): Promise<void> {
	currentMode = mode;
	await browser.executeObsidian(
		async ({ app }, p, m) => {
			const file = app.vault.getFileByPath(p);
			if (file === null) throw new Error(`missing note ${p}`);
			const leaf = app.workspace.getLeaf("tab");
			await leaf.openFile(file, { state: m === "reading" ? { mode: "preview" } : { mode: "source", source: false } });
			app.workspace.setActiveLeaf(leaf, { focus: true });
		},
		path,
		mode,
	);
}

/** What each block of the note on screen shows right now. */
async function blocks(): Promise<BlockState[]> {
	return browser.execute((root) => {
		return Array.from(document.querySelectorAll<HTMLElement>(`${root} .cp-block`)).map((block) => {
			const msg = block.querySelector<HTMLElement>(".cp-block-msg");
			return {
				chips: Array.from(block.querySelectorAll(".cp-block-chip")).map((c) => c.textContent ?? ""),
				count: block.querySelector(".cp-block-count")?.textContent ?? "",
				titles: Array.from(block.querySelectorAll(".cp-task-row .cp-task-title")).map((t) => (t.textContent ?? "").trim()),
				message: msg === null ? null : (msg.textContent ?? ""),
				isError: msg?.classList.contains("is-error") ?? false,
				height: block.getBoundingClientRect().height,
				drawn: block.querySelectorAll(".cp-task-row").length,
			};
		});
	}, scope());
}

async function waitForBlocks(n: number, timeout = 10_000): Promise<void> {
	await browser.waitUntil(async () => (await blocks()).length === n, { timeout, timeoutMsg: `expected ${n} block(s) in the active tab` });
}

/** Waits until the first block shows exactly these row titles (in order). */
async function waitForTitles(titles: string[], index = 0, timeout = 10_000): Promise<void> {
	let last: string[] = [];
	await browser.waitUntil(
		async () => {
			last = (await blocks())[index]?.titles ?? [];
			return JSON.stringify(last) === JSON.stringify(titles);
		},
		{ timeout, timeoutMsg: `block ${index} did not show ${JSON.stringify(titles)}; it shows ${JSON.stringify(last)}` },
	);
}

const block = (source: string) => `\`\`\`logwell\n${source}\n\`\`\``;

async function closeNotes(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		app.workspace.detachLeavesOfType("markdown");
		app.workspace.detachLeavesOfType("checkpoint-app");
	});
}

/** The line of the editor's cursor in the note that is open (the first Markdown tab). */
async function cursorLine(): Promise<number> {
	return browser.executeObsidian(({ app }) => {
		const view = app.workspace.getLeavesOfType("markdown")[0]?.view as unknown as { editor?: { getCursor(): { line: number } } } | undefined;
		if (view?.editor === undefined) throw new Error("no editor in the note");
		return view.editor.getCursor().line;
	});
}

/** Puts the editor's cursor at the end of the line that starts with `start` (outside the block) and returns that line. */
async function cursorToLine(start: string): Promise<number> {
	return browser.executeObsidian(({ app }, text) => {
		const view = app.workspace.getLeavesOfType("markdown")[0]?.view as unknown as
			| { editor?: { focus(): void; getValue(): string; getLine(n: number): string; setCursor(p: { line: number; ch: number }): void } }
			| undefined;
		const editor = view?.editor;
		if (editor === undefined) throw new Error("no editor in the note");
		editor.focus();
		const line = editor.getValue().split("\n").findIndex((l) => l.startsWith(text));
		if (line < 0) throw new Error(`no line starts with ${text}`);
		editor.setCursor({ line, ch: editor.getLine(line).length });
		return line;
	}, start);
}

/** How many drawn blocks the Live Preview of the open note holds (the block widget is replaced by its source when the cursor enters it). */
async function drawnBlocksInEditor(): Promise<number> {
	return browser.execute(() => document.querySelectorAll(".markdown-source-view .cp-block").length);
}

/** The task selected in the Logwell tab, or null (also null when no Logwell tab is open). */
async function appSelection(): Promise<string | null | "no-tab"> {
	return browser.executeObsidian(({ app }) => {
		const leaf = app.workspace.getLeavesOfType("checkpoint-app")[0];
		if (leaf === undefined) return "no-tab";
		return (leaf.view as unknown as { selectedTaskId(): string | null }).selectedTaskId();
	});
}

async function complete(id: string): Promise<void> {
	await browser.executeObsidian(async ({ plugins }, taskId) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (plugins as any).logwell.session.app.tasks.complete(taskId);
	}, id);
}

describe("The logwell dashboard block", function () {
	beforeEach(async function () {
		await freshDatabase();
	});

	afterEach(async function () {
		await closeNotes();
	});

	for (const mode of ["reading", "live"] as const) {
		it(`draws the filters, the count and the matching tasks in ${mode === "reading" ? "reading view" : "Live Preview"}`, async function () {
			const work = await createCategory("Work");
			await createTask("Write the report", { categoryId: work, priority: 1 });
			await createTask("Book the room", { categoryId: work });
			await createTask("Water the plants");
			await writeNote("Dashboard.md", `# Dashboard\n\nOpen work:\n\n${block("list: Work")}\n\nAfter the block.\n`);
			await openNote("Dashboard.md", mode);
			await waitForBlocks(1);
			await waitForTitles(["Write the report", "Book the room"]);
			const [b] = await blocks();
			expect(b!.chips).toEqual(["list: Work"]);
			expect(b!.count).toBe("2 tasks");
			expect(b!.message).toBeNull();
			// Rows are the app's own: a priority checkbox and a title.
			expect(await browser.$(`${scope()} .cp-block .cp-task-row input.cp-task-checkbox.cp-pri-1`).isExisting()).toBe(true);
			expect(await browser.$(`${scope()} .cp-block [aria-label="Open in Logwell"]`).isExisting()).toBe(true);
		});
	}

	describe("pressing a block in Live Preview", function () {
		// Live Preview swaps a block for its source when the editor's cursor enters it. The three parts that act (a row, its
		// checkbox, Open in Logwell) must do their job and leave the cursor where it was. On Obsidian 1.14.4 a press does not
		// move the cursor, not even on the header's text (checked with a control click), so the block needs no handler of
		// its own for it; these cases keep it that way.
		const AFTER = "After the block.";

		async function liveBlock(name: string): Promise<{ a: string; line: number }> {
			const a = await createTask("Press target");
			await createTask("Another task");
			await writeNote(name, `# Press\n\n${block("")}\n\n${AFTER}\n`);
			await openNote(name, "live");
			await waitForTitles(["Press target", "Another task"]);
			const line = await cursorToLine(AFTER);
			expect(await cursorLine()).toBe(line);
			expect(await drawnBlocksInEditor()).toBe(1);
			return { a, line };
		}

		it("a click on a row opens the task in the app, and the cursor stays outside the block", async function () {
			const { a, line } = await liveBlock("PressRow.md");
			await browser.$(`${scope()} .cp-block .cp-task-row[data-task-id="${a}"] .cp-task-title`).click();
			await browser.waitUntil(async () => (await appSelection()) === a, { timeout: 10_000, timeoutMsg: "the task was not opened in the app" });
			expect(await cursorLine()).toBe(line);
			expect(await drawnBlocksInEditor()).toBe(1);
		});

		it("a click on a checkbox completes the task, and the cursor stays outside the block", async function () {
			const { a, line } = await liveBlock("PressBox.md");
			await browser.$(`${scope()} .cp-block .cp-task-row[data-task-id="${a}"] input.cp-task-checkbox`).click();
			await browser.waitUntil(async () => (await getTask(a))?.status === "completed", { timeout: 5000, timeoutMsg: "the task was not completed" });
			expect(await cursorLine()).toBe(line);
			expect(await drawnBlocksInEditor()).toBe(1);
			// The row was not opened either: the tick is not a click on the row.
			expect(await appSelection()).toBe("no-tab");
		});

		it("a click on Open in Logwell opens the app, and the cursor stays outside the block", async function () {
			const { line } = await liveBlock("PressOpen.md");
			await browser.$(`${scope()} .cp-block [aria-label="Open in Logwell"]`).click();
			await browser.waitUntil(async () => (await appSelection()) !== "no-tab", { timeout: 10_000, timeoutMsg: "Logwell did not open" });
			expect(await cursorLine()).toBe(line);
			expect(await drawnBlocksInEditor()).toBe(1);
		});
	});

	it("shows a wrong filter, an empty result and a typo in the right messages", async function () {
		await createTask("Anything");
		await writeNote("Messages.md", [block("list: Wrok"), block("priority: high"), block("colour: red")].join("\n\n") + "\n");
		await openNote("Messages.md", "reading");
		await waitForBlocks(3);
		const [wrong, empty, typo] = await blocks();
		expect(wrong!.message).toContain("No list named “Wrok”.");
		expect(wrong!.isError).toBe(true);
		expect(empty!.message).toBe("No tasks found.");
		expect(empty!.isError).toBe(false);
		expect(typo!.message).toContain("Unknown filter");
		expect(typo!.isError).toBe(true);
	});

	it("keeps its place when text is typed next to it in Live Preview", async function () {
		await createTask("First");
		await createTask("Second");
		await writeNote("Typing.md", `# Typing\n\n${block("")}\n\nA line after the block.\n`);
		await openNote("Typing.md", "live");
		await waitForBlocks(1);
		await waitForTitles(["First", "Second"]);
		const before = (await blocks())[0]!;
		// The cursor goes to the end of the last line, outside the block, and real keys type there.
		await browser.executeObsidian(({ app }) => {
			const editor = app.workspace.activeEditor?.editor;
			if (editor === undefined) throw new Error("no active editor");
			editor.focus();
			const line = editor.getValue().split("\n").findIndex((l) => l.startsWith("A line after the block."));
			if (line < 0) throw new Error("the last paragraph is missing");
			editor.setCursor({ line, ch: editor.getLine(line).length });
		});
		await browser.keys(" and more text");
		const text = await browser.executeObsidian(({ app }) => app.workspace.activeEditor?.editor?.getValue() ?? "");
		expect(text).toContain("A line after the block. and more text");
		await browser.pause(800);
		const after = await blocks();
		expect(after).toHaveLength(1);
		expect(after[0]!.titles).toEqual(["First", "Second"]);
		// No layout jump: the frame keeps its height to the pixel.
		expect(Math.abs(after[0]!.height - before.height)).toBeLessThan(1);
	});

	it("a tick in the note completes the task in the app, with an Undo notice, and Undo brings it back", async function () {
		const a = await createTask("Tick me");
		await createTask("Leave me");
		await writeNote("Tick.md", `${block("")}\n`);
		await openNote("Tick.md", "reading");
		await waitForTitles(["Tick me", "Leave me"]);
		await browser.$(`${scope()} .cp-block .cp-task-row[data-task-id="${a}"] input.cp-task-checkbox`).click();
		await browser.waitUntil(async () => (await getTask(a))?.status === "completed", { timeout: 5000, timeoutMsg: "the task was not completed" });
		await flush();
		await waitForNotice("Tick me");
		// The row stays a moment so its check shows, then leaves.
		await waitForTitles(["Leave me"], 0, 5000);
		await clickUndoNotice();
		await browser.waitUntil(async () => (await getTask(a))?.status === "open", { timeout: 5000, timeoutMsg: "Undo did not reopen the task" });
		await waitForTitles(["Tick me", "Leave me"]);
	});

	it("a task completed elsewhere (as the app's own checkbox does) leaves the block, and a new task joins it", async function () {
		const a = await createTask("Done elsewhere");
		await createTask("Stays");
		await writeNote("Follow.md", `${block("")}\n`);
		await openNote("Follow.md", "reading");
		await waitForTitles(["Done elsewhere", "Stays"]);
		await complete(a);
		await waitForTitles(["Stays"]);
		await createTask("Added later");
		await waitForTitles(["Stays", "Added later"]);
		expect((await blocks())[0]!.count).toBe("2 tasks");
	});

	it("a block in a collapsed callout waits until the callout opens, then draws", async function () {
		await createTask("Inside the callout");
		await writeNote("Callout.md", `> [!note]- Tasks\n> ${block("").replace(/\n/g, "\n> ")}\n`);
		await openNote("Callout.md", "reading");
		await waitForBlocks(1);
		// Collapsed: nothing drawn, and nothing counted yet.
		expect((await blocks())[0]!.titles).toEqual([]);
		await browser.$(`${scope()} .callout-title`).click();
		await waitForTitles(["Inside the callout"]);
	});

	it("a block in an open callout draws at once", async function () {
		await createTask("In an open callout");
		await writeNote("OpenCallout.md", `> [!note] Tasks\n> ${block("").replace(/\n/g, "\n> ")}\n`);
		await openNote("OpenCallout.md", "reading");
		await waitForTitles(["In an open callout"]);
	});

	it("a block in an embedded note draws, and linked: this note means the embedded note", async function () {
		await writeNote("Notes/Embedded.md", `# Embedded\n\n${block("linked: this note")}\n`);
		await writeNote("Notes/Host.md", "# Host\n\n![[Notes/Embedded]]\n");
		await createTask("Linked to the embedded note", { notePath: "Notes/Embedded.md" });
		await createTask("Not linked");
		await openNote("Notes/Host.md", "reading");
		await waitForBlocks(1);
		await waitForTitles(["Linked to the embedded note"]);
		expect(await browser.$(`${scope()} .internal-embed .cp-block`).isExisting()).toBe(true);
	});

	it("many blocks in one note draw, and one change reaches each drawn one", async function () {
		await createTask("High one", { priority: 1 });
		await createTask("Low one", { priority: 3 });
		await createTask("Plain one");
		const sources = ["", "priority: high", "priority: low", "priority: none", "priority: high, low"];
		const all = Array.from({ length: 10 }, (_, i) => sources[i % sources.length]!);
		await writeNote("Many.md", all.map((s, i) => `Block ${i + 1}\n\n${block(s)}`).join("\n\n") + "\n");
		await openNote("Many.md", "reading");
		// Reading view renders the sections as they come near the viewport, and a block draws when it is on screen (a
		// little before): several blocks are drawn, and every drawn one shows what its filters match.
		const expected = (chips: string[], extra: number) => {
			const source = chips.join("");
			const base = source === "" ? 3 : source === "priority: high, low" ? 2 : 1;
			const gains = source === "" || source === "priority: high" || source === "priority: high, low";
			return base + (gains ? extra : 0);
		};
		const drawn = async () => (await blocks()).filter((b) => b.count !== "");
		const matches = async (extra: number) => {
			const shown = await drawn();
			return shown.length >= 3 && shown.every((b) => b.titles.length === expected(b.chips, extra));
		};
		const snapshot = async () => JSON.stringify((await blocks()).map((b) => [b.chips.join(" "), b.count, b.titles.length]));
		const waitFor = async (extra: number, what: string) => {
			try {
				await browser.waitUntil(() => matches(extra), { timeout: 10_000 });
			} catch {
				throw new Error(`${what}: ${await snapshot()}`);
			}
		};
		await waitFor(0, "the blocks did not draw their tasks");
		await createTask("Another high one", { priority: 1 });
		await waitFor(1, "the new task did not reach every drawn block");
	});

	it("a block over 2,000 matching tasks keeps a fixed height, scrolls, and draws only the rows near its viewport", async function () {
		this.timeout(180_000);
		const db = createEmptyDb({ dbId: randomUUID(), revision: "r-dashboardblk1", deviceId: "d-e2e", now: NOW });
		const tasks = new Map<string, Task>();
		for (let i = 0; i < 2000; i++) {
			const id = taskId(i + 1);
			tasks.set(id, {
				id,
				title: `Row ${String(i).padStart(4, "0")}`,
				descriptionNote: null,
				categoryId: INBOX_ID,
				tagKeys: [],
				parentId: null,
				sectionId: null,
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
			serializeDb({ ...db, tasks }),
		);
		await writeNote("Long.md", `# Long\n\n${block("list: Inbox")}\n\nAfter the long block.\n`);
		await openNote("Long.md", "reading");
		await waitForBlocks(1, 30_000);
		await browser.waitUntil(async () => (await blocks())[0]!.count === "2000 tasks", { timeout: 30_000, timeoutMsg: "the block did not count 2,000 tasks" });
		const first = (await blocks())[0]!;
		expect(first.drawn).toBeLessThan(80);
		expect(first.titles[0]).toBe("Row 0000");
		// The frame is as tall as its header plus the body's maximum, nowhere near 2,000 rows.
		expect(first.height).toBeLessThan(500);
		const scroll = await browser.execute((root) => {
			const body = document.querySelector<HTMLElement>(`${root} .cp-block-body`);
			if (body === null) throw new Error("no block body");
			const before = { client: body.clientHeight, scrollHeight: body.scrollHeight };
			body.scrollTop = body.scrollHeight;
			return before;
		}, scope());
		expect(scroll.scrollHeight).toBeGreaterThan(scroll.client * 10);
		await waitForLast("Row 1999");
		const last = (await blocks())[0]!;
		expect(last.drawn).toBeLessThan(80);
		expect(last.titles).not.toContain("Row 0000");
		expect(Math.abs(last.height - first.height)).toBeLessThan(1);
	});
});

async function waitForLast(title: string): Promise<void> {
	await browser.waitUntil(async () => ((await blocks())[0]?.titles ?? []).includes(title), { timeout: 15_000, timeoutMsg: `${title} was not drawn after scrolling to the end` });
}
