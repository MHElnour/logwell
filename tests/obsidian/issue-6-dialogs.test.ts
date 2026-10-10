// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PendingTrash } from "../../src/app/SyncService";
import type { LinkOption } from "../../src/app/tickTickLink";
import { buildLinkForm, buildMissingForm, buildPreviewForm, missingTitle } from "../../src/obsidian/tickTickDialogs";

// The dialogs' forms are plain DOM, tested without Obsidian's Modal.

beforeAll(() => {
	(HTMLElement.prototype as unknown as { createEl: unknown }).createEl = function (this: HTMLElement, tag: string, o: { cls?: string; attr?: Record<string, string> } = {}) {
		const node = this.ownerDocument.createElement(tag);
		if (o.cls !== undefined) node.className = o.cls;
		for (const [k, v] of Object.entries(o.attr ?? {})) node.setAttribute(k, v);
		this.appendChild(node);
		return node;
	};
});
afterEach(() => document.body.replaceChildren());

const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const box = () => {
	const c = document.createElement("div");
	document.body.appendChild(c);
	return c;
};
const text = (c: HTMLElement, sel: string) => c.querySelector(sel)?.textContent;
const button = (c: HTMLElement, label: string) => [...c.querySelectorAll("button")].find((b) => b.textContent === label)!;

const option = (key: string, label: string, over: Partial<LinkOption> = {}): LinkOption => ({
	key,
	label,
	detail: "",
	disabled: false,
	target: key === "create" ? { kind: "create", name: "Work" } : { kind: "existing", projectId: key, name: label },
	...over,
});
const OPTIONS = [
	option("create", "Create “Work” in TickTick", { detail: "new, empty" }),
	option("inbox", "Inbox", { detail: "Linked to Inbox", disabled: true }),
	option("p1", "Work"),
	option("p2", "Exercise"),
	option("p3", "Reading notes", { detail: "Note list: can't sync", disabled: true }),
	option("p4", "Study"),
];

function link(load: () => Promise<LinkOption[]> = async () => OPTIONS, initial = (o: readonly LinkOption[]) => o.find((x) => x.key === "p1")) {
	const c = box();
	const onContinue = vi.fn();
	const onCancel = vi.fn();
	const form = buildLinkForm(c, { listName: "Work", load, initial, onContinue, onCancel });
	const rows = () => [...c.querySelectorAll<HTMLElement>('[role="option"]')];
	return { c, form, onContinue, onCancel, rows };
}

