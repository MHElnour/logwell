// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { QuickAddPreset } from "../../src/ui/host";
import { type CalMount, click, mountCal, settle } from "./m3-helpers";
import { menuItem } from "./u1-helpers";

// Every tag row is a tag record with the same menu (Lists, sections and tags rule 25); a parent's view presets its tag
// (rule 26); deleting a parent moves its child tags to the top level, and an open child view follows (rule 28).

const mounted: CalMount[] = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
});

async function mount() {
	const m = await mountCal();
	mounted.push(m);
	const t = m.h.app.tasks;
	await t.create({ title: "Ring mum", newTags: ["Home/Calls"] });
	await t.create({ title: "Weed the beds", newTags: ["Home/Garden"] });
	await t.create({ title: "Buy stamps", newTags: ["Errands"] });
	await settle();
	return m;
}

const sidebar = (m: CalMount) => m.root.querySelector<HTMLElement>(".cp-sidebar")!;
const rows = (m: CalMount) => [...sidebar(m).querySelectorAll<HTMLElement>(".cp-tag-tree .cp-sidebar-item")];
const labels = (m: CalMount) => rows(m).map((r) => r.querySelector(".cp-sidebar-label")!.textContent);
const rowFor = (m: CalMount, label: string) => rows(m).find((r) => r.querySelector(".cp-sidebar-label")!.textContent === label)!;
/** Whether a row sits at the top of the tree (not inside a parent's list). */
const atTop = (m: CalMount, label: string) => rowFor(m, label).closest("li")!.parentElement!.closest("li") === null;
const active = (m: CalMount) => rows(m).filter((r) => r.getAttribute("aria-current") === "page");
const title = (m: CalMount) => m.root.querySelector(".cp-main-title")!.textContent;
const menuOf = async (m: CalMount, label: string) => {
	rowFor(m, label).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	await settle();
	return m.host.menus.at(-1)!;
};
const confirmAll = (m: CalMount) => {
	m.host.choose = (async () => true) as unknown as typeof m.host.choose;
};

describe("sidebar: a parent tag is a tag", () => {
	it("every row has a color dot and the full menu: colors and Delete", async () => {
		const m = await mount();
		expect(labels(m)).toEqual(["Errands", "Home", "Calls", "Garden"]);
		for (const label of labels(m)) {
			expect(rowFor(m, label).querySelector(".cp-tag-dot")!.classList.contains("cp-tag-none")).toBe(false);
			const menu = await menuOf(m, label);
			expect(menuItem(menu, "No color")).toBeDefined();
			expect(menuItem(menu, "Color: red")).toBeDefined();
			expect(menuItem(menu, "Delete")).toBeDefined();
		}
	});

	it("a parent takes a color from its menu", async () => {
		const m = await mount();
		menuItem(await menuOf(m, "Home"), "Color: purple").run();
		await settle();
		expect(m.h.app.store.state.tags.get("home")!.color).toBe("purple");
		expect(rowFor(m, "Home").querySelector(".cp-tag-dot")!.classList.contains("cp-tag-purple")).toBe(true);
	});

	it("the header + in a parent's view presets that tag", async () => {
		const m = await mount();
		const presets: (QuickAddPreset | undefined)[] = [];
		m.host.quickAdd = (preset?: QuickAddPreset) => void presets.push(preset);
		await click(rowFor(m, "Home"));
		m.root.querySelector<HTMLButtonElement>('.cp-tasks .cp-main-header [aria-label="Quick add task"]')!.click();
		expect(presets.at(-1)?.tagKeys).toEqual(["home"]);
	});
});

describe("sidebar: deleting a parent tag", () => {
	it("the confirmation says the child tags move to the top level; a leaf keeps the plain text", async () => {
		const m = await mount();
		const tidy = await m.h.app.tasks.create({ title: "Tidy up", tagKeys: ["home"] });
		await settle();
		const messages: string[] = [];
		m.host.choose = (async (_t: string, message: string) => {
			messages.push(message);
			return null;
		}) as unknown as typeof m.host.choose;
		menuItem(await menuOf(m, "Home"), "Delete").run();
		await settle();
		menuItem(await menuOf(m, "Errands"), "Delete").run();
		await settle();
		expect(messages).toEqual(["Delete @Home? It is removed from 1 task, and its child tags move to the top level.", "Delete @Errands? It is removed from 1 task."]);
		// A tag no task holds itself: no "removed from 0 tasks".
		await m.h.app.tasks.update(tidy.task.id, { tagKeys: [] });
		await settle();
		messages.length = 0;
		menuItem(await menuOf(m, "Home"), "Delete").run();
		await settle();
		expect(messages).toEqual(["Delete @Home? Its child tags move to the top level."]);
		// Nothing was confirmed, so nothing changed.
		expect(labels(m)).toEqual(["Errands", "Home", "Calls", "Garden"]);
	});

	it("moves the children to the top, leaves the open parent view for Inbox, and Undo brings the tree back", async () => {
		const m = await mount();
		confirmAll(m);
		await click(rowFor(m, "Home"));
		expect(title(m)).toBe("@Home");
		menuItem(await menuOf(m, "Home"), "Delete").run();
		await settle();
		expect(labels(m)).toEqual(["Calls", "Errands", "Garden"]);
		expect(title(m)).toBe("Inbox");
		expect(m.host.messages.at(-1)).toBe("Deleted tag @Home.");
		expect(await m.host.undoButtons.at(-1)!()).toBe(true);
		await settle();
		expect(labels(m)).toEqual(["Errands", "Home", "Calls", "Garden"]);
	});

	it("an open child view follows its tag to the top level", async () => {
		const m = await mount();
		confirmAll(m);
		await click(rowFor(m, "Calls"));
		expect(title(m)).toBe("@Calls");
		expect(atTop(m, "Calls")).toBe(false);
		expect(active(m)).toEqual([rowFor(m, "Calls")]);
		menuItem(await menuOf(m, "Home"), "Delete").run();
		await settle();
		// The open view is now the moved tag's: its row is at the top, and it is the active one.
		expect(m.h.app.store.state.tags.has("calls")).toBe(true);
		expect(atTop(m, "Calls")).toBe(true);
		expect(active(m)).toEqual([rowFor(m, "Calls")]);
		expect(title(m)).toBe("@Calls");
	});

	it("an unrelated open tag view stays put", async () => {
		const m = await mount();
		confirmAll(m);
		await click(rowFor(m, "Errands"));
		menuItem(await menuOf(m, "Home"), "Delete").run();
		await settle();
		expect(title(m)).toBe("@Errands");
		expect(active(m)).toEqual([rowFor(m, "Errands")]);
	});

	it("a deeper open view from an older file follows its own tag, not a moved ancestor's path", async () => {
		const m = await mount();
		// A deeper tag can only come from a loaded file, so it is put in directly.
		await m.h.app.store.run("Seed", (tx) =>
			tx.put("tags", { key: "home/calls/mum", displayName: "Home/Calls/Mum", color: null, createdAt: tx.now, modifiedAt: tx.now }),
		);
		await settle();
		confirmAll(m);
		await click(rowFor(m, "Mum"));
		expect(title(m)).toBe("@Mum");
		menuItem(await menuOf(m, "Home"), "Delete").run();
		await settle();
		expect(m.h.app.store.state.tags.has("mum")).toBe(true);
		expect(title(m)).toBe("@Mum");
		expect(active(m)).toEqual([rowFor(m, "Mum")]);
	});
});
