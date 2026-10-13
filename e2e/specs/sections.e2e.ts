// Sections in the real app.
// Lists and sections are seeded through the app services. Every DOM read is scoped to the visible Tasks
// section (background tabs keep hidden copies). Native menus are off (DOM menus), as in the matrix specs.
// Drags use the real pointer.
import { browser, expect } from "@wdio/globals";
import {
	boardColumn,
	centerOf,
	closeQuickAdd,
	createCategory,
	createSectionDirect,
	createTask,
	domClick,
	dragPointer,
	flush,
	freshDatabase,
	getTask,
	pickMenuItem,
	rectOf,
	restoreMenus,
	sectionsOf,
	setGroupBy,
	setLayout,
	showSidebarView,
	useDomMenus,
	type ViewportPoint,
	visibleTasksSection,
	waitForStableRect,
} from "../helpers";

async function detachAppLeaves(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		app.workspace.detachLeavesOfType("checkpoint-app");
	});
}

async function bringIntoView(el: WebdriverIO.Element | ChainablePromiseElement): Promise<void> {
	const element = await el;
	await browser.execute((e) => (e as unknown as HTMLElement).scrollIntoView({ block: "nearest", inline: "nearest" }), element);
	await waitForStableRect(el);
}

/** A point on a card's title line (not its checkbox), where a press starts a drag. */
async function grabPoint(card: WebdriverIO.Element | ChainablePromiseElement): Promise<ViewportPoint> {
	const r = await rectOf(card.$(".cp-board-title"));
	return { x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + r.height / 2) };
}

/** Opens a list's view (its sidebar entry) and returns the visible Tasks section. */
async function openList(name: string): Promise<WebdriverIO.Element> {
	const section = await visibleTasksSection();
	await showSidebarView(section, name);
	return section;
}

/** The section ids in stored order. */
async function sectionIdsOf(listId: string): Promise<string[]> {
	return (await sectionsOf(listId)).map((s) => s.id);
}

/** Clicks "Undo" on the newest notice that has one. */
async function clickUndoNotice(): Promise<void> {
	await browser.waitUntil(
		() =>
			browser.execute(() => {
				const buttons = Array.from(document.querySelectorAll<HTMLElement>(".notice .checkpoint-notice-actions button")).filter((b) => b.textContent === "Undo");
				const last = buttons[buttons.length - 1];
				if (last === undefined) return false;
				last.click();
				return true;
			}),
		{ timeout: 5000, timeoutMsg: "no Undo notice" },
	);
}

async function waitForSectionNames(listId: string, names: string[]): Promise<void> {
	await browser.waitUntil(async () => (await sectionsOf(listId)).map((s) => s.name).join("|") === names.join("|"), {
		timeout: 5000,
		timeoutMsg: `the list's sections are not ${names.join(", ")}`,
	});
}

