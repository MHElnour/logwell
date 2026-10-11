// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDIT_TAG_LABEL } from "../../src/app/CategoryService";
import type { TagDialogOptions, TagDialogValues } from "../../src/ui/host";
import { QuickAddModel } from "../../src/ui/quickadd/QuickAddModel";
import { appHarness } from "../app/harness";
import { type CalMount, click, mountCal, settle } from "./m3-helpers";
import { menuItem } from "./u1-helpers";

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
		expect(o.parentLocked).toBe(false);
		expect(o.parents.map((p) => p.key)).toEqual(["errands", "home"]);
		// Its own name is allowed; another tag's is not.
		expect(o.check("calls", "home")).toBeNull();
		expect(o.check("Garden", "home")).toBe('The name "Garden" is already used by another tag.');
	});

	it("a tag with children has its parent locked and is not its own parent choice", async () => {
		const { m, opened } = await mount(null);
		await edit(m, "Home");
		expect(opened[0]!.parentLocked).toBe(true);
		expect(opened[0]!.parents.map((p) => p.key)).toEqual(["errands"]);
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
	it("a manual tag pill whose tag was renamed is dropped, so saving still works", async () => {
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
