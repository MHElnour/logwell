// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { TOGGLE_COMPLETE_EVENT } from "../../src/ui/TaskList";
import { dateTone, detailsDateText, rowDateText } from "../../src/ui/format";
import { menuItem, mountU1, settle } from "./u1-helpers";

// The task row (priority look and menu), completion, list color.
const TODAY = "2026-10-01";

let current: { unmount: () => void } | null = null;
afterEach(() => {
	current?.unmount();
	current = null;
});
async function mount() {
	const m = await mountU1();
	current = m;
	return m;
}
const row = (root: HTMLElement, title: string) =>
	[...root.querySelectorAll<HTMLElement>(".cp-tasks .cp-task-row")].find((e) => e.textContent?.includes(title))!;
const openInbox = async (root: HTMLElement) => {
	[...root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes("Inbox"))!.click();
	await settle();
};

describe("date helpers", () => {
	it("tones follow the color semantics", () => {
		const d = (date: string) => ({ kind: "date" as const, date });
		expect(dateTone(d("2026-09-30"), "Europe/Berlin", TODAY)).toBe("overdue");
		expect(dateTone(d(TODAY), "Europe/Berlin", TODAY)).toBe("today");
		expect(dateTone(d("2026-10-02"), "Europe/Berlin", TODAY)).toBe("tomorrow");
		expect(dateTone(d("2026-10-09"), "Europe/Berlin", TODAY)).toBe("later");
		expect(dateTone(null, "Europe/Berlin", TODAY)).toBe("none");
	});
	it("row shows only the time for a timed task today; details chip combines date, time and duration", () => {
		const timed = { kind: "datetime" as const, local: "2026-10-01T19:00", tz: "Europe/Berlin" };
		expect(rowDateText(timed, "Europe/Berlin", TODAY)).toBe("19:00");
		expect(rowDateText({ kind: "date", date: TODAY }, "Europe/Berlin", TODAY)).toBe("Today");
		expect(detailsDateText({ scheduled: timed, deadline: null, plannedDurationMin: 45 }, "Europe/Berlin", TODAY)).toBe("Today, 19:00 · 45 min");
		expect(detailsDateText({ scheduled: null, deadline: null, plannedDurationMin: null }, "Europe/Berlin", TODAY)).toBe("No date");
	});
});

