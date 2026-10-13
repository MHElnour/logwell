// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { addDays } from "../../src/domain/time";
import { menuItem, mountApp, pressKey, settle, sidebarItem, typeInto } from "./app-helpers";
import { detailsDateText } from "../../src/ui/format";

describe("details pane", () => {
	// The details pane, sidebar list icon and color editing.

	async function openTask(root: HTMLElement, title: string) {
		sidebarItem(root, "Inbox").click();
		await settle();
		[...root.querySelectorAll<HTMLElement>(".cp-tasks .cp-task-row")].find((e) => e.textContent?.includes(title))!.click();
		await settle();
		return root.querySelector<HTMLElement>(".cp-tasks .cp-details")!;
	}
	const icon = (el: Element | null) => el?.querySelector("[data-icon]")?.getAttribute("data-icon");

	describe("details pane", () => {
		it("top bar: priority checkbox, date chip, priority flag, more menu", async () => {
			const { h, host, root } = await mountApp();
			const { task } = await h.app.tasks.create({
				title: "Plan",
				scheduled: { kind: "datetime", local: "2026-10-01T19:00", tz: "Europe/Berlin" },
				plannedDurationMin: 45,
			});
			await h.app.tasks.setPriority(task.id, 1);
			const d = await openTask(root, "Plan");
			const top = d.querySelector(".cp-details-top")!;
			expect(top.querySelector(".cp-task-checkbox")!.classList.contains("cp-pri-1")).toBe(true);
			const chip = top.querySelector<HTMLButtonElement>(".cp-due-chip")!;
			expect(chip.tagName).toBe("BUTTON");
			expect(chip.textContent).toContain("Today, 19:00 · 45m");
			expect(chip.classList.contains("is-today")).toBe(true);
			const flag = top.querySelector<HTMLButtonElement>('[aria-label="Priority: high"]')!;
			expect(icon(flag)).toBe("flag");
			flag.click();
			const menu = host.menus.at(-1);
			expect(menuItem(menu, "Medium").run).toBeTypeOf("function");
			menuItem(menu, "Medium").run();
			await settle();
			expect(h.app.store.state.tasks.get(task.id)?.priority).toBe(2);
			expect(top.querySelector('[aria-label="Priority: medium"]')).not.toBeNull();
			expect(top.querySelector('[aria-label="More task actions"]')).not.toBeNull();
		});

		it("shows No date and priority none", async () => {
			const { h, root } = await mountApp();
			await h.app.tasks.create({ title: "Bare" });
			const d = await openTask(root, "Bare");
			expect(d.querySelector(".cp-due-chip")?.textContent).toContain("No date");
			expect(d.querySelector('[aria-label="Priority: none"]')).not.toBeNull();
		});

		it("body: dashed add-tag button, tag pills, subtasks n / m", async () => {
			const { h, root } = await mountApp();
			const tag = await h.app.tags.create("work", "blue");
			const { task } = await h.app.tasks.create({ title: "Parent", tagKeys: [tag.key] });
			const sub = await h.app.tasks.create({ title: "Child", parentId: task.id });
			await h.app.tasks.complete(sub.task.id);
			const d = await openTask(root, "Parent");
			expect(d.querySelector(".cp-details-tags .cp-tag-pill.cp-hue-blue")?.textContent).toContain("@work");
			const add = d.querySelector<HTMLButtonElement>(".cp-add-tag")!;
			expect(add.getAttribute("aria-label")).toBe("Add tag");
			expect(d.querySelector(".cp-tag-input input")).toBeNull();
			add.click();
			await settle();
			expect(d.querySelector(".cp-tag-input input")).not.toBeNull();
			expect(d.querySelector(".cp-section-heading")?.textContent).toBeDefined();
			expect(d.querySelector(".cp-subtasks-count")?.textContent).toBe("1 / 1");
		});

		it("#106: a tag typed in Add tag for one task is not carried to the next selected task", async () => {
			const { h, root } = await mountApp();
			await h.app.tasks.create({ title: "Alpha" });
			const { task: bravo } = await h.app.tasks.create({ title: "Bravo" });
			const d = await openTask(root, "Alpha");
			d.querySelector<HTMLButtonElement>(".cp-add-tag")!.click();
			await settle();
			const typed = d.querySelector<HTMLInputElement>(".cp-tag-input input")!;
			typed.value = "errand";
			typed.dispatchEvent(new Event("input", { bubbles: true }));
			await settle();
			[...root.querySelectorAll<HTMLElement>(".cp-tasks .cp-task-row")].find((e) => e.textContent?.includes("Bravo"))!.click();
			await settle();
			const pane = root.querySelector<HTMLElement>(".cp-tasks .cp-details")!;
			expect(pane.querySelector<HTMLInputElement>(".cp-details-title")!.value).toBe("Bravo");
			const input = pane.querySelector<HTMLInputElement>(".cp-tag-input input")!;
			expect(input.value).toBe("");
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			await settle();
			expect(h.app.store.state.tasks.get(bravo.id)!.tagKeys).toEqual([]);
		});

		it("note card: none, linked (file name, open button), missing", async () => {
			const { h, host, root } = await mountApp();
			h.notes.files.set("Notes/Plan.md", "body");
			const { task } = await h.app.tasks.create({ title: "Noted" });
			let d = await openTask(root, "Noted");
			expect(d.querySelector(".cp-description.is-empty")).not.toBeNull();
			await h.app.tasks.linkNote(task.id, "Notes/Plan.md");
			await settle();
			d = root.querySelector<HTMLElement>(".cp-tasks .cp-details")!;
			const card = d.querySelector(".cp-description.is-linked")!;
			expect(card.querySelector(".cp-note-name")?.textContent).toBe("Plan");
			expect(icon(card.querySelector(".cp-note-head"))).toBe("file-text");
			const open = card.querySelector<HTMLButtonElement>('[aria-label="Open note"]')!;
			expect(icon(open)).toBe("external-link");
			open.click();
			expect(host.opened).toEqual(["Notes/Plan.md"]);
			h.notes.files.delete("Notes/Plan.md");
			host.noteEvents.emit("note", "Notes/Plan.md");
			await settle();
			expect(root.querySelector(".cp-tasks .cp-description.is-missing")).not.toBeNull();
		});

		it("note card: only the .md extension is hidden from the name", async () => {
			const { h, root } = await mountApp();
			h.notes.files.set("Files/report.pdf", "body");
			const { task } = await h.app.tasks.create({ title: "Reported" });
			await openTask(root, "Reported");
			await h.app.tasks.linkNote(task.id, "Files/report.pdf");
			await settle();
			const d = root.querySelector<HTMLElement>(".cp-tasks .cp-details")!;
			expect(d.querySelector(".cp-note-name")?.textContent).toBe("report.pdf");
		});

		it("footer: list button and an enabled Focus button that starts focus", async () => {
			const { h, host, root } = await mountApp();
			const cat = await h.app.categories.create("Work", "briefcase");
			const { task } = await h.app.tasks.create({ title: "Footed", categoryId: cat.id });
			sidebarItem(root, "Work").click();
			await settle();
			[...root.querySelectorAll<HTMLElement>(".cp-tasks .cp-task-row")].find((e) => e.textContent?.includes("Footed"))!.click();
			await settle();
			const foot = root.querySelector<HTMLElement>(".cp-tasks .cp-details-foot")!;
			const listBtn = foot.querySelector<HTMLButtonElement>(".cp-list-button")!;
			expect(listBtn.textContent).toContain("Work");
			expect(icon(listBtn)).toBe("briefcase");
			host.nextCategory = "inbox";
			listBtn.click();
			await settle();
			expect(h.app.store.state.tasks.get(task.id)?.categoryId).toBe("inbox");
			const focus = foot.querySelector<HTMLButtonElement>(".cp-focus-button")!;
			const started: (string | null)[] = [];
			host.startFocus = async (id: string | null) => {
				started.push(id);
			};
			expect(focus.disabled).toBe(false);
			expect(focus.getAttribute("aria-disabled")).toBeNull();
			expect(focus.textContent).toContain("Focus");
			expect(icon(focus)).toBe("target");
			expect(focus.getAttribute("title")).toBeNull();
			focus.click();
			expect(started).toEqual([task.id]);
		});
	});

	describe("list icon and color editing", () => {
		it("the list menu offers Change icon and Change color", async () => {
			const { h, host, root } = await mountApp();
			const cat = await h.app.categories.create("Study");
			await settle();
			sidebarItem(root, "Study").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
			const menu = host.menus.at(-1);
			host.nextIcon = "book-open";
			menuItem(menu, "Change icon…").run();
			await settle();
			expect(h.app.store.state.categories.get(cat.id)?.icon).toBe("book-open");
			expect(icon(sidebarItem(root, "Study"))).toBe("book-open");

			host.nextIcon = null;
			menuItem(menu, "Change icon…").run();
			await settle();
			expect(h.app.store.state.categories.get(cat.id)?.icon).toBeNull();

			host.nextIcon = undefined;
			menuItem(menu, "Change icon…").run();
			await settle();
			expect(h.app.store.state.categories.get(cat.id)?.icon).toBeNull();

			menuItem(menu, "Change color…").run();
			const colorMenu = host.menus.at(-1);
			menuItem(colorMenu, "Green").run();
			await settle();
			expect(h.app.store.state.categories.get(cat.id)?.color).toBe("green");
			expect(sidebarItem(root, "Study").classList.contains("cp-hue-green")).toBe(true);
			menuItem(host.menus.at(-1), "None").run();
			await settle();
			expect(h.app.store.state.categories.get(cat.id)?.color).toBeNull();
		});

		it("the color menu lists all eight colors and none, marking the current one", async () => {
			const { h, host, root } = await mountApp();
			const cat = await h.app.categories.create("Study");
			await h.app.categories.setColor(cat.id, "pink");
			await settle();
			sidebarItem(root, "Study").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
			menuItem(host.menus.at(-1), "Change color…").run();
			const items = host.menus.at(-1)!.filter((i) => i !== "separator");
			expect(items.map((i) => i.title)).toEqual(["Red", "Orange", "Yellow", "Green", "Cyan", "Blue", "Purple", "Pink", "None"]);
			expect(items.filter((i) => i.checked).map((i) => i.title)).toEqual(["Pink"]);
		});
	});

	describe("details completion checkbox", () => {
		it("reflects completing and reopening at once (checked, aria-label, no other interaction)", async () => {
			const { h, root } = await mountApp();
			const { task } = await h.app.tasks.create({ title: "Finish me" });
			const d = await openTask(root, "Finish me");
			const box = () => d.querySelector<HTMLInputElement>(".cp-details-top .cp-task-checkbox")!;
			expect(box().checked).toBe(false);
			box().click();
			await settle();
			expect(h.app.store.state.tasks.get(task.id)?.status).toBe("completed");
			expect(box().checked).toBe(true);
			expect(box().getAttribute("aria-label")).toBe('Reopen "Finish me"');
			box().click();
			await settle();
			expect(box().checked).toBe(false);
			expect(box().getAttribute("aria-label")).toBe('Complete "Finish me"');
		});
	});

	describe("details subtasks use the Quick Add parser", () => {
		const subInput = (d: HTMLElement) => d.querySelector<HTMLInputElement>(".cp-details-section .cp-qa-input")!;

		it("parses date, priority and tags, keeps the parent's category and ID", async () => {
			const { h, root } = await mountApp();
			const cat = await h.app.categories.create("Study");
			const { task: parent } = await h.app.tasks.create({ title: "Parent", categoryId: cat.id });
			sidebarItem(root, "Study").click();
			await settle();
			[...root.querySelectorAll<HTMLElement>(".cp-tasks .cp-task-row")].find((e) => e.textContent?.includes("Parent"))!.click();
			await settle();
			const d = root.querySelector<HTMLElement>(".cp-tasks .cp-details")!;
			await typeInto(subInput(d), "Read ch 2 tomorrow !1 @reading");
			await pressKey(subInput(d), "Enter");
			const subs = [...h.app.store.state.tasks.values()].filter((t) => t.parentId === parent.id);
			expect(subs).toHaveLength(1);
			const sub = subs[0]!;
			expect(sub.title).toBe("Read ch 2");
			expect(sub.scheduled).toEqual({ kind: "date", date: addDays(h.app.queryContext().today, 1) });
			expect(sub.priority).toBe(1);
			expect(sub.tagKeys).toEqual(["reading"]);
			expect(sub.categoryId).toBe(cat.id);
			// The input is empty and ready for the next one.
			expect(subInput(d).value).toBe("");
		});

		it("a typed #Category never moves a subtask (SUB-02): it stays in the parent's category", async () => {
			const { h, root } = await mountApp();
			const study = await h.app.categories.create("Study");
			const work = await h.app.categories.create("Work");
			const { task: parent } = await h.app.tasks.create({ title: "Parent", categoryId: study.id });
			sidebarItem(root, "Study").click();
			await settle();
			[...root.querySelectorAll<HTMLElement>(".cp-tasks .cp-task-row")].find((e) => e.textContent?.includes("Parent"))!.click();
			await settle();
			const d = root.querySelector<HTMLElement>(".cp-tasks .cp-details")!;
			await typeInto(subInput(d), "Draft #Work");
			await pressKey(subInput(d), "Enter");
			const sub = [...h.app.store.state.tasks.values()].find((t) => t.parentId === parent.id)!;
			expect(sub.categoryId).toBe(study.id);
			expect(sub.categoryId).not.toBe(work.id);
		});
	});
});

describe("duration in the details line", () => {
	// Issue 42: the details line writes a planned duration like a row does ("1h 30m"), not as raw minutes.

	const task = (plannedDurationMin: number | null) => ({ scheduled: null, deadline: null, plannedDurationMin });

	describe("details line duration", () => {
		it("writes 90 minutes as 1h 30m", () => {
			expect(detailsDateText(task(90), "UTC", "2026-10-10")).toBe("No date · 1h 30m");
		});

		it("writes whole hours and short durations the way formatDuration does", () => {
			expect(detailsDateText(task(120), "UTC", "2026-10-10")).toBe("No date · 2h");
			expect(detailsDateText(task(45), "UTC", "2026-10-10")).toBe("No date · 45m");
		});

		it("puts a repeat before the duration", () => {
			expect(detailsDateText(task(60), "UTC", "2026-10-10", { repeat: "every Fri" })).toBe("No date · every Fri · 1h");
		});

		it("shows nothing for a task without a duration", () => {
			expect(detailsDateText(task(null), "UTC", "2026-10-10")).toBe("No date");
		});
	});
});
