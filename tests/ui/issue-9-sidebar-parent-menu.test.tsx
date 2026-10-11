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
	await t.create({ title: "Go task", newTags: ["Programming/Go"] });
	await t.create({ title: "Python task", newTags: ["Programming/Python"] });
	await t.create({ title: "Plain", newTags: ["Errands"] });
	await settle();
	return m;
}

const sidebar = (m: CalMount) => m.root.querySelector<HTMLElement>(".cp-sidebar")!;
const rows = (m: CalMount) => [...sidebar(m).querySelectorAll<HTMLElement>(".cp-tag-tree .cp-sidebar-item")];
const labels = (m: CalMount) => rows(m).map((r) => r.querySelector(".cp-sidebar-label")!.textContent);
const rowFor = (m: CalMount, label: string) => rows(m).find((r) => r.querySelector(".cp-sidebar-label")!.textContent === label)!;
const title = (m: CalMount) => m.root.querySelector(".cp-main-title")!.textContent;
const menuOf = async (m: CalMount, label: string) => {
	rowFor(m, label).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	await settle();
	return m.host.menus.at(-1)!;
};
const confirmAll = (m: CalMount, messages: string[] = []) => {
	m.host.choose = (async (_t: string, message: string) => {
		messages.push(message);
		return true;
	}) as unknown as typeof m.host.choose;
	return messages;
};

describe("sidebar: a parent tag is a tag", () => {
	it("every row has a color dot and the full menu: colors and Delete", async () => {
		const m = await mount();
		expect(labels(m)).toEqual(["Errands", "Programming", "Go", "Python"]);
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
		menuItem(await menuOf(m, "Programming"), "Color: purple").run();
		await settle();
		expect(m.h.app.store.state.tags.get("programming")!.color).toBe("purple");
		expect(rowFor(m, "Programming").querySelector(".cp-tag-dot")!.classList.contains("cp-tag-purple")).toBe(true);
	});

	it("the header + in a parent's view presets that tag", async () => {
		const m = await mount();
		const presets: (QuickAddPreset | undefined)[] = [];
		m.host.quickAdd = (preset?: QuickAddPreset) => void presets.push(preset);
		await click(rowFor(m, "Programming"));
		m.root.querySelector<HTMLButtonElement>('.cp-tasks .cp-main-header [aria-label="Quick add task"]')!.click();
		expect(presets.at(-1)?.tagKeys).toEqual(["programming"]);
	});
});

describe("sidebar: deleting a parent tag", () => {
	it("the confirmation says the child tags move to the top level; a leaf keeps the plain text", async () => {
		const m = await mount();
		await m.h.app.tasks.create({ title: "Parent only", tagKeys: ["programming"] });
		await settle();
		const messages: string[] = [];
		m.host.choose = (async (_t: string, message: string) => {
			messages.push(message);
			return null;
		}) as unknown as typeof m.host.choose;
		menuItem(await menuOf(m, "Programming"), "Delete").run();
		await settle();
		menuItem(await menuOf(m, "Errands"), "Delete").run();
		await settle();
		expect(messages).toEqual(["Delete @Programming? It is removed from 1 task, and its child tags move to the top level.", "Delete @Errands? It is removed from 1 task."]);
		// Nothing was confirmed, so nothing changed.
		expect(labels(m)).toEqual(["Errands", "Programming", "Go", "Python"]);
	});

	it("moves the children to the top, leaves the open parent view for Inbox, and Undo brings the tree back", async () => {
		const m = await mount();
		confirmAll(m);
		await click(rowFor(m, "Programming"));
		expect(title(m)).toBe("@Programming");
		menuItem(await menuOf(m, "Programming"), "Delete").run();
		await settle();
		expect(labels(m)).toEqual(["Errands", "Go", "Python"]);
		expect(title(m)).toBe("Inbox");
		expect(m.host.messages.at(-1)).toBe("Deleted tag @Programming.");
		expect(await m.host.undoButtons.at(-1)!()).toBe(true);
		await settle();
		expect(labels(m)).toEqual(["Errands", "Programming", "Go", "Python"]);
	});

	it("an open child view follows its tag to the top level", async () => {
		const m = await mount();
		confirmAll(m);
		await click(rowFor(m, "Go"));
		expect(title(m)).toBe("@Go");
		menuItem(await menuOf(m, "Programming"), "Delete").run();
		await settle();
		expect(title(m)).toBe("@Go");
		expect(rowFor(m, "Go").getAttribute("aria-current")).toBe("page");
		expect(m.h.app.store.state.tags.has("go")).toBe(true);
	});
});
