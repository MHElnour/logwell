// NOT RUN. These specs were written in a cloud session that cannot start
// Obsidian. They typecheck (`npx tsc -p e2e/tsconfig.json`) but have never
// executed. Run `npm run e2e` locally and fix what the real app shows.
// The accent setting and both Obsidian themes.
import { browser, expect } from "@wdio/globals";
import { closeQuickAdd, freshDatabase, openQuickAdd, setPluginSetting, showInbox, visibleTasksSection } from "../helpers";

/** The resolved value of a CSS variable on an element, or on the body when no selector is given. */
async function cssVar(selector: string, name: string): Promise<string> {
	return browser.execute(
		(sel, n) => {
			const el = Array.from(document.querySelectorAll<HTMLElement>(sel)).find((e) => e.offsetParent !== null) ?? document.body;
			return getComputedStyle(el).getPropertyValue(n).trim();
		},
		selector,
		name,
	);
}

async function setTheme(mode: "light" | "dark"): Promise<void> {
	await browser.executeObsidian(({ app }, m) => {
		// changeTheme is Obsidian's internal switch ("moonstone" = light, "obsidian" = dark); it is not in
		// the public typings, so it is feature-detected. The body classes are then forced to match, which
		// is what every theme-dependent rule of the plugin keys on.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const a = app as any;
		if (typeof a.changeTheme === "function") a.changeTheme(m === "light" ? "moonstone" : "obsidian");
		document.body.classList.toggle("theme-light", m === "light");
		document.body.classList.toggle("theme-dark", m === "dark");
	}, mode);
	await browser.pause(300);
}

describe("Accent setting", function () {
	beforeEach(async function () {
		await freshDatabase();
	});

	afterEach(async function () {
		await closeQuickAdd();
		await setPluginSetting("accent", "theme");
	});

	it("choosing purple puts the class on the app container, remaps --cp-accent and tints the active nav item", async function () {
		const section = await visibleTasksSection();
		await showInbox(section);
		const themeAccent = await cssVar(".cp-app", "--cp-accent");
		expect(themeAccent).not.toBe("");
		expect(themeAccent).toBe(await cssVar("body", "--interactive-accent"));

		await setPluginSetting("accent", "purple");
		const app = await (async () => {
			for (const el of await browser.$$(".cp-app")) if (await el.isDisplayed()) return el;
			throw new Error("no visible app container");
		})();
		await expect(app).toHaveElementClass("cp-accent-purple");
		expect(await cssVar(".cp-app", "--cp-accent")).toBe(await cssVar("body", "--color-purple"));

		const active = app.$(".cp-sidebar-item.is-active");
		await expect(active).toExist();
		const bg = await active.getCSSProperty("background-color");
		expect(bg.value).not.toBe("rgba(0,0,0,0)");

		await setPluginSetting("accent", "theme");
		await expect(app).not.toHaveElementClass("cp-accent-purple");
		expect(await cssVar(".cp-app", "--cp-accent")).toBe(themeAccent);
	});

	it("the Quick Add modal takes the accent class too", async function () {
		await setPluginSetting("accent", "green");
		const modal = await openQuickAdd();
		await expect(modal).toHaveElementClass("cp-accent-green");
		expect(await cssVar(".checkpoint-quick-add-modal", "--cp-accent")).toBe(await cssVar("body", "--color-green"));
	});
});

describe("Dark and light themes", function () {
	before(async function () {
		await freshDatabase();
	});

	after(async function () {
		await setTheme("dark");
	});

	for (const mode of ["dark", "light"] as const) {
		it(`renders the app in ${mode} mode: key elements visible, tokens resolved`, async function () {
			await setTheme(mode);
			const classes = await browser.execute(() => document.body.className);
			expect(classes).toContain(`theme-${mode}`);
			const section = await visibleTasksSection();
			await showInbox(section);
			for (const sel of [".cp-sidebar", ".cp-main-header", ".cp-add-bar .cp-qa-bar", ".cp-add-bar .cp-qa-tool"]) {
				await expect(section.$(sel)).toBeDisplayed();
			}
			expect(await cssVar(".cp-app", "--cp-accent")).not.toBe("");
			expect(await cssVar(".cp-app", "--cp-accent-soft")).not.toBe("");
			// Soft hues need less alpha on a light theme (styles.css tokens).
			expect(await cssVar(".cp-app", "--cp-hue-a")).toBe(mode === "light" ? "12%" : "18%");
			const bar = await section.$(".cp-add-bar .cp-qa-bar").getCSSProperty("border-top-color");
			expect(bar.value).not.toBe("rgba(0,0,0,0)");
		});

		it(`opens the date popover and the more menu in ${mode} mode`, async function () {
			await setTheme(mode);
			const section = await visibleTasksSection();
			await showInbox(section);
			await section.$('.cp-add-bar .cp-qa-tool[aria-label="Date"]').click();
			const pop = section.$(".cp-add-bar .cp-date-pop");
			await expect(pop).toBeDisplayed();
			await expect(pop.$(".cp-cal-day.is-today")).toBeDisplayed();
			await browser.keys("Escape");
			await section.$('.cp-add-bar .cp-qa-tool[aria-label="Priority, list, tags and note"]').click();
			await expect(section.$(".cp-add-bar .cp-more-pop .cp-pri-flags")).toBeDisplayed();
			await browser.keys("Escape");
		});
	}
});
