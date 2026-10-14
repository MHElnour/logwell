// The Eisenhower matrix in the real app.
// Tasks are seeded through the app services with dates relative to the real today. Every DOM read is
// scoped to the visible matrix (background tabs keep hidden copies).
import { browser, expect } from "@wdio/globals";
import {
	allTasks,
	appToday,
	centerOf,
	closeQuickAdd,
	createTask,
	detachAppLeaves,
	dragPointer,
	freshDatabase,
	getTask,
	plusDays,
	railButton,
	rectOf,
	restoreMenus,
	useDomMenus,
	visibleMatrix,
	waitForStableRect,
	waitForVisibleMatrix,
} from "../helpers";

type Q = "urgent-important" | "important" | "urgent" | "neither";

interface GroupRead {
	label: string;
	titles: string[];
}

/** Every quadrant of the visible matrix: its groups (label and card titles). */
async function readMatrix(): Promise<Record<Q, GroupRead[]>> {
	return browser.execute(() => {
		const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-matrix")).find((e) => e.offsetParent !== null);
		const out = {} as Record<string, { label: string; titles: string[] }[]>;
		for (const q of ["urgent-important", "important", "urgent", "neither"]) {
			const section = root?.querySelector(`.cp-matrix-q[data-quadrant="${q}"]`);
			out[q] = Array.from(section?.querySelectorAll(".cp-matrix-group") ?? []).map((g) => ({
				label: (g.querySelector(".cp-matrix-group-label") ?? g.querySelector(".cp-completed-toggle"))?.textContent?.trim() ?? "",
				titles: Array.from(g.querySelectorAll(".cp-task-row .cp-task-title")).map((t) => (t.textContent ?? "").trim()),
			}));
		}
		return out;
	}) as Promise<Record<Q, GroupRead[]>>;
}

const titlesOf = (groups: GroupRead[]) => groups.flatMap((g) => g.titles);

/** The card of a task in the visible matrix, and the quadrant it sits in ("" when absent). */
async function quadrantOfCard(id: string): Promise<string> {
	return browser.execute((taskId) => {
		const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-matrix")).find((e) => e.offsetParent !== null);
		return root?.querySelector<HTMLElement>(`.cp-task-row[data-task-id="${taskId}"]`)?.closest<HTMLElement>(".cp-matrix-q")?.dataset.quadrant ?? "";
	}, id);
}

async function cardTitle(matrix: WebdriverIO.Element, id: string): Promise<WebdriverIO.Element> {
	return matrix.$(`.cp-task-row[data-task-id="${id}"] .cp-task-title`).getElement();
}

async function focusCard(id: string): Promise<void> {
	const found = await browser.execute((taskId) => {
		const root = Array.from(document.querySelectorAll<HTMLElement>(".cp-matrix")).find((e) => e.offsetParent !== null);
		const el = root?.querySelector<HTMLElement>(`.cp-task-row[data-task-id="${taskId}"]`);
		if (el === null || el === undefined) return false;
		el.focus();
		return true;
	}, id);
	if (!found) throw new Error(`no card ${id}`);
}

async function focusedCard(): Promise<{ id: string; quadrant: string }> {
	return browser.execute(() => {
		const el = document.activeElement as HTMLElement | null;
		return { id: el?.getAttribute("data-task-id") ?? "", quadrant: el?.closest<HTMLElement>(".cp-matrix-q")?.dataset.quadrant ?? "" };
	});
}

interface Seed {
	overdue: string;
	today: string;
	next7: string;
	later: string;
	urgentOnly: string;
	plain: string;
	done: string;
}

/** One task per quadrant and date group, plus a completed task in quadrant III. */
async function seed(): Promise<Seed> {
	const today = await appToday();
	const overdue = await createTask("M overdue", { urgent: true, important: true, scheduled: { kind: "date", date: plusDays(today, -1) } });
	const todayId = await createTask("M today", { urgent: true, important: true, scheduled: { kind: "date", date: today } });
	const next7 = await createTask("M next7", { important: true, deadline: { kind: "date", date: plusDays(today, 3) } });
	const later = await createTask("M later", { important: true, scheduled: { kind: "date", date: plusDays(today, 20) } });
	const urgentOnly = await createTask("M urgent", { urgent: true });
	const plain = await createTask("M plain");
	const done = await createTask("M done", { urgent: true });
	await browser.executeObsidian(async ({ plugins }, id) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (plugins as any).logwell.session.app.tasks.complete(id);
	}, done);
	return { overdue, today: todayId, next7, later, urgentOnly, plain, done };
}

