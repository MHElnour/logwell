// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Quadrant } from "../../src/domain/queries";
import type { DateSpec, Task } from "../../src/domain/types";
import type { MenuItemSpec } from "../../src/ui/host";
import { ICON } from "../../src/ui/icons";
import { routeMatrixMove } from "../../src/ui/matrix/keys";
import { QuickAddModel } from "../../src/ui/quickadd/QuickAddModel";
import { byLabel } from "./calendar-helpers";
import { checkedOf, menuTitles, openViewMenu, pickItem, viewButton } from "./view-menu-helpers";
import { type CalMount, card, cardsIn, click, completedToggle, dragTo, groupLabels, matrix, mountMatrix, openMatrix, press, quadrantEl, quadrantOfCard, releaseAt, settle, stubQuadrantRects, titlesIn } from "./matrix-helpers";
import { QUADRANT_ORDER, quadrantFlags } from "../../src/domain/matrix";
import { QUADRANT_INFO, QUADRANT_LIST, quadrantWords } from "../../src/ui/matrix/quadrants";

describe("matrix section", () => {
	// The Eisenhower matrix section. Today is 2026-10-01 (Europe/Berlin).

	const mounted: CalMount[] = [];
	afterEach(() => {
		for (const m of mounted.splice(0)) m.unmount();
	});
	async function mount() {
		const m = await mountMatrix();
		mounted.push(m);
		return m;
	}

	const day = (date: string): DateSpec => ({ kind: "date", date });
	const at = (date: string, time: string): DateSpec => ({ kind: "datetime", local: `${date}T${time}`, tz: "Europe/Berlin" });
	const iconOf = (el: Element | null) => el?.querySelector("[data-icon]")?.getAttribute("data-icon");

	async function seed(m: CalMount) {
		const T = m.h.app.tasks;
		await T.create({ title: "Ship report", urgent: true, important: true, scheduled: day("2026-09-30") });
		const study = await T.create({ title: "Study", urgent: true, important: true, scheduled: at("2026-10-01", "19:00") });
		await T.create({ title: "Read book", important: true, scheduled: day("2026-10-03") });
		await T.create({ title: "Reply", urgent: true });
		await T.create({ title: "Sort photos" });
		await T.create({ title: "Child", parentId: study.task.id, important: true });
		const done = await T.create({ title: "Done thing", urgent: true });
		await T.complete(done.task.id);
		await settle();
	}

	const task = (m: CalMount, title: string): Task => [...m.h.app.store.state.tasks.values()].find((t) => t.title === title)!;
	const flags = (m: CalMount, title: string) => {
		const t = task(m, title);
		return { urgent: t.urgent, important: t.important };
	};

	describe("rail and section state", () => {
		it("puts Matrix after Calendar and before Search, with the layout-grid icon", async () => {
			const m = await mount();
			const rail = [...m.root.querySelectorAll<HTMLElement>(".cp-rail > *")];
			expect(rail.map((k) => k.getAttribute("aria-label") ?? k.className)).toEqual(["Tasks", "Calendar", "Focus", "Habits", "Matrix", "Search", "cp-rail-spacer", "Data"]);
			expect(iconOf(byLabel(m.root, "Matrix"))).toBe("layout-grid");
			expect(ICON.railMatrix).toBe("layout-grid");
		});

		it("shows the section only when its rail button is active, and opens from the app handle", async () => {
			const m = await mount();
			const section = () => matrix(m.root).closest<HTMLElement>(".cp-section")!;
			expect(section().hidden).toBe(true);
			await openMatrix(m);
			expect(section().hidden).toBe(false);
			expect(byLabel(m.root, "Matrix")!.getAttribute("aria-pressed")).toBe("true");
			await click(byLabel(m.root, "Tasks"));
			expect(section().hidden).toBe(true);
			m.handle.current!.showSection("matrix");
			await settle();
			expect(section().hidden).toBe(false);
		});

		it("keeps the view menu, the Completed group and the selection while another section is shown", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			await click(completedToggle(m.root, "urgent"));
			expect(titlesIn(m.root, "urgent")).toContain("Done thing");
			await click(card(m.root, "Reply"));
			await click(byLabel(m.root, "Tasks"));
			await click(byLabel(m.root, "Matrix"));
			expect(completedToggle(m.root, "urgent")!.getAttribute("aria-expanded")).toBe("true");
			expect(titlesIn(m.root, "urgent")).toContain("Done thing");
			expect(matrix(m.root).querySelector<HTMLTextAreaElement>(".cp-details-title")?.value).toBe("Reply");
			await pickItem(m, await openViewMenu(m, matrix(m.root)), "Show completed");
			await click(byLabel(m.root, "Tasks"));
			await click(byLabel(m.root, "Matrix"));
			expect(completedToggle(m.root, "urgent")).toBeNull();
			expect(checkedOf(await openViewMenu(m, matrix(m.root)), "Show completed")).toBe(false);
		});
	});

	describe("layout (D1, D2, D5)", () => {
		it("draws four named quadrants in the grid order with badges, subtitles and add buttons", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			expect(matrix(m.root).querySelector(".cp-main-title")!.textContent).toBe("Eisenhower matrix");
			const sections = [...matrix(m.root).querySelectorAll<HTMLElement>("section.cp-matrix-q")];
			expect(sections.map((s) => s.dataset.quadrant)).toEqual(["urgent-important", "important", "urgent", "neither"]);
			expect(sections.map((s) => document.getElementById(s.getAttribute("aria-labelledby")!)!.textContent)).toEqual([
				"Urgent and important",
				"Important, not urgent",
				"Urgent, not important",
				"Neither",
			]);
			expect(sections.map((s) => s.querySelector(".cp-q-badge")!.textContent)).toEqual(["I", "II", "III", "IV"]);
			expect(sections.map((s) => s.querySelector(".cp-matrix-q-sub")!.textContent)).toEqual(["Do it", "Plan it", "Delegate it", "Drop it"]);
			expect(sections.map((s) => s.querySelector(".cp-matrix-q-add")!.getAttribute("aria-label"))).toEqual([
				"Add to urgent and important",
				"Add to important, not urgent",
				"Add to urgent, not important",
				"Add to neither urgent nor important",
			]);
			for (const s of sections) expect(s.hasAttribute("aria-label")).toBe(false);
		});

		it("puts tasks in their quadrant and date group, hides completed, and shows the empty line", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			expect(titlesIn(m.root, "urgent-important")).toEqual(["Ship report", "Study"]);
			expect(groupLabels(m.root, "urgent-important")).toEqual(["Overdue", "Today"]);
			expect(titlesIn(m.root, "important")).toEqual(["Read book", "Study › Child"]);
			expect(groupLabels(m.root, "important")).toEqual(["Next 7 days", "No date"]);
			expect(titlesIn(m.root, "urgent")).toEqual(["Reply"]);
			expect(titlesIn(m.root, "neither")).toEqual(["Sort photos"]);
			await click(quadrantEl(m.root, "neither").querySelector(".cp-matrix-q-add")); // no crash without a host quickAdd
		});

		it("shows 'No tasks' in an empty quadrant", async () => {
			const m = await mount();
			await m.h.app.tasks.create({ title: "Only one", urgent: true });
			await settle();
			await openMatrix(m);
			expect(quadrantEl(m.root, "neither").querySelector(".cp-matrix-q-empty")!.textContent).toBe("No tasks");
			expect(quadrantEl(m.root, "neither").querySelector('[role="listbox"]')).toBeNull();
		});

		it("a subtask is a flat card in its own quadrant with the parent prefix (B42)", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const child = card(m.root, "Child");
			expect(quadrantOfCard(child)).toBe("important");
			expect(child.querySelector(".cp-parent-prefix")!.textContent).toBe("Study › ");
			expect(child.classList.contains("is-subtask")).toBe(false);
		});

		it("ends each quadrant with a collapsed Completed group, and Show completed hides it (spec §7)", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const menu = await openViewMenu(m, matrix(m.root));
			expect(menuTitles(menu)).toEqual(["Lists…", "Tags…", "Show completed"]);
			expect(checkedOf(menu, "Show completed")).toBe(true);
			expect(groupLabels(m.root, "urgent")).toEqual(["No date", "Completed · 1"]);
			expect(completedToggle(m.root, "urgent")!.getAttribute("aria-expanded")).toBe("false");
			expect(titlesIn(m.root, "urgent")).toEqual(["Reply"]);
			await click(completedToggle(m.root, "urgent"));
			expect(titlesIn(m.root, "urgent")).toEqual(["Reply", "Done thing"]);
			await pickItem(m, menu, "Show completed");
			expect(groupLabels(m.root, "urgent")).toEqual(["No date"]);
		});

		it("Lists and Tags narrow the matrix, with the dot on the button", async () => {
			const m = await mount();
			const study = await m.h.app.categories.create("Study", null);
			await m.h.app.tags.create("focus", "red");
			await m.h.app.tasks.create({ title: "Essay", categoryId: study.id, urgent: true });
			await m.h.app.tasks.create({ title: "Chore", urgent: true, tagKeys: ["focus"] });
			await m.h.app.tasks.create({ title: "Plain", urgent: true });
			await openMatrix(m);
			expect(viewButton(matrix(m.root))!.querySelector(".cp-view-dot")).toBeNull();
			await pickItem(m, (await pickItem(m, await openViewMenu(m, matrix(m.root)), "Lists…"))!, "Study");
			expect(titlesIn(m.root, "urgent")).toEqual(["Essay"]);
			expect(viewButton(matrix(m.root))!.querySelector(".cp-view-dot")).not.toBeNull();
			await pickItem(m, (await pickItem(m, await openViewMenu(m, matrix(m.root)), "Lists…"))!, "Study");
			expect(viewButton(matrix(m.root))!.querySelector(".cp-view-dot")).toBeNull();
			await pickItem(m, (await pickItem(m, await openViewMenu(m, matrix(m.root)), "Tags…"))!, "@focus");
			expect(titlesIn(m.root, "urgent")).toEqual(["Chore"]);
			expect(viewButton(matrix(m.root))!.querySelector(".cp-view-dot")).not.toBeNull();
		});

		it("shows more than 20 completed cards 20 at a time", async () => {
			const m = await mount();
			for (let i = 0; i < 25; i++) {
				const t = await m.h.app.tasks.create({ title: `Done ${String(i).padStart(2, "0")}`, urgent: true });
				m.h.clock.advance(1000);
				await m.h.app.tasks.complete(t.task.id);
			}
			await settle();
			await openMatrix(m);
			await click(completedToggle(m.root, "urgent"));
			expect(titlesIn(m.root, "urgent")).toHaveLength(20);
			expect(titlesIn(m.root, "urgent")[0]).toBe("Done 24");
			await click(quadrantEl(m.root, "urgent").querySelector(".cp-completed-more"));
			expect(titlesIn(m.root, "urgent")).toHaveLength(25);
			expect(quadrantEl(m.root, "urgent").querySelector(".cp-completed-more")).toBeNull();
		});

		it("has no sort in the matrix (PRI-04, MAT-06) but has it in Tasks", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			expect(menuTitles(await openViewMenu(m, matrix(m.root)))).not.toContain("Sort: by priority");
			await click(byLabel(m.root, "Tasks"));
			const tasks = m.root.querySelector<HTMLElement>(".cp-tasks")!;
			expect(menuTitles(await openViewMenu(m, tasks))).toContain("Sort: by priority");
		});

		it("selecting a card opens the shared details inside the matrix", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			await click(card(m.root, "Reply"));
			expect(matrix(m.root).querySelector(".cp-details-pane .cp-details")).not.toBeNull();
			expect(card(m.root, "Reply").classList.contains("is-selected")).toBe(true);
		});

		it("arrows without Alt move between cards inside the quadrant", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const [first, second] = cardsIn(m.root, "urgent-important");
			first!.focus();
			await press(first!, "ArrowDown");
			expect(document.activeElement).toBe(second);
			expect(task(m, "Study").urgent).toBe(true);
		});
	});

	describe("per-quadrant add button (D6)", () => {
		it("opens Quick Add with the quadrant's flags", async () => {
			const m = await mount();
			const spy = vi.fn();
			m.host.quickAdd = spy;
			await openMatrix(m);
			await click(byLabel(matrix(m.root), "Add to urgent, not important"));
			await click(byLabel(matrix(m.root), "Add to neither urgent nor important"));
			expect(spy.mock.calls).toEqual([[{ urgent: true, important: false }], [{ urgent: false, important: false }]]);
		});

		it("the model starts from the preset flags, keeps them after a keep-open reset, and saves them", async () => {
			const m = await mount();
			const model = new QuickAddModel(
				{
					app: m.h.app,
					preset: { urgent: true, important: true },
					locale: () => "en",
					resolveNote: () => [],
					onSaved: () => undefined,
					onError: (e) => {
						throw e;
					},
					keepOpen: () => true,
					onClose: () => undefined,
				},
				() => undefined,
			);
			expect([model.urgent, model.important]).toEqual([true, true]);
			model.setFlag("important", false);
			model.setInput("Call Sam");
			expect(await model.submit()).toBe("saved");
			expect(flags(m, "Call Sam")).toEqual({ urgent: true, important: false });
			expect([model.urgent, model.important]).toEqual([true, true]);
		});
	});

	describe("menu moves (D7, MAT-03, AS-13)", () => {
		const quadrantItems = (items: readonly (MenuItemSpec | "separator")[]) =>
			items.filter((i): i is MenuItemSpec => i !== "separator" && i.title.startsWith("Move to quadrant"));

		it("retitles the four items and checks the current quadrant", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			card(m.root, "Reply").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
			const items = quadrantItems(m.host.menus.at(-1)!);
			expect(items.map((i) => i.title)).toEqual([
				"Move to quadrant: urgent and important",
				"Move to quadrant: important, not urgent",
				"Move to quadrant: urgent, not important",
				"Move to quadrant: neither",
			]);
			expect(items.map((i) => i.checked)).toEqual([false, false, true, false]);
		});

		it("AS-13: the menu move keeps the ID, sets both flags, and the chip and details show it", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const id = task(m, "Sort photos").id;
			card(m.root, "Sort photos").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
			quadrantItems(m.host.menus.at(-1)!)[0]!.run();
			await settle();
			const moved = card(m.root, "Sort photos");
			expect(quadrantOfCard(moved)).toBe("urgent-important");
			expect(moved.dataset.taskId).toBe(id);
			expect(task(m, "Sort photos")).toMatchObject({ id, urgent: true, important: true });
			expect(moved.querySelector(".cp-meta-matrix")).toBeNull();
			await click(moved);
			await click(matrix(m.root).querySelector(".cp-details .cp-due-chip"));
			const field = [...matrix(m.root).querySelectorAll<HTMLElement>(".cp-details .cp-field")].find((f) => f.querySelector("label")?.textContent === "Matrix")!;
			const select = field.querySelector<HTMLSelectElement>("select")!;
			expect(select.value).toBe("urgent-important");
		});
	});

	describe("keyboard moves (D8)", () => {
		it("keys 1 to 4 move the focused card and keep focus on it in the new quadrant", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const id = task(m, "Reply").id;
			const expected: [string, Quadrant][] = [
				["1", "urgent-important"],
				["2", "important"],
				["3", "urgent"],
				["4", "neither"],
			];
			for (const [key, q] of expected) {
				const row = card(m.root, "Reply");
				row.focus();
				if (quadrantOfCard(row) === q) continue;
				await press(row, key);
				const now = card(m.root, "Reply");
				expect(quadrantOfCard(now)).toBe(q);
				expect(now.dataset.taskId).toBe(id);
				expect(document.activeElement).toBe(now);
			}
			expect(flags(m, "Reply")).toEqual({ urgent: false, important: false });
		});

		it("announces the move in a polite live region", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const row = card(m.root, "Reply");
			row.focus();
			await press(row, "2");
			const live = matrix(m.root).querySelector('[aria-live="polite"]')!;
			expect(live.textContent).toBe("Moved to Important, not urgent");
		});

		it("Alt+Arrow moves to the adjacent quadrant, with no wrap and no move between cards", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			let row = card(m.root, "Reply"); // III, bottom left
			row.focus();
			await press(row, "ArrowLeft", { altKey: true });
			expect(quadrantOfCard(card(m.root, "Reply"))).toBe("urgent");
			await press(row, "ArrowRight", { altKey: true });
			row = card(m.root, "Reply");
			expect(quadrantOfCard(row)).toBe("neither");
			expect(document.activeElement).toBe(row);
			await press(row, "ArrowRight", { altKey: true });
			expect(quadrantOfCard(card(m.root, "Reply"))).toBe("neither");
			await press(card(m.root, "Reply"), "ArrowUp", { altKey: true });
			expect(quadrantOfCard(card(m.root, "Reply"))).toBe("important");
			await press(card(m.root, "Reply"), "ArrowLeft", { altKey: true });
			expect(quadrantOfCard(card(m.root, "Reply"))).toBe("urgent-important");
			await press(card(m.root, "Reply"), "ArrowUp", { altKey: true });
			expect(quadrantOfCard(card(m.root, "Reply"))).toBe("urgent-important");
			expect(document.activeElement).toBe(card(m.root, "Reply"));
		});

		it("a key for the current quadrant writes nothing", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const before = task(m, "Reply").modifiedAt;
			const row = card(m.root, "Reply");
			row.focus();
			await press(row, "3");
			expect(task(m, "Reply").modifiedAt).toBe(before);
			expect(matrix(m.root).querySelector('[aria-live="polite"]')!.textContent).toBe("");
		});

		it("ignores the keys with Ctrl or Meta", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const row = card(m.root, "Reply");
			row.focus();
			await press(row, "1", { ctrlKey: true });
			await press(row, "1", { metaKey: true });
			expect(quadrantOfCard(card(m.root, "Reply"))).toBe("urgent");
		});
	});

	describe("drag (D10, AS-13)", () => {
		it("dragging a card onto a quadrant moves it, same ID, one undo entry", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const centers = stubQuadrantRects(m.root);
			const id = task(m, "Sort photos").id;
			const row = card(m.root, "Sort photos");
			await dragTo(row, centers.neither, centers["urgent-important"]);
			const moved = card(m.root, "Sort photos");
			expect(quadrantOfCard(moved)).toBe("urgent-important");
			expect(task(m, "Sort photos")).toMatchObject({ id, urgent: true, important: true });
			expect(moved.querySelector(".cp-meta-matrix")).toBeNull();
			expect(m.host.messages.at(-1)).toBe('Moved "Sort photos" to Urgent and important.');
			expect(matrix(m.root).querySelector(".cp-matrix-ghost")).toBeNull();
			await expect(m.host.undoButtons.at(-1)!()).resolves.toBe(true);
			expect(flags(m, "Sort photos")).toEqual({ urgent: false, important: false });
			expect(task(m, "Sort photos").id).toBe(id);
		});

		it("moves a card to each of the four quadrants", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const centers = stubQuadrantRects(m.root);
			for (const q of ["urgent-important", "important", "urgent", "neither"] as Quadrant[]) {
				const row = card(m.root, "Read book");
				await dragTo(row, centers[quadrantOfCard(row) as Quadrant], centers[q]);
				expect(quadrantOfCard(card(m.root, "Read book"))).toBe(q);
			}
			expect(flags(m, "Read book")).toEqual({ urgent: false, important: false });
			// A schedule or a deadline never moved the task by itself.
			expect(task(m, "Read book").scheduled).toEqual(day("2026-10-03"));
		});

		it("marks the target quadrant and the card while dragging; Escape cancels and writes nothing", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const centers = stubQuadrantRects(m.root);
			const row = card(m.root, "Sort photos");
			const before = task(m, "Sort photos").modifiedAt;
			await dragTo(row, centers.neither, centers.important, false);
			expect(row.classList.contains("is-dragging")).toBe(true);
			expect(quadrantEl(m.root, "important").classList.contains("is-drop-target")).toBe(true);
			expect(quadrantEl(m.root, "neither").classList.contains("is-drop-target")).toBe(false);
			expect(matrix(m.root).querySelector(".cp-matrix-ghost")).not.toBeNull();
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			await settle();
			expect(row.classList.contains("is-dragging")).toBe(false);
			expect(matrix(m.root).querySelector(".cp-matrix-ghost")).toBeNull();
			expect(matrix(m.root).querySelector(".is-drop-target")).toBeNull();
			expect(quadrantOfCard(card(m.root, "Sort photos"))).toBe("neither");
			expect(task(m, "Sort photos").modifiedAt).toBe(before);
			expect(matrix(m.root).querySelector(".cp-details")).toBeNull();
		});

		it("a drop on the card's own quadrant or outside every quadrant writes nothing", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const centers = stubQuadrantRects(m.root);
			const before = task(m, "Sort photos").modifiedAt;
			await dragTo(card(m.root, "Sort photos"), centers.neither, { x: 900, y: 700 });
			await dragTo(card(m.root, "Sort photos"), centers.neither, { x: 5000, y: 5000 });
			expect(task(m, "Sort photos").modifiedAt).toBe(before);
		});

		it("a press that barely moves is a click and opens the details", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			stubQuadrantRects(m.root);
			const row = card(m.root, "Reply");
			row.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0 }));
			row.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: 11, clientY: 11 }));
			await click(row);
			expect(matrix(m.root).querySelector<HTMLTextAreaElement>(".cp-details-title")?.value).toBe("Reply");
			expect(quadrantOfCard(card(m.root, "Reply"))).toBe("urgent");
		});

		it("does not start a drag from the checkbox", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const centers = stubQuadrantRects(m.root);
			const box = card(m.root, "Reply").querySelector<HTMLElement>("input")!;
			await dragTo(box, centers.urgent, centers.neither, false);
			expect(matrix(m.root).querySelector(".cp-matrix-ghost")).toBeNull();
		});
	});

	describe("Alt+Arrow routing from the view Scope", () => {
		const alt = (key: string) => new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true });

		it("a focused card gets the move and the key is consumed", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const row = card(m.root, "Reply"); // III
			row.focus();
			expect(routeMatrixMove(m.root, alt("ArrowRight"))).toBe(true);
			await settle();
			expect(quadrantOfCard(card(m.root, "Reply"))).toBe("neither");
			expect(document.activeElement).toBe(card(m.root, "Reply"));
		});

		it("focus elsewhere in the view or outside the matrix leaves the key to Obsidian", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			(document.activeElement as HTMLElement | null)?.blur();
			expect(routeMatrixMove(m.root, alt("ArrowLeft"))).toBe(false);
			const add = quadrantEl(m.root, "urgent").querySelector<HTMLElement>(".cp-matrix-q-add")!;
			add.focus();
			expect(routeMatrixMove(m.root, alt("ArrowLeft"))).toBe(false);
			// A card of another container does not count either.
			const other = document.createElement("div");
			card(m.root, "Reply").focus();
			expect(routeMatrixMove(other, alt("ArrowRight"))).toBe(false);
			await settle();
			expect(quadrantOfCard(card(m.root, "Reply"))).toBe("urgent");
		});

		it("a key the Scope handled is not moved a second time by the page's own handler", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const row = card(m.root, "Reply");
			row.focus();
			const evt = alt("ArrowRight");
			expect(routeMatrixMove(m.root, evt)).toBe(true);
			row.dispatchEvent(evt);
			await settle();
			expect(quadrantOfCard(card(m.root, "Reply"))).toBe("neither");
		});
	});

	describe("matrix live region, drag state and overlays", () => {
		it("announces every move, also two identical messages in a row", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const live = matrix(m.root).querySelector('[aria-live="polite"]')!;
			const seen: string[] = [];
			const observer = new MutationObserver(() => seen.push(live.textContent ?? ""));
			observer.observe(live, { childList: true, characterData: true, subtree: true });
			let row = card(m.root, "Reply");
			row.focus();
			await press(row, "2");
			expect(live.textContent).toBe("Moved to Important, not urgent");
			await new Promise<void>((r) => queueMicrotask(r));
			seen.length = 0;
			row = card(m.root, "Sort photos");
			row.focus();
			await press(row, "2");
			await new Promise<void>((r) => queueMicrotask(r));
			observer.disconnect();
			// Cleared, then set again: the second identical message is a real DOM change.
			expect(seen).toContain("");
			expect(seen.at(-1)).toBe("Moved to Important, not urgent");
		});

		it("a right press during a drag does not cancel it", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const centers = stubQuadrantRects(m.root);
			const row = card(m.root, "Sort photos");
			await dragTo(row, centers.neither, centers.important, false);
			const other = card(m.root, "Reply");
			other.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 }));
			await settle();
			expect(matrix(m.root).querySelector(".cp-matrix-ghost")).not.toBeNull();
			await releaseAt(row, centers.important);
			expect(quadrantOfCard(card(m.root, "Sort photos"))).toBe("important");
		});

		it("is-dragging and is-drop-target come from state: a re-render during the drag keeps them", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const centers = stubQuadrantRects(m.root);
			const row = card(m.root, "Sort photos");
			await click(row);
			expect(row.classList.contains("is-selected")).toBe(true);
			await dragTo(row, centers.neither, centers.important, false);
			// Closing the details changes the row's class (is-selected) while the drag is active.
			await click(matrix(m.root).querySelector('[aria-label="Close details"]'));
			const same = card(m.root, "Sort photos");
			expect(same).toBe(row);
			expect(same.classList.contains("is-selected")).toBe(false);
			expect(same.classList.contains("is-dragging")).toBe(true);
			expect(matrix(m.root).querySelector(".cp-matrix-grid")!.classList.contains("is-dragging-card")).toBe(true);
			expect(quadrantEl(m.root, "important").classList.contains("is-drop-target")).toBe(true);
			await releaseAt(row, centers.important);
			expect(card(m.root, "Sort photos").classList.contains("is-dragging")).toBe(false);
			expect(matrix(m.root).querySelector(".is-dragging-card")).toBeNull();
		});

		it("a drop whose point is over the details pane is refused", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const centers = stubQuadrantRects(m.root);
			await click(card(m.root, "Reply"));
			const pane = matrix(m.root).querySelector<HTMLElement>(".cp-details-pane")!;
			const doc = document as unknown as { elementFromPoint?: unknown };
			doc.elementFromPoint = () => pane;
			try {
				const before = task(m, "Sort photos").modifiedAt;
				await dragTo(card(m.root, "Sort photos"), centers.neither, centers.important, false);
				expect(quadrantEl(m.root, "important").classList.contains("is-drop-target")).toBe(false);
				await dragTo(card(m.root, "Sort photos"), centers.neither, centers.important);
				expect(task(m, "Sort photos").modifiedAt).toBe(before);
			} finally {
				delete doc.elementFromPoint;
			}
		});

		it("tasks in the trash are not shown", async () => {
			const m = await mount();
			await seed(m);
			const gone = await m.h.app.tasks.create({ title: "Binned", urgent: true });
			await m.h.app.tasks.delete(gone.task.id);
			await openMatrix(m);
			expect(titlesIn(m.root, "urgent")).not.toContain("Binned");
			expect(matrix(m.root).textContent).not.toContain("Binned");
		});

		it("the drag ghost has its own card styles (it lives outside the quadrant)", () => {
			const css = readFileSync(join(process.cwd(), "styles.css"), "utf8");
			const block = /\.cp-matrix-ghost \{([^}]*)\}/.exec(css)?.[1] ?? "";
			for (const prop of ["background: var(--background-primary)", "border:", "border-radius: 10px", "height: 46px", "box-shadow"]) expect(block).toContain(prop);
		});

		it("cards have no matrix chip, the header holds the view menu, and the row meta thins out per quadrant", async () => {
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			expect(card(m.root, "Ship report").querySelector(".cp-meta-matrix")).toBeNull();
			const header = matrix(m.root).querySelector(".cp-matrix-header")!;
			expect(header.querySelector(".cp-main-title")).not.toBeNull();
			expect(header.querySelector(".cp-view-menu-button")).not.toBeNull();
			expect(header.querySelector(".cp-filter-bar")).toBeNull();
			const css = readFileSync(join(process.cwd(), "styles.css"), "utf8");
			const body = /\.cp-matrix-q-body \{([^}]*)\}/.exec(css)?.[1] ?? "";
			expect(body).toContain("container-type: inline-size");
			expect(body).toContain("container-name: cp-list");
			// The @container cp-list rules are the ones that thin the meta; they now match inside a quadrant.
			for (const w of ["560px", "440px", "340px"]) expect(css).toContain(`@container cp-list (max-width: ${w})`);
		});
	});

	describe("D8: autoscroll in a quadrant", () => {
		it("scrolls the quadrant body while a card is held near its bottom edge, and stops on drop", async () => {
			const frames: FrameRequestCallback[] = [];
			const m = await mount();
			await seed(m);
			await openMatrix(m);
			const centers = stubQuadrantRects(m.root);
			const body = quadrantEl(m.root, "urgent-important").querySelector<HTMLElement>(".cp-matrix-q-body")!;
			body.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400, x: 0, y: 0, toJSON: () => ({}) });
			for (const [k, v] of [
				["scrollHeight", 1500],
				["clientHeight", 400],
			] as const) Object.defineProperty(body, k, { value: v, configurable: true });
			window.requestAnimationFrame = (cb) => frames.push(cb);
			const run = () => frames.splice(0).forEach((cb) => cb(0));
			const row = card(m.root, "Study");
			await dragTo(row, centers["urgent-important"], { x: 250, y: 395 }, false);
			run();
			run();
			expect(body.scrollTop).toBeGreaterThan(0);
			const at0 = body.scrollTop;
			await releaseAt(row, { x: 250, y: 395 });
			run();
			expect(body.scrollTop).toBe(at0);
		});
	});
});

// Issue 26: one name per quadrant, one table, one way to join the quadrant words.

describe("quadrant names", () => {
	it("are the same in the matrix headings, menus and filter chips", () => {
		expect(QUADRANT_ORDER.map((q) => QUADRANT_INFO[q].title)).toEqual([
			"Urgent and important",
			"Important, not urgent",
			"Urgent, not important",
			"Neither",
		]);
		expect(QUADRANT_LIST.map((q) => q.id)).toEqual([...QUADRANT_ORDER]);
	});

	it("carry the flags the domain gives each quadrant", () => {
		for (const q of QUADRANT_LIST) expect({ urgent: q.urgent, important: q.important }).toEqual(quadrantFlags(q.id));
	});
});

describe("quadrantWords", () => {
	it("joins the set flags with a dot", () => {
		expect(quadrantWords(true, true)).toBe("Urgent · Important");
		expect(quadrantWords(true, false)).toBe("Urgent");
		expect(quadrantWords(false, true)).toBe("Important");
		expect(quadrantWords(false, false)).toBe("");
	});
});
