import { browser, expect } from "@wdio/globals";
import { MOD_KEY, createTask, freshDatabase, getTask } from "../helpers";

/** Opens the app and returns the visible Tasks section (background tabs keep hidden copies). */
async function visibleTasksSection(): Promise<WebdriverIO.Element> {
	await browser.executeObsidian(async ({ plugins }) => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (plugins as any).logwell.openApp("tasks");
	});
	let section: WebdriverIO.Element | undefined;
	await browser.waitUntil(
		async () => {
			for (const el of await browser.$$(".cp-tasks")) if (await el.isDisplayed()) section = el;
			return section !== undefined;
		},
		{ timeout: 5000, timeoutMsg: "no visible Tasks section" },
	);
	return section!;
}

async function showInbox(section: WebdriverIO.Element): Promise<void> {
	await section.$(".cp-sidebar").$(`.//*[normalize-space(text())="Inbox"]`).click();
}

/**
 * Sets the width of the app container. The layout uses container queries on
 * `.cp-app`, so narrowing that element is what a narrow tab does. (WebDriver
 * window resizing is not supported by Obsidian's Electron driver.)
 */
async function setAppWidth(width: number): Promise<void> {
	await visibleTasksSection();
	await browser.execute((w) => {
		for (const el of Array.from(document.querySelectorAll<HTMLElement>(".cp-app"))) {
			if (el.offsetParent !== null) el.style.width = `${w}px`;
		}
	}, width);
	await browser.pause(200);
}

// The responsive layout and the keyboard pass.
describe("Layout and keyboard", function () {
	beforeEach(async function () {
		await freshDatabase();
	});

	afterEach(async function () {
		await browser.execute(() => {
			for (const el of Array.from(document.querySelectorAll<HTMLElement>(".cp-app"))) el.style.width = "";
		});
	});

	it("UI-02: details become a drawer under ~1200 px and the sidebar collapses under ~800 px", async function () {
		const id = await createTask("Layout check");
		await setAppWidth(1300);
		let section = await visibleTasksSection();
		await showInbox(section);
		await section.$(`.cp-task-row[data-task-id="${id}"]`).click();
		const pane = section.$(".cp-details-pane");
		await pane.waitForExist({ timeout: 5000 });
		expect(await pane.getCSSProperty("position")).toMatchObject({ value: "static" });
		// Inline, the list keeps at least ~440 px.
		const listWidth = await browser.execute(() => {
			const el = Array.from(document.querySelectorAll<HTMLElement>(".cp-main")).find((e) => e.offsetParent !== null);
			return el?.getBoundingClientRect().width ?? 0;
		});
		expect(listWidth).toBeGreaterThanOrEqual(440);

		await setAppWidth(1100);
		section = await visibleTasksSection();
		expect((await section.$(".cp-details-pane").getCSSProperty("position")).value).toBe("absolute");
		await expect(section.$(".cp-details-close")).toBeDisplayed();
		await expect(section.$(".cp-sidebar-pane")).toBeDisplayed();

		await setAppWidth(700);
		section = await visibleTasksSection();
		await expect(section.$(".cp-sidebar-pane")).not.toBeDisplayed();
		await expect(section.$(".cp-sidebar-toggle")).toBeDisplayed();
		// The details drawer overlays the view; close it before using the menu button.
		await section.$(".cp-details-close").click();
		await section.$(".cp-sidebar-toggle").click();
		await expect(section.$(".cp-sidebar-pane")).toBeDisplayed();
	});

	it("hovering inside the sidebar or a task row shows no container tooltip", async function () {
		await createTask("Hover check", { scheduled: { kind: "date", date: new Date().toISOString().slice(0, 10) } });
		await setAppWidth(1100);
		const section = await visibleTasksSection();
		const tooltipText = async () =>
			browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>(".tooltip")).map((t) => t.textContent ?? "").join("|"));
		await section.$(".cp-sidebar").$(`.//*[normalize-space(text())="Inbox"]`).moveTo();
		await browser.pause(900);
		expect(await tooltipText()).not.toContain("Task lists");
		await showInbox(section);
		const row = section.$(".cp-task-row");
		await row.waitForExist({ timeout: 5000 });
		await row.$(".cp-task-title").moveTo();
		await browser.pause(900);
		expect(await tooltipText()).not.toMatch(/^(Today|Inbox)$/);
	});

	it("focus is visible on keyboard focus", async function () {
		await createTask("Focus ring");
		await setAppWidth(1200);
		const section = await visibleTasksSection();
		await showInbox(section);
		const row = section.$(".cp-task-row");
		await row.waitForExist({ timeout: 5000 });
		await browser.execute((el) => (el as unknown as HTMLElement).focus(), await row.getElement());
		await browser.keys("ArrowUp"); // keyboard interaction so :focus-visible applies
		const outline = await browser.execute(() => {
			const el = document.activeElement as HTMLElement | null;
			if (el === null) return "none";
			const s = getComputedStyle(el);
			return `${s.outlineStyle} ${s.boxShadow}`;
		});
		expect(outline).not.toBe("none none");
	});

	// Obsidian's own Mod+Enter hotkeys take the key before the page sees it; the view's Scope hands it to the row.
	it("Cmd/Ctrl+Enter on a selected row completes it", async function () {
		const id = await createTask("Complete me");
		const section = await visibleTasksSection();
		await showInbox(section);
		const row = section.$(`.cp-task-row[data-task-id="${id}"]`);
		await row.waitForExist({ timeout: 5000 });
		await row.click();
		await expect(row).toHaveElementClass("is-selected");
		await browser.execute((el) => (el as unknown as HTMLElement).focus(), await row.getElement());
		await browser.keys([MOD_KEY, "Enter"]);
		await browser.waitUntil(async () => (await getTask(id))?.status === "completed", {
			timeout: 3000,
			timeoutMsg: "Cmd/Ctrl+Enter did not complete the selected task",
		});
	});
});