describe("task row", () => {
	it("checkbox carries the priority class and an accessible label", async () => {
		const { h, root } = await mount();
		const { task } = await h.app.tasks.create({ title: "Urgent thing" });
		await h.app.tasks.setPriority(task.id, 1);
		await h.app.tasks.create({ title: "Plain thing" });
		await openInbox(root);
		expect(row(root, "Urgent thing").querySelector(".cp-task-checkbox")!.classList.contains("cp-pri-1")).toBe(true);
		const plain = row(root, "Plain thing").querySelector(".cp-task-checkbox")!;
		expect(plain.className).not.toMatch(/cp-pri-[123]/);
		expect(plain.getAttribute("aria-label")).toBe('Complete "Plain thing"');
	});

	it("shows the first tag and a +N count, with every tag in the tooltip", async () => {
		const { h, root } = await mount();
		await h.app.tags.create("python", "yellow");
		await h.app.tags.create("programming", "orange");
		await h.app.tags.create("study", "blue");
		await h.app.tasks.create({ title: "Many tags", tagKeys: ["python", "programming", "study"], scheduled: { kind: "date", date: "2026-09-29" } });
		await settle();
		const tags = row(root, "Many tags").querySelector(".cp-meta-tags")!;
		expect(tags.querySelectorAll(".cp-tag-pill")).toHaveLength(1);
		expect(tags.querySelector(".cp-tag-pill")?.textContent).toBe("@python");
		expect(tags.querySelector(".cp-tag-more")?.textContent).toBe("+2");
		expect(tags.getAttribute("title")).toBe("@python @programming @study");
	});

	it("lists keep the matrix chip", async () => {
		const { h, root } = await mount();
		await h.app.tasks.create({ title: "Flagged", urgent: true, important: true, scheduled: { kind: "date", date: "2026-09-29" } });
		await openInbox(root);
		expect(row(root, "Flagged").querySelector(".cp-meta-matrix")?.textContent).toBe("Urgent · Important");
	});

	it("shows meta in order: tags, note, subtasks, list, date", async () => {
		const { h, root } = await mount();
		const cat = await h.app.categories.create("Work", "briefcase");
		await h.app.categories.setColor(cat.id, "green");
		const tag = await h.app.tags.create("urgent", "red");
		const { task } = await h.app.tasks.create({
			title: "Report",
			categoryId: cat.id,
			tagKeys: [tag.key],
			scheduled: { kind: "date", date: "2026-09-29" },
		});
		await h.app.tasks.create({ title: "Sub", parentId: task.id });
		h.notes.files.set("Plan.md", "x");
		await h.app.tasks.linkNote(task.id, "Plan.md");
		await settle();
		const r = row(root, "Report");
		const meta = r.querySelector(".cp-task-meta")!;
		const order = [...meta.children].map((c) => c.className.split(" ").find((x) => x.startsWith("cp-meta-")));
		expect(order).toEqual(["cp-meta-tags", "cp-meta-note", "cp-meta-subtasks", "cp-meta-list", "cp-meta-date"]);
		expect(meta.querySelector(".cp-tag-pill.cp-hue-red")?.textContent).toBe("@urgent");
		expect(meta.querySelector(".cp-meta-note")?.getAttribute("aria-label")).toBe("Has description note");
		expect(meta.querySelector(".cp-meta-note [data-icon]")?.getAttribute("data-icon")).toBe("file-text");
		expect(meta.querySelector(".cp-meta-subtasks")?.textContent).toBe("0/1");
		expect(meta.querySelector(".cp-meta-list .cp-list-dot.cp-hue-green")).not.toBeNull();
		expect(meta.querySelector(".cp-meta-list")?.textContent).toContain("Work");
		const date = meta.querySelector(".cp-meta-date")!;
		expect(date.classList.contains("is-overdue")).toBe(true);
	});

	it("hides the list name inside that list's own view", async () => {
		const { h, root } = await mount();
		const cat = await h.app.categories.create("Work");
		await h.app.tasks.create({ title: "In work", categoryId: cat.id });
		await settle();
		[...root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes("Work"))!.click();
		await settle();
		expect(row(root, "In work").querySelector(".cp-meta-list")).toBeNull();
	});

	it("date tones: today blue (time only), tomorrow, later", async () => {
		const { h, root } = await mount();
		await h.app.tasks.create({ title: "A", scheduled: { kind: "datetime", local: "2026-10-01T19:00", tz: "Europe/Berlin" } });
		await h.app.tasks.create({ title: "B", scheduled: { kind: "date", date: "2026-10-02" } });
		await h.app.tasks.create({ title: "C", scheduled: { kind: "date", date: "2026-10-20" } });
		await openInbox(root);
		expect(row(root, "A").querySelector(".cp-meta-date")?.textContent).toBe("19:00");
		expect(row(root, "A").querySelector(".cp-meta-date")?.classList.contains("is-today")).toBe(true);
		expect(row(root, "B").querySelector(".cp-meta-date")?.classList.contains("is-tomorrow")).toBe(true);
		expect(row(root, "C").querySelector(".cp-meta-date")?.classList.contains("is-later")).toBe(true);
	});

	it("selected row is marked", async () => {
		const { h, root } = await mount();
		await h.app.tasks.create({ title: "Pick me" });
		await openInbox(root);
		row(root, "Pick me").click();
		await settle();
		expect(row(root, "Pick me").classList.contains("is-selected")).toBe(true);
	});

	it("context menu has Priority items with the current one checked, and sets it", async () => {
		const { h, host, root } = await mount();
		const { task } = await h.app.tasks.create({ title: "Menu me" });
		await h.app.tasks.setPriority(task.id, 2);
		await openInbox(root);
		row(root, "Menu me").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		const menu = host.menus[0];
		expect(menuItem(menu, "Priority: medium").checked).toBe(true);
		expect(menuItem(menu, "Priority: high").checked).toBe(false);
		menuItem(menu, "Priority: low").run();
		await settle();
		expect(h.app.store.state.tasks.get(task.id)?.priority).toBe(3);
		menuItem(menu, "Priority: none").run();
		await settle();
		expect(h.app.store.state.tasks.get(task.id)?.priority).toBe(0);
	});

	it("Ctrl+Enter and the toggle event still complete the task", async () => {
		const { h, root } = await mount();
		const { task } = await h.app.tasks.create({ title: "Finish" });
		await openInbox(root);
		row(root, "Finish").dispatchEvent(new CustomEvent(TOGGLE_COMPLETE_EVENT));
		await settle();
		expect(h.app.store.state.tasks.get(task.id)?.status).toBe("completed");
	});

	it("completes without waiting for any animation", async () => {
		const { h, root } = await mount();
		const { task } = await h.app.tasks.create({ title: "Quick" });
		await openInbox(root);
		row(root, "Quick").querySelector<HTMLInputElement>(".cp-task-checkbox")!.click();
		await Promise.resolve();
		await settle();
		expect(h.app.store.state.tasks.get(task.id)?.status).toBe("completed");
	});
});