describe("link dialog (screen 5)", () => {
	it("shows a loading line, then the lists with the initial one selected", async () => {
		let resolve!: (o: LinkOption[]) => void;
		const t = link(() => new Promise((r) => (resolve = r)));
		expect(text(t.c, ".cp-tt-status")).toBe("Loading your TickTick lists…");
		expect(t.c.querySelector<HTMLElement>('[role="listbox"]')!.hidden).toBe(true);
		expect(button(t.c, "Continue").disabled).toBe(true);
		resolve(OPTIONS);
		await settle();
		expect(t.c.querySelector<HTMLElement>(".cp-tt-status")!.hidden).toBe(true);
		expect(t.rows().map((r) => r.querySelector(".cp-tt-option-name")!.textContent)).toEqual(OPTIONS.map((o) => o.label));
		expect(t.rows().map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "false", "true", "false", "false", "false"]);
		expect(button(t.c, "Continue").disabled).toBe(false);
	});

	it("marks lists that cannot be chosen: a linked list and a note list, with their reason", async () => {
		const t = link();
		await settle();
		const [, inbox, , , notes] = t.rows();
		expect(inbox!.getAttribute("aria-disabled")).toBe("true");
		expect(inbox!.textContent).toContain("Linked to Inbox");
		expect(notes!.getAttribute("aria-disabled")).toBe("true");
		expect(notes!.textContent).toContain("Note list: can't sync");
		notes!.click();
		expect(notes!.getAttribute("aria-selected")).toBe("false");
		expect(t.rows()[2]!.getAttribute("aria-selected")).toBe("true");
	});

	it("a click selects, Continue passes the selected option", async () => {
		const t = link();
		await settle();
		t.rows()[0]!.click();
		button(t.c, "Continue").click();
		expect(t.onContinue).toHaveBeenCalledWith(OPTIONS[0]);
	});

	it("Arrow keys move over the lists and skip the ones that cannot be chosen; Enter continues", async () => {
		const t = link();
		await settle();
		const key = (row: HTMLElement, k: string) => row.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
		key(t.rows()[2]!, "ArrowDown");
		expect(t.rows()[3]!.getAttribute("aria-selected")).toBe("true");
		key(t.rows()[3]!, "ArrowDown");
		// "Reading notes" is skipped.
		expect(t.rows()[5]!.getAttribute("aria-selected")).toBe("true");
		key(t.rows()[5]!, "ArrowDown");
		expect(t.rows()[5]!.getAttribute("aria-selected")).toBe("true");
		key(t.rows()[5]!, "ArrowUp");
		key(t.rows()[3]!, "ArrowUp");
		key(t.rows()[2]!, "ArrowUp");
		// "Inbox" is skipped on the way to "Create".
		expect(t.rows()[0]!.getAttribute("aria-selected")).toBe("true");
		key(t.rows()[0]!, "Enter");
		expect(t.onContinue).toHaveBeenCalledWith(OPTIONS[0]);
	});

	it("only the selected row is a tab stop", async () => {
		const t = link();
		await settle();
		expect(t.rows().map((r) => r.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1]);
	});

	it("says the 999 and 99 limits, and what is not synced", async () => {
		const t = link();
		await settle();
		expect(text(t.c, ".cp-tt-warn")).toContain("at most 999 open tasks");
		expect(text(t.c, ".cp-tt-warn")).toContain("99 on its free plan");
		expect(t.c.textContent).toContain("Repeating tasks and TickTick notes are not synced.");
		expect(t.c.textContent).toContain("A tag name can be used only once, whatever its parent (TickTick allows one tag per name).");
	});

	it("advises changing synced tasks in one place", async () => {
		const t = link();
		await settle();
		expect(t.c.textContent).toContain("Tip: make changes to synced tasks in one place, like TickTick, and they show up on both sides.");
	});

	it("shows the error of a failed load, keeps Continue off and still cancels", async () => {
		const t = link(() => Promise.reject(new Error("TickTick: the API token was refused")));
		await settle();
		expect(text(t.c, '[role="alert"]')).toBe("TickTick: the API token was refused");
		expect(button(t.c, "Continue").disabled).toBe(true);
		button(t.c, "Cancel").click();
		expect(t.onCancel).toHaveBeenCalled();
	});

	it("names its listbox by a visible-text label, not an aria-label", async () => {
		const t = link();
		await settle();
		const list = t.c.querySelector('[role="listbox"]')!;
		expect(list.hasAttribute("aria-label")).toBe(false);
		expect(t.c.querySelector(`#${list.getAttribute("aria-labelledby")}`)!.textContent).toBe("TickTick lists");
	});

	it("starts on the first usable list when none is suggested", async () => {
		const t = link(async () => [option("inbox", "Inbox", { disabled: true }), option("p1", "Home")], () => undefined);
		await settle();
		expect(button(t.c, "Continue").disabled).toBe(true);
		expect(t.rows()[1]!.tabIndex).toBe(0);
		t.rows()[1]!.click();
		expect(button(t.c, "Continue").disabled).toBe(false);
	});
});

