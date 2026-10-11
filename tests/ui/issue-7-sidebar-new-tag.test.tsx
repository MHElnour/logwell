// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREATE_TAG_LABEL } from "../../src/app/CategoryService";
import { paletteColor } from "../../src/domain/types";
import type { TagDialogOptions, TagDialogValues } from "../../src/ui/host";
import { type CalMount, click, mountCal, settle } from "./m3-helpers";

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

	it("opens New tag with the next palette color and the top-level tags, implicit parents included, as parents", async () => {
		const { m, opened } = await scripted(async (m) => {
			await m.h.app.tags.create("Errands");
			await m.h.app.tags.create("Home/Calls");
			await m.h.app.store.run("Seed", (tx) => tx.put("tags", { key: "a//b", displayName: "A//B", color: null, createdAt: tx.now, modifiedAt: tx.now }));
		}, null);
		await click(plus(m));
		const o = opened[0]!;
		expect(o.title).toBe("New tag");
		expect(o.submit).toBe("Create");
		expect(o.initial).toEqual({ name: "", parent: null, color: paletteColor(3) });
		expect(o.parentLocked).toBe(false);
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