describe("completion animation", () => {
	it("rows mounted already completed are not marked as just completed", async () => {
		const { h, root } = await mount();
		const { task } = await h.app.tasks.create({ title: "Old news" });
		await h.app.tasks.complete(task.id);
		[...root.querySelectorAll<HTMLElement>(".cp-sidebar-item")].find((e) => e.textContent?.includes("Completed"))!.click();
		await settle();
		const r = row(root, "Old news");
		expect(r.classList.contains("is-completed")).toBe(true);
		expect(r.classList.contains("is-just-completed")).toBe(false);
	});

	it("the user's own completion marks the row until the animation ends", async () => {
		const { h, root } = await mount();
		await h.app.tasks.create({ title: "Fresh", scheduled: { kind: "date", date: TODAY } });
		await settle();
		const r = row(root, "Fresh");
		let seen = false;
		new MutationObserver(() => {
			if (r.classList.contains("is-just-completed")) seen = true;
		}).observe(r, { attributes: true });
		r.querySelector<HTMLInputElement>(".cp-task-checkbox")!.click();
		await settle();
		expect(seen).toBe(true);
	});

	it("the stylesheet animates only a just-completed row's checkbox", async () => {
		const { readFileSync } = await import("node:fs");
		const css = readFileSync("styles.css", "utf8");
		expect(css).not.toMatch(/view \.cp-task-checkbox:checked\s*\{[^}]*animation/);
		expect(css).toMatch(/\.cp-task-row\.is-just-completed \.cp-task-checkbox:checked\s*\{[^}]*animation/);
	});
});

describe("search results", () => {
	it("use the same row and collect completed results in a collapsed group at the end", async () => {
		const { h, root } = await mount();
		const a = await h.app.tasks.create({ title: "Alpha open" });
		const b = await h.app.tasks.create({ title: "Alpha done" });
		await h.app.tasks.complete(b.task.id);
		void a;
		root.querySelector<HTMLElement>('.cp-rail [aria-label="Search"]')!.click();
		await settle();
		const input = root.querySelector<HTMLInputElement>('.cp-search input[type="search"]')!;
		input.value = "alpha";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();
		const rows = [...root.querySelectorAll<HTMLElement>(".cp-search .cp-task-row")];
		expect(rows.map((r) => r.textContent)).toHaveLength(1);
		const toggle = root.querySelector<HTMLButtonElement>(".cp-search .cp-completed-toggle")!;
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(toggle.textContent).toContain("Completed");
		toggle.click();
		await settle();
		expect(root.querySelectorAll(".cp-search .cp-task-row.is-completed")).toHaveLength(1);
	});
});