/** Waits until the six open seeded cards are drawn, so no later render shifts the layout under a press. */
async function waitForSeededCards(): Promise<void> {
	await browser.waitUntil(async () => Object.values(await readMatrix()).flatMap(titlesOf).length === 6, {
		timeout: 5000,
		timeoutMsg: "the matrix did not render the seeded cards",
	});
}

describe("Matrix", function () {
	let nativeMenus: boolean | undefined;
	before(async function () {
		// macOS shows native menus, which WebDriver cannot see; the view menu needs Obsidian's DOM menu.
		nativeMenus = await useDomMenus();
	});

	after(async function () {
		await restoreMenus(nativeMenus);
	});

	beforeEach(async function () {
		await freshDatabase();
		await detachAppLeaves();
	});

	afterEach(async function () {
		await closeQuickAdd();
		await browser.releaseActions();
	});

	it("opens from the rail and from the command, and the rail lists Matrix after Focus", async function () {
		await browser.executeObsidian(async ({ plugins }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await (plugins as any).logwell.openApp("tasks");
		});
		const labels = await browser.execute(() => {
			const rail = Array.from(document.querySelectorAll<HTMLElement>(".cp-rail")).find((e) => e.offsetParent !== null);
			return Array.from(rail?.querySelectorAll("button") ?? []).map((b) => b.getAttribute("aria-label"));
		});
		expect(labels).toEqual(["Tasks", "Calendar", "Focus", "Habits", "Matrix", "Search", "Data"]);

		await (await railButton("Matrix")).click();
		const matrix = await waitForVisibleMatrix();
		await expect(matrix.$(".cp-main-title")).toHaveText("Eisenhower matrix");
		await expect(matrix.$$(".cp-matrix-q")).toBeElementsArrayOfSize(4);
		await expect(await railButton("Matrix")).toHaveAttribute("aria-pressed", "true");

		await (await railButton("Tasks")).click();
		await browser.waitUntil(async () => (await browser.$$(".cp-matrix").filter((e) => e.isDisplayed())).length === 0, {
			timeout: 5000,
			timeoutMsg: "the matrix stayed visible after switching to Tasks",
		});
		await browser.executeObsidian(({ app }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(app as any).commands.executeCommandById("logwell:open-matrix");
		});
		await waitForVisibleMatrix();
	});

	// The same regression the calendar had: a closed tab must show the requested section.
	it("the Open matrix command on a closed tab shows the matrix", async function () {
		await browser.executeObsidian(async ({ app }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(app as any).commands.executeCommandById("logwell:open-matrix");
		});
		await waitForVisibleMatrix();
	});

	it("dragging a card with the real pointer onto Urgent and important keeps the ID and sets both flags", async function () {
		const s = await seed();
		const matrix = await visibleMatrix();
		await waitForSeededCards();
		const before = (await allTasks()).length;
		const title = await cardTitle(matrix, s.plain);
		await title.waitForExist({ timeout: 5000 });
		expect(await quadrantOfCard(s.plain)).toBe("neither");
		await waitForStableRect(title);
		// Both points are measured right before the press.
		await dragPointer(
			() => centerOf(title),
			() => centerOf(matrix.$('.cp-matrix-q[data-quadrant="urgent-important"] .cp-matrix-q-body')),
		);
		await browser.waitUntil(async () => (await getTask(s.plain))?.important === true, { timeout: 5000, timeoutMsg: "the drop did not change the task" });
		const task = await getTask(s.plain);
		expect(task!.id).toBe(s.plain);
		expect(task!.urgent).toBe(true);
		expect(task!.important).toBe(true);
		expect((await allTasks()).length).toBe(before);
		await browser.waitUntil(async () => (await quadrantOfCard(s.plain)) === "urgent-important", { timeout: 5000, timeoutMsg: "the card did not move to quadrant I" });
		// A drag is not a click: the details stay closed.
		await expect(matrix.$(".cp-details-pane")).not.toExist();
		await expect(matrix.$(".cp-matrix-ghost")).not.toExist();
	});

	it("the context menu 'Move to quadrant: urgent and important' keeps the ID and sets both flags", async function () {
		const s = await seed();
		const matrix = await visibleMatrix();
		const row = matrix.$(`.cp-task-row[data-task-id="${s.urgentOnly}"]`);
		await row.waitForExist({ timeout: 5000 });
		// macOS shows native menus by default, which WebDriver cannot see; use Obsidian's own DOM menu.
		const nativeMenus = await browser.executeObsidian(({ app }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const vault = app.vault as any;
			const was = vault.getConfig("nativeMenus") as boolean | undefined;
			vault.setConfig("nativeMenus", false);
			return was;
		});
		try {
			await row.click({ button: "right" });
			await browser.waitUntil(async () => (await browser.$$(".menu .menu-item").length) > 0, { timeout: 5000, timeoutMsg: "no context menu appeared" });
		} finally {
			await browser.executeObsidian(({ app }, was) => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(app.vault as any).setConfig("nativeMenus", was ?? false);
			}, nativeMenus);
		}
		const clickItem = () =>
			browser.execute(() => {
				const item = Array.from(document.querySelectorAll<HTMLElement>(".menu .menu-item")).find(
					(e) => e.querySelector(".menu-item-title")?.textContent === "Move to quadrant: urgent and important",
				);
				if (item === undefined) return false;
				item.click();
				return true;
			});
		await browser.waitUntil(clickItem, { timeout: 5000, timeoutMsg: "the context menu has no quadrant item" });
		await browser.waitUntil(async () => (await getTask(s.urgentOnly))?.important === true, { timeout: 5000, timeoutMsg: "the menu move did not change the task" });
		const task = await getTask(s.urgentOnly);
		expect(task!.id).toBe(s.urgentOnly);
		expect(task!.urgent).toBe(true);
		expect(task!.important).toBe(true);
		await browser.waitUntil(async () => (await quadrantOfCard(s.urgentOnly)) === "urgent-important", { timeout: 5000, timeoutMsg: "the card did not move to quadrant I" });
	});

	it("Alt+Arrow moves the focused card to the adjacent quadrant (view Scope, before Obsidian's hotkeys)", async function () {
		const s = await seed();
		const matrix = await visibleMatrix();
		await matrix.$(`.cp-task-row[data-task-id="${s.plain}"]`).waitForExist({ timeout: 5000 });
		// Quadrant IV is bottom right: up to II, left to I, down to III, right to IV; one step per key.
		const steps: [string, Q][] = [
			["ArrowUp", "important"],
			["ArrowLeft", "urgent-important"],
			["ArrowDown", "urgent"],
			["ArrowRight", "neither"],
		];
		await focusCard(s.plain);
		for (const [key, quadrant] of steps) {
			await browser.keys(["Alt", key]);
			await browser.waitUntil(async () => (await quadrantOfCard(s.plain)) === quadrant, { timeout: 5000, timeoutMsg: `Alt+${key} did not move the card to ${quadrant}` });
			await browser.waitUntil(async () => (await focusedCard()).id === s.plain, { timeout: 5000, timeoutMsg: `focus left the card after Alt+${key}` });
			expect(await focusedCard()).toEqual({ id: s.plain, quadrant });
		}
		const task = await getTask(s.plain);
		expect([task!.urgent, task!.important]).toEqual([false, false]);
	});

	it("the + button of a quadrant opens Quick Add with that quadrant preset", async function () {
		const matrix = await visibleMatrix();
		await matrix.$('.cp-matrix-q[data-quadrant="urgent-important"] .cp-matrix-q-add').click();
		await browser.$(".checkpoint-quick-add-modal").waitForExist({ timeout: 5000, timeoutMsg: "Quick Add did not open" });
		await browser.$(".checkpoint-quick-add-modal .cp-quick-add-title").setValue("From plus");
		await browser.keys("Enter");
		await browser.waitUntil(async () => !(await browser.$(".checkpoint-quick-add-modal").isExisting()), { timeout: 5000, timeoutMsg: "Quick Add did not close" });
		let task: Record<string, unknown> | undefined;
		await browser.waitUntil(async () => (task = (await allTasks()).find((t) => t.title === "From plus")) !== undefined, { timeout: 5000, timeoutMsg: "no task was saved" });
		expect(task!.urgent).toBe(true);
		expect(task!.important).toBe(true);
		await browser.waitUntil(async () => (await quadrantOfCard(task!.id as string)) === "urgent-important", { timeout: 5000, timeoutMsg: "the new card is not in quadrant I" });
	});

	it("a short click on a card opens the details instead of dragging", async function () {
		const s = await seed();
		const matrix = await visibleMatrix();
		await waitForSeededCards();
		const title = await cardTitle(matrix, s.urgentOnly);
		await title.waitForExist({ timeout: 5000 });
		await title.click();
		await matrix.$(".cp-details-pane .cp-details").waitForExist({ timeout: 5000, timeoutMsg: "the details did not open" });
		const task = await getTask(s.urgentOnly);
		expect([task!.urgent, task!.important]).toEqual([true, false]);
		// rectOf keeps the helper in use for the layout check: the grid is two columns at this width.
		const a = await rectOf(await matrix.$('.cp-matrix-q[data-quadrant="urgent-important"]'));
		const b = await rectOf(await matrix.$('.cp-matrix-q[data-quadrant="important"]'));
		expect(b.left).toBeGreaterThan(a.left);
	});
});