describe("Sections", function () {
	let wasNative: boolean | undefined;
	let study = "";

	before(async function () {
		wasNative = await useDomMenus();
	});

	after(async function () {
		await restoreMenus(wasNative);
	});

	beforeEach(async function () {
		await freshDatabase();
		await detachAppLeaves();
		study = await createCategory("Study");
	});

	afterEach(async function () {
		await browser.releaseActions();
		await closeQuickAdd();
	});

	it("rename and delete from the section's menu; tasks move to No section and Undo brings it all back", async function () {
		const a = await createSectionDirect(study, "Alpha");
		const t = await createTask("Keep me", { categoryId: study, sectionId: a });
		const section = await openList("Study");
		// The section headings show under Group by Section. The rename prompt is Obsidian's own modal.
		await setGroupBy("Section");
		const group = section.$(`.cp-section-group[data-section-id="${a}"]`);
		await group.waitForExist({ timeout: 5000 });

		await domClick(group.$(".cp-section-menu"));
		await pickMenuItem("Rename");
		const nameInput = browser.$(".modal .setting-item input[type=text]");
		await nameInput.waitForExist({ timeout: 5000, timeoutMsg: "no rename prompt" });
		await nameInput.setValue("Beta");
		await domClick(browser.$(".modal button.mod-cta"));
		await waitForSectionNames(study, ["Beta"]);
		expect((await sectionsOf(study))[0]!.id).toBe(a);

		await domClick(section.$(`.cp-section-group[data-section-id="${a}"] .cp-section-menu`));
		await pickMenuItem("Delete");
		await waitForSectionNames(study, []);
		const moved = await getTask(t);
		expect(moved).not.toBeNull();
		expect(moved!.sectionId).toBeNull();
		expect(moved!.deletedAt ?? null).toBeNull();
		expect(moved!.categoryId).toBe(study);

		await clickUndoNotice();
		await waitForSectionNames(study, ["Beta"]);
		await browser.waitUntil(async () => (await getTask(t))?.sectionId === a, { timeout: 5000, timeoutMsg: "Undo did not put the task back into its section" });
		expect((await sectionsOf(study))[0]!.id).toBe(a);
	});

	it("a card dragged between section columns keeps its id and gets the new sectionId", async function () {
		const a = await createSectionDirect(study, "Alpha");
		const b = await createSectionDirect(study, "Beta");
		const id = await createTask("Drag me", { categoryId: study, sectionId: a });
		const section = await openList("Study");
		await setLayout(section, "Board");
		const card = boardColumn(section, a).$(`.cp-board-card[data-task-id="${id}"]`);
		await card.waitForExist({ timeout: 5000 });
		await waitForStableRect(card);
		const target = boardColumn(section, b).$(".cp-board-col-body");
		await bringIntoView(target);
		await dragPointer(
			() => grabPoint(card),
			async () => centerOf(target),
		);
		await browser.waitUntil(async () => (await getTask(id))?.sectionId === b, { timeout: 5000, timeoutMsg: "the card did not get Beta's sectionId" });
		const task = await getTask(id);
		expect(task!.id).toBe(id);
		expect(task!.categoryId).toBe(study);
		await boardColumn(section, b).$(`.cp-board-card[data-task-id="${id}"]`).waitForExist({ timeout: 5000, timeoutMsg: "the card did not render in Beta" });
		await expect(section.$(".cp-details-pane")).not.toExist();
	});

	it("dragging a column header reorders the sections and the order persists", async function () {
		const a = await createSectionDirect(study, "Alpha");
		const b = await createSectionDirect(study, "Beta");
		const c = await createSectionDirect(study, "Gamma");
		const section = await openList("Study");
		await setLayout(section, "Board");
		await boardColumn(section, c).waitForExist({ timeout: 5000 });
		expect(await sectionIdsOf(study)).toEqual([a, b, c]);
		const first = boardColumn(section, a);
		await bringIntoView(first);
		const grab = boardColumn(section, c).$(".cp-board-col-title");
		await bringIntoView(grab);
		await dragPointer(
			() => centerOf(grab),
			async () => {
				const r = await rectOf(first);
				return { x: Math.round(r.left + 8), y: Math.round(r.top + 20) };
			},
			{ steps: 10 },
		);
		await browser.waitUntil(async () => (await sectionIdsOf(study)).join() === [c, a, b].join(), {
			timeout: 5000,
			timeoutMsg: "the column drag did not persist as Gamma, Alpha, Beta",
		});
		await flush();
		// "No section" stays first; the DOM follows the stored order.
		await browser.waitUntil(
			async () =>
				(await browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>(".cp-board-col")).filter((e) => e.offsetParent !== null).map((e) => e.dataset.column))).join() ===
				["none", c, a, b].join(),
			{ timeout: 5000, timeoutMsg: "the board columns are not No section, Gamma, Alpha, Beta" },
		);
	});

	it("a list row dragged onto another section's rows moves to that section", async function () {
		const a = await createSectionDirect(study, "Alpha");
		const b = await createSectionDirect(study, "Beta");
		const moving = await createTask("Row to move", { categoryId: study, sectionId: a });
		const stay = await createTask("Row that stays", { categoryId: study, sectionId: b });
		const section = await openList("Study");
		await setGroupBy("Section");
		const row = section.$(`.cp-task-row[data-task-id="${moving}"]`);
		const other = section.$(`.cp-task-row[data-task-id="${stay}"]`);
		await row.waitForExist({ timeout: 5000 });
		await other.waitForExist({ timeout: 5000 });
		await waitForStableRect(other);
		await dragPointer(
			async () => centerOf(row.$(".cp-task-title")),
			async () => {
				const r = await rectOf(other);
				return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 3) };
			},
		);
		await browser.waitUntil(async () => (await getTask(moving))?.sectionId === b, { timeout: 5000, timeoutMsg: "the row did not move to Beta" });
		expect((await getTask(moving))!.id).toBe(moving);
		expect((await getTask(stay))!.sectionId).toBe(b);
		await section.$(`.cp-section-group[data-section-id="${b}"] .cp-task-row[data-task-id="${moving}"]`).waitForExist({ timeout: 5000, timeoutMsg: "the row is not under Beta" });
	});

	it("F1: the New list dialog creates a list with its name, icon and color in one step", async function () {
		const section = await visibleTasksSection();
		await domClick(section.$('.cp-sidebar [aria-label="New list"]'));
		const dialog = browser.$(".checkpoint-new-list");
		await dialog.waitForExist({ timeout: 5000, timeoutMsg: "the New list dialog did not open" });
		await browser.waitUntil(async () => (await browser.execute(() => document.activeElement?.classList.contains("cp-new-list-name") ?? false)) === true, {
			timeout: 5000,
			timeoutMsg: "the name field did not take focus",
		});
		// Escape dismisses it without creating anything.
		const before = await browser.executeObsidian(({ plugins }) => (plugins as any).logwell.session.app.store.state.categories.size as number); // eslint-disable-line @typescript-eslint/no-explicit-any
		await browser.keys("Escape");
		await dialog.waitForExist({ timeout: 5000, reverse: true, timeoutMsg: "Escape did not close the dialog" });
		expect(
			await browser.executeObsidian(({ plugins }) => (plugins as any).logwell.session.app.store.state.categories.size as number), // eslint-disable-line @typescript-eslint/no-explicit-any
		).toBe(before);

		await domClick(section.$('.cp-sidebar [aria-label="New list"]'));
		await dialog.waitForExist({ timeout: 5000 });
		await dialog.$("input.cp-new-list-name").setValue("Rocketry");
		// The icon search covers every Lucide icon.
		await dialog.$("input.cp-icon-filter").setValue("rocket");
		const rocket = dialog.$('.cp-icon-choice[aria-label="rocket"]');
		await rocket.waitForExist({ timeout: 5000, timeoutMsg: "the search found no rocket icon" });
		await domClick(rocket);
		await expect(rocket).toHaveAttribute("aria-pressed", "true");
		await domClick(dialog.$('.cp-color-choice[aria-label="Green"]'));
		await expect(dialog.$('.cp-color-choice[aria-label="Green"]')).toHaveAttribute("aria-pressed", "true");
		await domClick(dialog.$("button.mod-cta"));
		await dialog.waitForExist({ timeout: 5000, reverse: true, timeoutMsg: "the dialog did not close on Create" });
		await browser.waitUntil(
			async () =>
				browser.executeObsidian(({ plugins }) => {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const cats = [...(plugins as any).logwell.session.app.store.state.categories.values()] as { name: string }[];
					return cats.some((c) => c.name === "Rocketry");
				}),
			{ timeout: 5000, timeoutMsg: "the list was not created" },
		);
		const made = await browser.executeObsidian(({ plugins }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const cats = [...(plugins as any).logwell.session.app.store.state.categories.values()] as { name: string; icon: string | null; color: string | null }[];
			const c = cats.find((x) => x.name === "Rocketry")!;
			return { icon: c.icon, color: c.color };
		});
		expect(made.icon).toContain("rocket");
		expect(made.color).toBe("green");
		await section.$(".cp-sidebar").$(`.//*[normalize-space(text())="Rocketry"]`).waitForExist({ timeout: 5000, timeoutMsg: "the list is not in the sidebar" });
	});
});
