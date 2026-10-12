// Sections in the real app.
// Lists and sections are seeded through the app services. Every DOM read is scoped to the visible Tasks
// section (background tabs keep hidden copies). Native menus are off (DOM menus), as in the matrix specs.
// Drags use the real pointer.
import { readFileSync } from "node:fs";
import { browser, expect } from "@wdio/globals";
import {
	allTasks,
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
	menuTitles,
	openQuickAdd,
	openTaskContextMenu,
	openViewMenu,
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

const SCHEMA_V2 = readFileSync(new URL("../../tests/fixtures/schema-v2.cpbase", import.meta.url), "utf8");

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

/** Waits until the section name field has focus, so the keys that follow reach it. */
async function focusedOnNameField(): Promise<void> {
	await browser.waitUntil(async () => (await browser.execute(() => document.activeElement?.classList.contains("cp-section-name-input") ?? false)) === true, {
		timeout: 5000,
		timeoutMsg: "the name field is not focused after the menu pick",
	});
}

describe("Sections (K1b)", function () {
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

	it("the board's Add section column creates a section; Escape closes only the field; a duplicate name shows the error", async function () {
		const section = await openList("Study");
		await setLayout(section, "Board");
		const addButton = section.$(".cp-board-add-section");
		await addButton.waitForExist({ timeout: 5000, timeoutMsg: "no Add section column" });
		await domClick(addButton);
		const input = section.$(".cp-board-add-col .cp-section-name-input");
		await input.waitForExist({ timeout: 5000, timeoutMsg: "the name field did not open" });
		await input.setValue("Half typed");
		await browser.keys("Escape");
		await input.waitForExist({ timeout: 5000, reverse: true, timeoutMsg: "Escape did not close the field" });
		// Only the field closed: the board is still there, and nothing was created.
		await expect(section.$(".cp-board")).toExist();
		await expect(section.$(".cp-board-add-section")).toExist();
		expect(await sectionsOf(study)).toEqual([]);

		await domClick(section.$(".cp-board-add-section"));
		await section.$(".cp-board-add-col .cp-section-name-input").setValue("Reading");
		await browser.keys("Enter");
		await waitForSectionNames(study, ["Reading"]);
		const [reading] = await sectionsOf(study);
		await boardColumn(section, reading!.id).waitForExist({ timeout: 5000, timeoutMsg: "no column for the new section" });

		// A name that differs only by case is a duplicate: the field stays open with the message.
		await domClick(section.$(".cp-board-add-section"));
		await section.$(".cp-board-add-col .cp-section-name-input").setValue("reading");
		await browser.keys("Enter");
		await section.$(".cp-board-add-col .cp-section-error").waitForExist({ timeout: 5000, timeoutMsg: "no duplicate-name error" });
		expect((await section.$(".cp-board-add-col .cp-section-error").getText()).length).toBeGreaterThan(0);
		await expect(section.$(".cp-board-add-col .cp-section-name-input")).toExist();
		expect(await sectionsOf(study)).toHaveLength(1);
	});

	it("the list's view menu Add section opens a name field under the last section; Enter creates, Escape closes only the field", async function () {
		const section = await openList("Study");
		await openViewMenu(".cp-tasks");
		await pickMenuItem("Add section");
		const input = section.$(".cp-section-add-field.is-list .cp-section-name-input");
		await input.waitForExist({ timeout: 5000, timeoutMsg: "the name field did not open in the list view" });
		await focusedOnNameField();
		await browser.keys("Escape");
		await input.waitForExist({ timeout: 5000, reverse: true, timeoutMsg: "Escape did not close the field" });
		await expect(section.$(".cp-main-title")).toHaveText("Study");

		await openViewMenu(".cp-tasks");
		await pickMenuItem("Add section");
		await section.$(".cp-section-add-field.is-list .cp-section-name-input").waitForExist({ timeout: 5000, timeoutMsg: "the name field did not open the second time" });
		await focusedOnNameField();
		await section.$(".cp-section-add-field.is-list .cp-section-name-input").setValue("Week 1");
		await browser.keys("Enter");
		await waitForSectionNames(study, ["Week 1"]);
		const [week] = await sectionsOf(study);
		// A "No section" heading comes first, then the section heading with its count.
		const groups = section.$$(".cp-section-group");
		await browser.waitUntil(async () => (await groups.length) === 2, { timeout: 5000, timeoutMsg: "expected the No section and Week 1 headings" });
		expect(await groups[0]!.getAttribute("data-section-id")).toBe("none");
		expect(await groups[0]!.$(".cp-section-toggle span[id]").getText()).toBe("No section");
		expect(await groups[1]!.getAttribute("data-section-id")).toBe(week!.id);
		expect(await groups[1]!.$(".cp-section-toggle span[id]").getText()).toBe("Week 1");
		expect(await groups[1]!.$(".cp-group-count").getText()).toBe("0");
	});

	it("rename and delete from the section's menu; tasks move to No section and Undo brings it all back", async function () {
		const a = await createSectionDirect(study, "Alpha");
		const t = await createTask("Keep me", { categoryId: study, sectionId: a });
		const section = await openList("Study");
		// The section headings show under Group by Section.
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

	it("a board section column's menu renames and deletes the same way", async function () {
		const a = await createSectionDirect(study, "Alpha");
		const t = await createTask("Card", { categoryId: study, sectionId: a });
		const section = await openList("Study");
		await setLayout(section, "Board");
		await boardColumn(section, a).waitForExist({ timeout: 5000 });
		await domClick(boardColumn(section, a).$(".cp-board-menu"));
		await pickMenuItem("Delete");
		await waitForSectionNames(study, []);
		expect((await getTask(t))!.sectionId).toBeNull();
		await boardColumn(section, "none").$(`.cp-board-card[data-task-id="${t}"]`).waitForExist({ timeout: 5000, timeoutMsg: "the card did not show under No section" });
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

	it("Move to section... in the context menu moves the task, on the list and on the board", async function () {
		const a = await createSectionDirect(study, "Alpha");
		const b = await createSectionDirect(study, "Beta");
		const id = await createTask("Menu move", { categoryId: study });
		const section = await openList("Study");
		await section.$(`.cp-task-row[data-task-id="${id}"]`).waitForExist({ timeout: 5000 });
		await openTaskContextMenu(section, id);
		await pickMenuItem("Move to section…");
		await browser.waitUntil(async () => (await menuTitles()).includes("Beta"), { timeout: 5000, timeoutMsg: "the section menu did not open" });
		expect(await menuTitles()).toEqual(expect.arrayContaining(["No section", "Alpha", "Beta"]));
		await pickMenuItem("Beta");
		await browser.waitUntil(async () => (await getTask(id))?.sectionId === b, { timeout: 5000, timeoutMsg: "the task did not move to Beta" });

		await setLayout(section, "Board");
		await boardColumn(section, b).$(`.cp-board-card[data-task-id="${id}"]`).waitForExist({ timeout: 5000 });
		await openTaskContextMenu(section, id);
		await pickMenuItem("Move to section…");
		await browser.waitUntil(async () => (await menuTitles()).includes("Alpha"), { timeout: 5000, timeoutMsg: "the section menu did not open on the board" });
		await pickMenuItem("Alpha");
		await browser.waitUntil(async () => (await getTask(id))?.sectionId === a, { timeout: 5000, timeoutMsg: "the card did not move to Alpha" });
	});

	it("the plus on a section column opens Quick Add and the saved task lands in that section", async function () {
		const a = await createSectionDirect(study, "Alpha");
		const b = await createSectionDirect(study, "Beta");
		const section = await openList("Study");
		await setLayout(section, "Board");
		await boardColumn(section, b).waitForExist({ timeout: 5000 });
		await domClick(boardColumn(section, b).$('[aria-label="Add task to Beta"]'));
		await browser.$(".checkpoint-quick-add-modal").waitForExist({ timeout: 5000, timeoutMsg: "Quick Add did not open" });
		await browser.$(".checkpoint-quick-add-modal .cp-quick-add-title").setValue("From the column");
		await browser.keys("Enter");
		await browser.waitUntil(async () => (await allTasks()).some((t) => t.title === "From the column"), { timeout: 5000, timeoutMsg: "the task was not saved" });
		const task = (await allTasks()).find((t) => t.title === "From the column")!;
		expect(task.sectionId).toBe(b);
		expect(task.categoryId).toBe(study);
		await browser.waitUntil(async () => !(await browser.$(".checkpoint-quick-add-modal").isExisting()), { timeout: 5000, timeoutMsg: "Quick Add did not close" });

		// The list heading's plus does the same.
		await setLayout(section, "List");
		await setGroupBy("Section");
		const heading = section.$(`.cp-section-group[data-section-id="${a}"]`);
		await heading.waitForExist({ timeout: 5000 });
		await domClick(heading.$('[aria-label="Add task to Alpha"]'));
		await browser.$(".checkpoint-quick-add-modal").waitForExist({ timeout: 5000, timeoutMsg: "Quick Add did not open from the heading" });
		await browser.$(".checkpoint-quick-add-modal .cp-quick-add-title").setValue("From the heading");
		await browser.keys("Enter");
		await browser.waitUntil(async () => (await allTasks()).some((t) => t.title === "From the heading"), { timeout: 5000, timeoutMsg: "the second task was not saved" });
		expect((await allTasks()).find((t) => t.title === "From the heading")!.sectionId).toBe(a);
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

	it("F1: the icon grid moves with the arrow keys", async function () {
		const section = await visibleTasksSection();
		await domClick(section.$('.cp-sidebar [aria-label="New list"]'));
		const dialog = browser.$(".checkpoint-new-list");
		await dialog.waitForExist({ timeout: 5000 });
		const first = dialog.$$(".cp-icon-choice")[0]!;
		await browser.execute((e) => (e as unknown as HTMLElement).focus(), await first.getElement());
		const label = (await first.getAttribute("aria-label"))!;
		await browser.keys("ArrowRight");
		await browser.waitUntil(
			async () => {
				const now = await browser.execute(() => document.activeElement?.getAttribute("aria-label") ?? "");
				return now !== "" && now !== label;
			},
			{ timeout: 5000, timeoutMsg: "ArrowRight did not move focus to the next icon" },
		);
		await browser.keys("Home");
		await browser.waitUntil(async () => (await browser.execute(() => document.activeElement?.getAttribute("aria-label") ?? "")) === label, {
			timeout: 5000,
			timeoutMsg: "Home did not return to the first icon",
		});
		await browser.keys("Escape");
		await dialog.waitForExist({ timeout: 5000, reverse: true });
	});

	it("a v2 database migrates once, takes a snapshot, and works with sections afterwards", async function () {
		const path = "SchemaV2.cpbase";
		const text = SCHEMA_V2.replace(/"dbId":"[^"]+"/, `"dbId":"${crypto.randomUUID()}"`);
		// Count only the notices raised by this open.
		await browser.execute(() => document.querySelectorAll(".notice").forEach((n) => n.remove()));
		await browser.executeObsidian(
			async ({ app, plugins }, p, content) => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const plugin = (plugins as any).logwell;
				await plugin.setActiveDatabase("");
				const existing = app.vault.getFileByPath(p);
				if (existing === null) await app.vault.create(p, content);
				else await app.vault.process(existing, () => content);
				await plugin.setActiveDatabase(p);
				await plugin.ready();
			},
			path,
			text,
		);
		await browser.waitUntil(
			async () => (await browser.execute(() => Array.from(document.querySelectorAll(".notice")).filter((n) => (n.textContent ?? "").includes("upgraded from schema 2 to 6")).length)) >= 1,
			{ timeout: 10000, timeoutMsg: "no migration notice" },
		);
		await flush();
		// Once: one notice, one pre-migration snapshot, and the file is current (v5).
		expect(await browser.execute(() => Array.from(document.querySelectorAll(".notice")).filter((n) => (n.textContent ?? "").includes("upgraded from schema 2 to 6")).length)).toBe(1);
		const kinds = await browser.executeObsidian(async ({ plugins }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const list = (await (plugins as any).logwell.session.store.listSnapshots()) as { kind: string }[];
			return list.map((s) => s.kind);
		});
		expect(kinds.filter((k) => k === "pre-migration")).toHaveLength(1);
		const onDisk = JSON.parse(await browser.executeObsidian(async ({ app }, p) => app.vault.adapter.read(p), path));
		expect(onDisk.schemaVersion).toBe(6);
		expect(onDisk.sections).toEqual([]);
		for (const t of onDisk.tasks) expect(t.sectionId ?? null).toBeNull();

		// Sections work on the migrated data: Study is a v2 list.
		const studyId = await browser.executeObsidian(({ plugins }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const cats = [...(plugins as any).logwell.session.app.store.state.categories.values()] as { id: string; name: string }[];
			return cats.find((c) => c.name === "Study")!.id;
		});
		const sid = await createSectionDirect(studyId, "After upgrade");
		const task = await createTask("In a new section", { categoryId: studyId, sectionId: sid });
		expect((await getTask(task))!.sectionId).toBe(sid);
		await flush();
		const after = JSON.parse(await browser.executeObsidian(async ({ app }, p) => app.vault.adapter.read(p), path));
		expect(after.sections.map((s: { name: string }) => s.name)).toEqual(["After upgrade"]);
	});
});
