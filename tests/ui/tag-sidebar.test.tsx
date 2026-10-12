// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sidebarCounts, type TaskView } from "../../src/app/views";
import { Sidebar } from "../../src/ui/Sidebar";
import { type CalMount, click, mountCal, settle } from "./m3-helpers";
import { menuItem } from "./u1-helpers";
import { CREATE_TAG_LABEL } from "../../src/app/CategoryService";
import { paletteColor } from "../../src/domain/types";
import type { QuickAddPreset, TagDialogOptions, TagDialogValues } from "../../src/ui/host";

describe("the tag tree", () => {
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

		it("a parent counts each descendant task once; children count their own", async () => {
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

		it("clicking the parent opens its view with both tasks; a child shows its own", async () => {
			const m = await mount();
			await click(rowFor(m, "Programming"));
			expect(m.root.querySelector(".cp-main-title")!.textContent).toBe("@Programming");
			expect(rowFor(m, "Programming").getAttribute("aria-current")).toBe("page");
			expect(rowTitles(m)).toEqual(["Both", "Go task", "Python task"]);
			await click(rowFor(m, "Go"));
			expect(rowTitles(m)).toEqual(["Both", "Go task"]);
		});

		it("a parent made by its first child is a tag with a color dot and a menu, like a child", async () => {
			const m = await mount();
			const dot = (l: string) => rowFor(m, l).querySelector(".cp-tag-dot")!;
			expect(dot("Programming").classList.contains("cp-tag-none")).toBe(false);
			expect(dot("Go").classList.contains("cp-tag-none")).toBe(false);
			rowFor(m, "Programming").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
			await settle();
			expect(m.host.menus).toHaveLength(1);
			rowFor(m, "Go").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
			await settle();
			expect(m.host.menus).toHaveLength(2);
		});

		it("task rows show the tag by its own name", async () => {
			const m = await mount();
			await click(rowFor(m, "Go"));
			const pill = m.root.querySelector(".cp-tasks .cp-task-row .cp-tag-pill")!;
			expect(pill.textContent).toBe("@Go");
		});
	});

	describe("tag tree: delete and expansion (review fixes 9-11)", () => {
		const menuOf = async (m: CalMount, label: string) => {
			rowFor(m, label).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
			await settle();
			return m.host.menus.at(-1)!;
		};
		const deleteItem = (menu: Awaited<ReturnType<typeof menuOf>>) => menuItem(menu, "Delete");

		it("deleting the open tag goes back to Inbox", async () => {
			const m = await mount();
			m.host.choose = (async () => true) as unknown as typeof m.host.choose;
			// A leaf: its view goes away, so the list returns to Inbox.
			await click(rowFor(m, "Go"));
			expect(m.root.querySelector(".cp-main-title")!.textContent).toBe("@Go");
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

		it("the confirmation on a parent says the child tags move to the top level, with the exact-key count", async () => {
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
			expect(messages[0]).toBe("Delete @Programming? It is removed from 1 task, and its child tags move to the top level.");
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
});

describe("New tag", () => {
	// The + beside Tags opens New tag (Lists, sections and tags rule 23b). The heading shows with no tags too.

	const mounted: CalMount[] = [];
	afterEach(() => {
		for (const m of mounted.splice(0)) m.unmount();
	});

	/** A scripted dialog: each entry is what the user submits (null = dismiss); `outcomes` collects the save results. */
	async function scripted(seed: (m: CalMount) => Promise<void>, ...submits: (TagDialogValues | null)[]) {
		const m = await mountCal();
		mounted.push(m);
		await seed(m);
		await settle();
		const outcomes: (string | null)[] = [];
		const opened: TagDialogOptions[] = [];
		const tagDialog = vi.fn(async (opts: TagDialogOptions) => {
			opened.push(opts);
			for (const v of submits.splice(0)) {
				if (v === null) return;
				const r = await opts.save(v);
				outcomes.push(r);
				if (r === null) return;
			}
		});
		(m.host as unknown as { tagDialog: typeof tagDialog }).tagDialog = tagDialog;
		await m.rerender();
		return { m, tagDialog, outcomes, opened };
	}

	const sidebar = (m: CalMount) => m.root.querySelector<HTMLElement>(".cp-sidebar")!;
	const plus = (m: CalMount) => sidebar(m).querySelector<HTMLButtonElement>('[aria-label="New tag"]');
	const treeLabels = (m: CalMount) => [...sidebar(m).querySelectorAll(".cp-tag-tree .cp-sidebar-label")].map((e) => e.textContent);
	const none = async () => undefined;

	describe("sidebar New tag", () => {
		it("the Tags heading and its + show with no tags; no tree is drawn", async () => {
			const { m } = await scripted(none);
			const heading = [...sidebar(m).querySelectorAll(".cp-sidebar-heading")].find((h) => h.textContent.includes("Tags"));
			expect(heading).toBeDefined();
			expect(plus(m)).not.toBeNull();
			expect(sidebar(m).querySelector(".cp-tag-tree")).toBeNull();
		});

		it("without the dialog in the host there is no + (the heading still shows)", async () => {
			const m = await mountCal();
			mounted.push(m);
			expect(plus(m)).toBeNull();
			expect([...sidebar(m).querySelectorAll(".cp-sidebar-heading")].some((h) => h.textContent.includes("Tags"))).toBe(true);
		});

		it("opens New tag with the next palette color and the top-level tags as parents", async () => {
			const { m, opened } = await scripted(async (m) => {
				await m.h.app.tags.create("Errands");
				await m.h.app.tags.create("Home/Calls");
				await m.h.app.store.run("Seed", (tx) => tx.put("tags", { key: "a//b", displayName: "A//B", color: null, createdAt: tx.now, modifiedAt: tx.now }));
			}, null);
			await click(plus(m));
			const o = opened[0]!;
			expect(o.title).toBe("New tag");
			expect(o.submit).toBe("Create");
			expect(o.initial).toEqual({ name: "", parent: null, color: paletteColor(4) });
			expect(o.parentLock).toBeNull();
			// A key with an empty segment is one flat tag and cannot be a parent.
			expect(o.parents).toEqual([
				{ key: "errands", label: "Errands" },
				{ key: "home", label: "Home" },
			]);
			expect(o.check("Calls", null)).toBe('The name "Calls" is already used by another tag.');
			expect(o.check("Garden", "home")).toBeNull();
		});

		it("Create makes the tag in one write, shows it in the tree, and the notice's Undo removes it", async () => {
			const { m, outcomes } = await scripted(
				async (m) => {
					await m.h.app.tags.create("Home/Calls");
				},
				{ name: "Garden", parent: "home", color: "green" },
			);
			await click(plus(m));
			await settle();
			expect(outcomes).toEqual([null]);
			expect(m.h.app.store.state.tags.get("home/garden")).toMatchObject({ displayName: "Home/Garden", color: "green" });
			expect(treeLabels(m)).toEqual(["Home", "Calls", "Garden"]);
			expect(m.host.messages.at(-1)).toBe("Created tag @Garden.");
			expect(m.h.app.store.undoLabel).toBe(CREATE_TAG_LABEL);
			await m.host.undoButtons.at(-1)!();
			await settle();
			expect(m.h.app.store.state.tags.has("home/garden")).toBe(false);
			expect(treeLabels(m)).toEqual(["Home", "Calls"]);
		});

		it("a refusal comes back as text for the dialog, which stays open, and nothing is written", async () => {
			const { m, outcomes, tagDialog } = await scripted(
				async (m) => {
					await m.h.app.tags.create("Calls");
				},
				{ name: "calls", parent: null, color: null },
				{ name: "Garden", parent: "gone", color: null },
				{ name: "Garden", parent: null, color: null },
			);
			const before = m.h.app.store.state.tags;
			await click(plus(m));
			await settle();
			expect(tagDialog).toHaveBeenCalledTimes(1);
			expect(outcomes).toEqual(['The name "Calls" is already used by another tag.', "The parent tag no longer exists.", null]);
			expect(m.h.app.store.state.tags.size).toBe(before.size + 1);
			expect(m.host.messages.filter((x) => x.startsWith("Created"))).toEqual(["Created tag @Garden."]);
		});

		it("the first tag created from an empty sidebar draws the tree", async () => {
			const { m } = await scripted(none, { name: "Errands", parent: null, color: null });
			await click(plus(m));
			await settle();
			expect(treeLabels(m)).toEqual(["Errands"]);
		});
	});
});

describe("parent tags", () => {
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
});
