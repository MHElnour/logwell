// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { type TaskView, sidebarCounts } from "../../src/app/views";
import { Sidebar } from "../../src/ui/Sidebar";
import { type CalMount, click, mountCal, settle } from "./m3-helpers";
import { menuItem } from "./u1-helpers";

// The sidebar Tags section is a tree of parent tags.

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
	await t.create({ title: "Both", newTags: ["Programming/Go", "Programming/Python"] });
	await t.create({ title: "Plain", newTags: ["Errands"] });
	await settle();
	return m;
}

const sidebar = (m: CalMount) => m.root.querySelector<HTMLElement>(".cp-sidebar")!;
const rows = (m: CalMount) => [...sidebar(m).querySelectorAll<HTMLElement>(".cp-tag-tree .cp-sidebar-item")];
const labels = (m: CalMount) => rows(m).map((r) => r.querySelector(".cp-sidebar-label")!.textContent);
const rowFor = (m: CalMount, label: string) => rows(m).find((r) => r.querySelector(".cp-sidebar-label")!.textContent === label)!;
const fold = (m: CalMount, label: string) => sidebar(m).querySelector<HTMLButtonElement>(`.cp-tag-fold[data-tag-label="${label}"]`)!;
const rowTitles = (m: CalMount) => [...m.root.querySelectorAll<HTMLElement>(".cp-tasks .cp-task-row .cp-task-title")].map((e) => e.textContent.trim()).sort();

describe("sidebar tag tree", () => {
	it("shows a parent row with its children indented, by their last segment", async () => {
		const m = await mount();
		expect(labels(m)).toEqual(["Errands", "Programming", "Go", "Python"]);
		const depth = (l: string) => rowFor(m, l).closest("li")!.parentElement!.closest("li") !== null;
		expect(depth("Programming")).toBe(false);
		expect(depth("Go")).toBe(true);
		expect(depth("Python")).toBe(true);
	});

	it("an implicit parent counts each descendant task once; children count their own", async () => {
		const m = await mount();
		const count = (l: string) => rowFor(m, l).querySelector(".cp-count")?.textContent;
		expect(count("Programming")).toBe("3");
		expect(count("Go")).toBe("2");
		expect(count("Python")).toBe("2");
		expect(count("Errands")).toBe("1");
	});

	it("the fold arrow is a labelled button with aria-expanded, and hides and shows the children", async () => {
		const m = await mount();
		const btn = fold(m, "Programming");
		expect(btn.tagName).toBe("BUTTON");
		expect(btn.getAttribute("aria-expanded")).toBe("true");
		expect(btn.getAttribute("aria-label")).toBe("Collapse Programming");
		expect(btn.tabIndex).toBeGreaterThanOrEqual(0);
		await click(btn);
		expect(labels(m)).toEqual(["Errands", "Programming"]);
		const after = fold(m, "Programming");
		expect(after.getAttribute("aria-expanded")).toBe("false");
		expect(after.getAttribute("aria-label")).toBe("Expand Programming");
		await click(after);
		expect(labels(m)).toEqual(["Errands", "Programming", "Go", "Python"]);
	});

	it("a leaf has no fold button, and the container is labelled without an aria-label", async () => {
		const m = await mount();
		expect(fold(m, "Errands")).toBeNull();
		expect(fold(m, "Go")).toBeNull();
		expect(sidebar(m).querySelector(".cp-tag-tree")!.getAttribute("aria-label")).toBeNull();
	});

	it("clicking the implicit parent opens its view with both tasks; a child shows its own", async () => {
		const m = await mount();
		await click(rowFor(m, "Programming"));
		expect(m.root.querySelector(".cp-main-title")!.textContent).toBe("@Programming");
		expect(rowFor(m, "Programming").getAttribute("aria-current")).toBe("page");
		expect(rowTitles(m)).toEqual(["Both", "Go task", "Python task"]);
		await click(rowFor(m, "Go"));
		expect(rowTitles(m)).toEqual(["Both", "Go task"]);
	});

	it("an implicit parent has no color dot and no menu; a real tag keeps both", async () => {
		const m = await mount();
		const dot = (l: string) => rowFor(m, l).querySelector(".cp-tag-dot")!;
		expect(dot("Programming").classList.contains("cp-tag-none")).toBe(true);
		expect(dot("Go").classList.contains("cp-tag-none")).toBe(false);
		rowFor(m, "Programming").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		await settle();
		expect(m.host.menus).toHaveLength(0);
		rowFor(m, "Go").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		await settle();
		expect(m.host.menus).toHaveLength(1);
	});

	it("task rows keep the full display name of the tag", async () => {
		const m = await mount();
		await click(rowFor(m, "Go"));
		const pill = m.root.querySelector(".cp-tasks .cp-task-row .cp-tag-pill")!;
		expect(pill.textContent).toContain("Programming/Go");
	});
});

