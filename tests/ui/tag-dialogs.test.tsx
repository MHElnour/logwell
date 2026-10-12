// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { newTagProblem } from "../../src/domain/tags";
import type { Tag, TagColor } from "../../src/domain/types";
import { buildTagForm } from "../../src/obsidian/tagDialog";
import type { TagDialogOptions, TagDialogValues } from "../../src/ui/host";
import { EDIT_TAG_LABEL } from "../../src/app/CategoryService";
import { QuickAddModel } from "../../src/ui/quickadd/QuickAddModel";
import { manualPills } from "../../src/ui/quickadd/manualPills";
import { appHarness } from "../app/harness";
import { type CalMount, click, mountCal, settle } from "./m3-helpers";
import { menuItem } from "./u1-helpers";

describe("the tag form", () => {
	// The New tag / Edit tag form (Lists, sections and tags rule 23b). Plain DOM, tested without Obsidian's Modal: the name
	// is checked as typed through the caller's check, the first problem shows, and the submit button stays off until the
	// name is valid.

	const HINT = "Each tag name can be used only once in Logwell. Use letters, digits, hyphens (-) and underscores (_).";
	const TS = "2026-10-01T10:00:00Z";
	const tags = new Map<string, Tag>(
		[
			["calls", "Calls"],
			["home", "Home"],
			["home/garden", "Home/Garden"],
		].map(([key, displayName]) => [key!, { key: key!, displayName: displayName!, color: null, createdAt: TS, modifiedAt: TS }]),
	);

	function form(
		options: { initial?: TagDialogValues; submitLabel?: "Create" | "Save"; parentLock?: string | null; except?: string | null; result?: string | null } = {},
	) {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const onSubmit = vi.fn<(v: TagDialogValues) => Promise<string | null>>(async () => options.result ?? null);
		const onCancel = vi.fn();
		const f = buildTagForm(container, {
			submitLabel: options.submitLabel ?? "Create",
			initial: options.initial ?? { name: "", parent: null, color: "orange" },
			parents: [
				{ key: "calls", label: "Calls" },
				{ key: "home", label: "Home" },
			],
			parentLock: options.parentLock ?? null,
			check: (name, parent) => newTagProblem(tags, name, parent, options.except ?? null),
			onSubmit,
			onCancel,
		});
		const q = <T extends HTMLElement>(sel: string) => container.querySelector<T>(sel)!;
		const name = () => q<HTMLInputElement>("input.cp-new-list-name");
		const select = () => q<HTMLSelectElement>("select");
		const error = () => q(".cp-new-list-error");
		const submitButton = () => q<HTMLButtonElement>('button[type="submit"]');
		const type = (v: string) => {
			name().value = v;
			name().dispatchEvent(new Event("input", { bubbles: true }));
		};
		const pick = (v: string) => {
			select().value = v;
			select().dispatchEvent(new Event("change", { bubbles: true }));
		};
		const submit = () => q("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		const colors = () => [...container.querySelectorAll<HTMLButtonElement>(".cp-color-choice")];
		return { container, f, q, name, select, error, submitButton, type, pick, submit, colors, onSubmit, onCancel };
	}

	const settle = async () => {
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	};

	beforeAll(() => {
		// Obsidian's createEl, which happy-dom does not have.
		(HTMLElement.prototype as unknown as { createEl: unknown }).createEl = function (this: HTMLElement, tag: string, o: { cls?: string; attr?: Record<string, string> } = {}) {
			const node = this.ownerDocument.createElement(tag);
			if (o.cls !== undefined) node.className = o.cls;
			for (const [k, v] of Object.entries(o.attr ?? {})) node.setAttribute(k, v);
			this.appendChild(node);
			return node;
		};
	});
	afterEach(() => document.body.replaceChildren());

	describe("tag form: fields", () => {
		it("has a labelled name with maxlength 64 and the hint, a Parent select (None first) and a color row", () => {
			const t = form();
			const input = t.name();
			expect(input.getAttribute("maxlength")).toBe("64");
			expect(t.container.querySelector(`label[for="${input.id}"]`)!.textContent).toBe("Name");
			const described = input.getAttribute("aria-describedby")!.split(" ");
			expect(described.map((id) => t.container.querySelector(`#${id}`)!.textContent)).toContain(HINT);
			expect(described).toContain(t.error().id);
			expect(t.container.querySelector(`label[for="${t.select().id}"]`)!.textContent).toBe("Parent");
			expect([...t.select().options].map((o) => [o.value, o.textContent])).toEqual([
				["", "None"],
				["calls", "Calls"],
				["home", "Home"],
			]);
			expect(t.colors()).toHaveLength(9);
			// The preselected color is the one given (the next palette color for a new tag).
			expect(t.colors()[2]!.getAttribute("aria-pressed")).toBe("true");
			expect(t.submitButton().textContent).toBe("Create");
			// Containers are named by visible labels, never by aria-label.
			for (const g of t.container.querySelectorAll('[role="group"]')) expect(g.hasAttribute("aria-label")).toBe(false);
		});

		it("a locked parent is disabled with its hint", () => {
			const t = form({ submitLabel: "Save", initial: { name: "Home", parent: null, color: null }, parentLock: "A tag with child tags has no parent.", except: "home" });
			expect(t.select().disabled).toBe(true);
			const hintId = t.select().getAttribute("aria-describedby")!;
			expect(t.container.querySelector(`#${hintId}`)!.textContent).toBe("A tag with child tags has no parent.");
		});

		it("Cancel dismisses", () => {
			const t = form();
			[...t.container.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
			expect(t.onCancel).toHaveBeenCalled();
		});
	});

	describe("tag form: live check", () => {
		it("an empty new form has Create off and shows no message until the name is touched", () => {
			const t = form();
			expect(t.submitButton().disabled).toBe(true);
			expect(t.error().hidden).toBe(true);
			t.type("x");
			t.type("");
			expect(t.error().hidden).toBe(false);
			expect(t.error().textContent).toBe("Enter a name.");
			expect(t.name().getAttribute("aria-invalid")).toBe("true");
		});

		it("shows the first problem as typed and turns Create on for a valid name", () => {
			const t = form();
			const cases: [string, string][] = [
				["phone calls", "Use one word: spaces are not allowed. Try a hyphen, like phone-calls."],
				["home/garden", 'Pick a parent below instead of typing "/".'],
				["@calls", 'Leave out the "@"; it is added for you.'],
				["a$b", "Only letters, digits, hyphens (-) and underscores (_) are allowed."],
				["x".repeat(65), "Use at most 64 characters."],
				["CALLS", 'The name "Calls" is already used by another tag.'],
				["garden", 'The name "Garden" is already used by another tag.'],
			];
			for (const [typed, message] of cases) {
				t.type(typed);
				expect(t.error().textContent).toBe(message);
				expect(t.submitButton().disabled).toBe(true);
			}
			t.type("Phone");
			expect(t.error().hidden).toBe(true);
			expect(t.name().hasAttribute("aria-invalid")).toBe(false);
			expect(t.submitButton().disabled).toBe(false);
		});

		it("re-checks when the parent changes", () => {
			const t = form();
			t.type("calls");
			expect(t.submitButton().disabled).toBe(true);
			t.type("Home");
			t.pick("home");
			expect(t.error().textContent).toBe("A tag can't have the same name as its parent.");
			t.pick("");
			expect(t.error().textContent).toBe('The name "Home" is already used by another tag.');
		});

		it("submitting while invalid does nothing", async () => {
			const t = form();
			t.submit();
			await settle();
			expect(t.onSubmit).not.toHaveBeenCalled();
			expect(t.error().textContent).toBe("Enter a name.");
		});
	});

	describe("tag form: submit", () => {
		it("submits the trimmed name, the parent and the color", async () => {
			const t = form();
			t.type("  Phone  ");
			t.pick("home");
			t.colors()[0]!.click();
			t.submit();
			await settle();
			expect(t.onSubmit).toHaveBeenCalledWith({ name: "Phone", parent: "home", color: null as TagColor | null });
		});

		it("a message from the save shows inline and keeps the values; the button turns back on", async () => {
			const t = form({ result: "The parent tag no longer exists." });
			t.type("Phone");
			t.pick("home");
			t.submit();
			await settle();
			expect(t.error().textContent).toBe("The parent tag no longer exists.");
			expect(t.error().hidden).toBe(false);
			expect(t.name().value).toBe("Phone");
			expect(t.select().value).toBe("home");
			expect(t.submitButton().disabled).toBe(false);
			expect(t.onCancel).not.toHaveBeenCalled();
		});

		it("a second submit while the first runs is ignored", async () => {
			const t = form();
			let release: (v: string | null) => void = () => undefined;
			t.onSubmit.mockImplementation(() => new Promise((r) => (release = r)));
			t.type("Phone");
			t.submit();
			t.submit();
			expect(t.onSubmit).toHaveBeenCalledTimes(1);
			expect(t.submitButton().disabled).toBe(true);
			release(null);
			await settle();
		});

		it("Edit starts filled in, valid, with its own name allowed and Save on", () => {
			const t = form({ submitLabel: "Save", initial: { name: "Calls", parent: null, color: "blue" }, except: "calls" });
			expect(t.name().value).toBe("Calls");
			expect(t.submitButton().textContent).toBe("Save");
			expect(t.submitButton().disabled).toBe(false);
			expect(t.error().hidden).toBe(true);
			t.type("");
			expect(t.error().textContent).toBe("Enter a name.");
		});

		it("an edit keeps a current parent that the list does not offer", () => {
			const t = form({ submitLabel: "Save", initial: { name: "Garden", parent: "work", color: null }, except: "work/garden" });
			expect(t.select().value).toBe("work");
		});
	});
});

describe("Edit tag", () => {
	// Edit in a tag's menu (Lists, sections and tags rule 24): the New tag dialog filled in. One write with an Undo
	// notice; an open tag view follows the new key.

	const mounted: CalMount[] = [];
	afterEach(() => {
		for (const m of mounted.splice(0)) m.unmount();
	});

	async function mount(...submits: (TagDialogValues | null)[]) {
		const m = await mountCal();
		mounted.push(m);
		const t = m.h.app.tasks;
		await m.h.app.tags.create("Home", "red");
		await t.create({ title: "Ring mum", newTags: ["Home/Calls"] });
		await t.create({ title: "Weed", newTags: ["Home/Garden"] });
		await t.create({ title: "Shop", newTags: ["Errands"] });
		const opened: TagDialogOptions[] = [];
		const outcomes: (string | null)[] = [];
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
		return { m, opened, outcomes, tagDialog };
	}

	const sidebar = (m: CalMount) => m.root.querySelector<HTMLElement>(".cp-sidebar")!;
	const rows = (m: CalMount) => [...sidebar(m).querySelectorAll<HTMLElement>(".cp-tag-tree .cp-sidebar-item")];
	const rowFor = (m: CalMount, label: string) => rows(m).find((r) => r.querySelector(".cp-sidebar-label")!.textContent === label)!;
	const labels = (m: CalMount) => rows(m).map((r) => r.querySelector(".cp-sidebar-label")!.textContent);
	const title = (m: CalMount) => m.root.querySelector(".cp-main-title")!.textContent;
	const menuOf = async (m: CalMount, label: string) => {
		rowFor(m, label).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		await settle();
		return m.host.menus.at(-1)!;
	};
	const edit = async (m: CalMount, label: string) => {
		menuItem(await menuOf(m, label), "Edit").run();
		await settle();
	};

	describe("tag menu Edit", () => {
		it("is the first item, and opens the dialog filled in with the tag's name, parent and color", async () => {
			const { m, opened } = await mount(null);
			const menu = await menuOf(m, "Calls");
			expect(menu[0]).toMatchObject({ title: "Edit" });
			menuItem(menu, "Edit").run();
			await settle();
			const o = opened[0]!;
			expect(o.title).toBe("Edit tag");
			expect(o.submit).toBe("Save");
			const calls = m.h.app.store.state.tags.get("home/calls")!;
			expect(o.initial).toEqual({ name: "Calls", parent: "home", color: calls.color });
			expect(o.parentLock).toBeNull();
			expect(o.parents.map((p) => p.key)).toEqual(["errands", "home"]);
			// Its own name is allowed; another tag's is not.
			expect(o.check("calls", "home")).toBeNull();
			expect(o.check("Garden", "home")).toBe('The name "Garden" is already used by another tag.');
		});

		it("a tag with children has its parent locked and is not its own parent choice", async () => {
			const { m, opened } = await mount(null);
			await edit(m, "Home");
			expect(opened[0]!.parentLock).toBe("A tag with child tags has no parent.");
			expect(opened[0]!.parents.map((p) => p.key)).toEqual(["errands"]);
		});

		it("a flat tag from an older file (an empty segment, as a//b) has its parent locked", async () => {
			const { m, opened } = await mount(null);
			await m.h.app.store.run("Seed", (tx) => tx.put("tags", { key: "a//b", displayName: "A//B", color: null, createdAt: tx.now, modifiedAt: tx.now }));
			await settle();
			// The tree names a flat key by its key.
			await edit(m, "a//b");
			expect(opened[0]!.parentLock).toBe('A tag with "/" in its name has no parent.');
			expect(opened[0]!.initial).toMatchObject({ name: "A//B", parent: null });
		});

		it("a rename is one write with the notice 'Renamed tag @Calls to @Phone.'; Undo restores it", async () => {
			const { m, outcomes } = await mount({ name: "Phone", parent: "home", color: null });
			const before = m.h.app.store.state;
			await edit(m, "Calls");
			expect(outcomes).toEqual([null]);
			expect(m.host.messages.at(-1)).toBe("Renamed tag @Calls to @Phone.");
			expect(m.h.app.store.undoLabel).toBe(EDIT_TAG_LABEL);
			expect(labels(m)).toEqual(["Errands", "Home", "Garden", "Phone"]);
			// The task row shows the new name.
			await click(rowFor(m, "Phone"));
			expect(m.root.querySelector(".cp-tasks .cp-task-row .cp-tag-pill")!.textContent).toBe("@Phone");
			await m.host.undoButtons.at(-1)!();
			await settle();
			expect(m.h.app.store.state.tags).toEqual(before.tags);
			expect(labels(m)).toEqual(["Errands", "Home", "Calls", "Garden"]);
		});

		it("a color or parent change alone says 'Updated tag'", async () => {
			const { m } = await mount({ name: "Errands", parent: "home", color: "purple" });
			await edit(m, "Errands");
			expect(m.host.messages.at(-1)).toBe("Updated tag @Errands.");
			expect(m.h.app.store.state.tags.get("home/errands")!.color).toBe("purple");
		});

		it("saving without a change writes nothing and shows no notice; the dialog closes", async () => {
			const { m, outcomes } = await mount();
			const calls = m.h.app.store.state.tags.get("home/calls")!;
			const state = m.h.app.store.state;
			const n = m.host.messages.length;
			(m.host as unknown as { tagDialog: (o: TagDialogOptions) => Promise<void> }).tagDialog = async (o) => {
				outcomes.push(await o.save({ name: "Calls", parent: "home", color: calls.color }));
			};
			await edit(m, "Calls");
			expect(outcomes).toEqual([null]);
			expect(m.h.app.store.state).toBe(state);
			expect(m.host.messages.length).toBe(n);
		});

		it("a refusal comes back as text and the dialog stays open", async () => {
			const { m, outcomes, tagDialog } = await mount({ name: "Errands", parent: null, color: null }, { name: "Chores", parent: null, color: null });
			await edit(m, "Calls");
			expect(tagDialog).toHaveBeenCalledTimes(1);
			expect(outcomes).toEqual(['The name "Errands" is already used by another tag.', null]);
		});

		it("an open tag view follows the rename, also of its parent", async () => {
			const { m } = await mount({ name: "Phone", parent: "home", color: null }, null);
			await click(rowFor(m, "Calls"));
			expect(title(m)).toBe("@Calls");
			await edit(m, "Calls");
			expect(title(m)).toBe("@Phone");
			expect(rowFor(m, "Phone").getAttribute("aria-current")).toBe("page");
			(m.host as unknown as { tagDialog: (o: TagDialogOptions) => Promise<void> }).tagDialog = async (o) => void (await o.save({ name: "House", parent: null, color: "red" }));
			await edit(m, "Home");
			expect(title(m)).toBe("@Phone");
			expect(m.h.app.store.state.tags.has("house/phone")).toBe(true);
			expect(rowFor(m, "Phone").getAttribute("aria-current")).toBe("page");
		});
	});

	describe("Quick Add after a rename", () => {
		it("a picked tag that is renamed or deleted leaves the pills with a message; the save writes no old key", async () => {
			const h = await appHarness();
			await h.app.tags.create("Calls");
			await h.app.tags.create("Home");
			const m = new QuickAddModel(
				{
					app: h.app,
					preset: {},
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
			m.setTags(["calls", "home"]);
			await h.app.tags.edit("calls", { name: "Phone", parentKey: null, color: null });
			m.refresh();
			expect(m.tagKeys).toEqual(["home"]);
			expect(manualPills(m).filter((p) => p.kind === "tag").map((p) => p.label)).toEqual(["@Home"]);
			expect(m.message).toBe('The tag "Calls" was renamed or deleted. Pick it again.');
			// Another change with nothing gone leaves the message alone.
			m.refresh();
			expect(m.message).toBe('The tag "Calls" was renamed or deleted. Pick it again.');
			m.setInput("Ring mum");
			expect(await m.submit()).toBe("saved");
			const task = [...h.app.store.state.tasks.values()].find((t) => t.title === "Ring mum")!;
			expect(task.tagKeys).toEqual(["home"]);
		});

		it("a manual tag whose tag was renamed is never saved, even before a refresh", async () => {
			const h = await appHarness();
			await h.app.tags.create("Calls");
			const m = new QuickAddModel(
				{
					app: h.app,
					preset: {},
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
			m.setTags(["calls"]);
			await h.app.tags.edit("calls", { name: "Phone", parentKey: null, color: null });
			expect(m.tagKeysValue()).toEqual([]);
			m.setInput("Ring mum");
			expect(await m.submit()).toBe("saved");
		});
	});

	describe("Quick Add after a delete, and picking again", () => {
		const model = (h: Awaited<ReturnType<typeof appHarness>>) =>
			new QuickAddModel(
				{
					app: h.app,
					preset: {},
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

		it("a deleted tag leaves the pills, and the message names it as its pill did", async () => {
			const h = await appHarness();
			await h.app.tags.create("Home/Phone-Calls");
			const m = model(h);
			m.setTags(["home/phone-calls"]);
			expect(manualPills(m).find((p) => p.kind === "tag")?.label).toBe("@Phone-Calls");
			await h.app.tags.delete("home/phone-calls");
			m.refresh();
			expect(m.tagKeys).toEqual([]);
			expect(m.message).toBe('The tag "Phone-Calls" was renamed or deleted. Pick it again.');
		});

		it("picking a tag again clears the message", async () => {
			const h = await appHarness();
			await h.app.tags.create("Calls");
			const m = model(h);
			m.setTags(["calls"]);
			await h.app.tags.edit("calls", { name: "Phone", parentKey: null, color: null });
			m.refresh();
			expect(m.message).not.toBeNull();
			m.setTags(["phone"]);
			expect(m.message).toBeNull();
		});
	});
});