describe("first-sync preview (screen 6)", () => {
	function preview(plan: { toLogwell: number; toTickTick: number }) {
		const c = box();
		const onSync = vi.fn();
		const onBack = vi.fn();
		buildPreviewForm(c, { listName: "Work", projectName: "Work", plan, onSync, onBack });
		return { c, onSync, onBack };
	}

	it("shows both counts and warns about duplicates when both sides have tasks", () => {
		const t = preview({ toLogwell: 18, toTickTick: 5 });
		expect([...t.c.querySelectorAll(".cp-tt-count")].map((e) => e.textContent)).toEqual(["18open tasks come to Logwell", "5open tasks go to TickTick"]);
		expect(t.c.textContent).toContain("Both lists already have tasks. They are not matched");
		expect(text(t.c, ".cp-tt-warn")).toBe("Tasks that exist on both sides will appear twice. Delete the copy you don't want; the delete syncs.");
		expect(t.c.textContent).toContain("A backup is taken first");
	});

	it.each([
		[0, 7],
		[7, 0],
		[0, 0],
	])("has no duplicate warning when a side is empty (%i in, %i out)", (toLogwell, toTickTick) => {
		const t = preview({ toLogwell, toTickTick });
		expect(t.c.querySelector(".cp-tt-warn")).toBeNull();
		expect(t.c.textContent).not.toContain("Both lists already have tasks");
	});

	it("uses the singular for one task", () => {
		const t = preview({ toLogwell: 1, toTickTick: 1 });
		expect([...t.c.querySelectorAll(".cp-tt-count span")].map((e) => e.textContent)).toEqual(["open task comes to Logwell", "open task goes to TickTick"]);
	});

	it("Sync and Back call back", () => {
		const t = preview({ toLogwell: 1, toTickTick: 2 });
		button(t.c, "Sync").click();
		button(t.c, "Back").click();
		expect(t.onSync).toHaveBeenCalledTimes(1);
		expect(t.onBack).toHaveBeenCalledTimes(1);
	});
});

describe("tasks missing from TickTick (screens 8 and 9)", () => {
	const many: PendingTrash = {
		listId: "L",
		reason: "many",
		tasks: ["Call the bank", "Book the dentist", "Send the report", "Buy printer paper", "Renew the parking permit", "Order new chairs", "Plan the team lunch"].map((title, i) => ({ id: `t${i}`, title })),
	};
	const emptied: PendingTrash = { listId: "L", reason: "emptied", tasks: Array.from({ length: 23 }, (_, i) => ({ id: `e${i}`, title: `Task ${i}` })) };

	function form(pending: PendingTrash) {
		const c = box();
		const onChoose = vi.fn();
		buildMissingForm(c, { pending, listName: "Work", onChoose });
		return { c, onChoose };
	}

	it("titles the question", () => {
		expect(missingTitle(many, "Work")).toBe("7 tasks were removed from Work in TickTick");
		expect(missingTitle({ ...many, tasks: many.tasks.slice(0, 5) }, "Work")).toBe("5 tasks were removed from Work in TickTick");
		expect(missingTitle(emptied, "Work")).toBe("Work is empty in TickTick");
	});

	it("lists the titles of 5 or more removed tasks", () => {
		const t = form(many);
		expect([...t.c.querySelectorAll(".cp-tt-titles li")].map((li) => li.textContent)).toEqual(many.tasks.map((x) => x.title));
		expect(t.c.textContent).toContain("Move them to Trash in Logwell too?");
	});

	it("Move to Trash and Keep report their choice", () => {
		const t = form(many);
		button(t.c, "Move to Trash").click();
		button(t.c, "Keep").click();
		expect(t.onChoose.mock.calls).toEqual([["trash"], ["keep"]]);
	});

	it("an emptied list asks about all of its tasks and says Keep also unlinks", () => {
		const t = form(emptied);
		expect(t.c.textContent).toContain("It had 23 tasks at the last sync. Move all 23 to Trash in Logwell?");
		expect(t.c.textContent).toContain("Keep keeps them in Logwell and unlinks the list, so nothing is deleted.");
		expect(t.c.querySelector(".cp-tt-titles")).toBeNull();
	});

	it("the titles list is a keyboard stop so a long list can scroll", () => {
		expect(form(many).c.querySelector(".cp-tt-titles")!.getAttribute("tabindex")).toBe("0");
	});
});