describe("tag tree: delete and expansion (review fixes 9-11)", () => {
	const menuOf = async (m: CalMount, label: string) => {
		rowFor(m, label).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		await settle();
		return m.host.menus.at(-1)!;
	};
	const deleteItem = (menu: Awaited<ReturnType<typeof menuOf>>) => menuItem(menu, "Delete");

	it("deleting the open tag goes back to Inbox; deleting a tag whose children remain keeps its view", async () => {
		const m = await mount();
		await m.h.app.tags.create("Programming");
		await settle();
		m.host.choose = (async () => true) as unknown as typeof m.host.choose;
		// A real parent with children: the open view stays (the implicit parent is still there).
		await click(rowFor(m, "Programming"));
		deleteItem(await menuOf(m, "Programming")).run();
		await settle();
		expect(m.root.querySelector(".cp-main-title")!.textContent).toBe("@Programming");
		// A leaf: its view goes away, so the list returns to Inbox.
		await click(rowFor(m, "Go"));
		expect(m.root.querySelector(".cp-main-title")!.textContent).toBe("@Programming/Go");
		deleteItem(await menuOf(m, "Go")).run();
		await settle();
		expect(m.root.querySelector(".cp-main-title")!.textContent).toBe("Inbox");
	});

	it("a delete that leaves nothing at or under the open key returns to Inbox", async () => {
		const m = await mount();
		m.host.choose = (async () => true) as unknown as typeof m.host.choose;
		await click(rowFor(m, "Errands"));
		deleteItem(await menuOf(m, "Errands")).run();
		await settle();
		expect(m.root.querySelector(".cp-main-title")!.textContent).toBe("Inbox");
	});

	it("the confirmation on a real parent says the child tags are kept, with the exact-key count", async () => {
		const m = await mount();
		await m.h.app.tasks.create({ title: "Parent only", newTags: ["Programming"] });
		await settle();
		const messages: string[] = [];
		m.host.choose = (async (_t: string, message: string) => {
			messages.push(message);
			return null;
		}) as unknown as typeof m.host.choose;
		deleteItem(await menuOf(m, "Programming")).run();
		await settle();
		deleteItem(await menuOf(m, "Errands")).run();
		await settle();
		expect(messages[0]).toBe('Remove the tag "Programming" from 1 task? Its child tags are kept.');
		expect(messages[1]).toBe("Delete @Errands? It is removed from 1 task.");
	});

	it("opening a tag view expands its collapsed ancestors, once, so a later fold sticks", async () => {
		const m = await mount();
		// A deeper tag can only come from a loaded file, so it is put in directly.
		await m.h.app.store.run("Seed", (tx) =>
			tx.put("tags", { key: "programming/go/tools", displayName: "Programming/Go/Tools", color: null, createdAt: tx.now, modifiedAt: tx.now }),
		);
		await settle();
		const holder = document.createElement("div");
		document.body.appendChild(holder);
		const state = m.h.app.store.state;
		const draw = (view: TaskView) =>
			render(<Sidebar host={m.host} state={state} counts={sidebarCounts(state, { today: "2026-10-01", zone: "Europe/Berlin" } as never)} view={view} onView={() => undefined} />, holder);
		const names = () => [...holder.querySelectorAll(".cp-tag-tree .cp-sidebar-label")].map((e) => e.textContent);
		const foldBtn = (l: string) => holder.querySelector<HTMLButtonElement>(`.cp-tag-fold[data-tag-label="${l}"]`)!;
		try {
			draw({ kind: "inbox" });
			await settle();
			await click(foldBtn("Go"));
			await click(foldBtn("Programming"));
			expect(names()).toEqual(["Errands", "Programming"]);
			draw({ kind: "tag", key: "programming/go/tools" });
			await settle();
			expect(names()).toEqual(["Errands", "Programming", "Go", "Tools", "Python"]);
			// Folding afterwards is the user's choice: a re-render of the same view leaves it.
			await click(foldBtn("Programming"));
			draw({ kind: "tag", key: "programming/go/tools" });
			await settle();
			expect(names()).toEqual(["Errands", "Programming"]);
		} finally {
			render(null, holder);
			holder.remove();
		}
	});
});
