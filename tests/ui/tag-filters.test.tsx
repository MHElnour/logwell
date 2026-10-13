// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { emptyFilter, existingTagFilter } from "../../src/domain/queries";
import type { Tag } from "../../src/domain/types";
import { cal } from "./calendar-helpers";
import { click, mountApp, settle } from "./app-helpers";
import { matrix, openMatrix, titlesIn } from "./matrix-helpers";
import { checkedOf, openViewMenu, pickItem, viewButton } from "./view-menu-helpers";

// A view filter never keeps a tag that is gone (Lists, sections and tags rule 24): after a rename or a delete the
// calendar, matrix, search and task filters drop the old key, so the view is not left empty with no way to clear it.

const TS = "2026-10-01T10:00:00Z";
const tags = (...keys: string[]) => new Map<string, Tag>(keys.map((key) => [key, { key, displayName: key, color: null, createdAt: TS, modifiedAt: TS }]));

describe("existingTagFilter", () => {
	it("keeps the same filter object when every tag exists", () => {
		const f = { ...emptyFilter(), tagKeys: ["calls", "home"] };
		expect(existingTagFilter(f, tags("calls", "home", "work"))).toBe(f);
		const none = emptyFilter();
		expect(existingTagFilter(none, tags())).toBe(none);
	});

	it("drops the keys of tags that are gone, keeping the rest of the filter", () => {
		const f = { ...emptyFilter("open"), tagKeys: ["calls", "home"], tagMode: "all" as const, quadrants: ["urgent" as const] };
		expect(existingTagFilter(f, tags("home"))).toEqual({ ...f, tagKeys: ["home"] });
	});
});


describe("a view filter after a tag rename or delete", () => {
	it("the matrix drops the old key: its tasks show again and the dot goes off; the menu lists the new name", async () => {
		const m = await mountApp();
		await m.h.app.tags.create("Calls", "red");
		await m.h.app.tasks.create({ title: "Ring mum", urgent: true, tagKeys: ["calls"] });
		await m.h.app.tasks.create({ title: "Plain", urgent: true });
		await openMatrix(m);
		await pickItem(m, (await pickItem(m, await openViewMenu(m, matrix(m.root)), "Tags…"))!, "@Calls");
		expect(titlesIn(m.root, "urgent")).toEqual(["Ring mum"]);
		expect(viewButton(matrix(m.root))!.querySelector(".cp-view-dot")).not.toBeNull();
		m.host.dismissMenu();
		await settle();

		await m.h.app.tags.edit("calls", { name: "Phone", parentKey: null, color: "red" });
		await settle();
		expect(viewButton(matrix(m.root))!.querySelector(".cp-view-dot")).toBeNull();
		expect([...titlesIn(m.root, "urgent")].sort()).toEqual(["Plain", "Ring mum"]);
		const menu = (await pickItem(m, await openViewMenu(m, matrix(m.root)), "Tags…"))!;
		expect(checkedOf(menu, "@Phone")).toBe(false);
	});

	it("the calendar drops a deleted tag: the dot goes off", async () => {
		const m = await mountApp();
		await m.h.app.tags.create("Calls");
		m.handle.current!.showSection("calendar");
		await settle();
		await pickItem(m, (await pickItem(m, await openViewMenu(m, cal(m.root)), "Tags…"))!, "@Calls");
		expect(viewButton(cal(m.root))!.querySelector(".cp-view-dot")).not.toBeNull();
		m.host.dismissMenu();
		await m.h.app.tags.delete("calls");
		await settle();
		expect(viewButton(cal(m.root))!.querySelector(".cp-view-dot")).toBeNull();
	});

	it("search drops a renamed tag: Clear filters goes away", async () => {
		const m = await mountApp();
		await m.h.app.tags.create("Calls");
		m.handle.current!.showSection("search");
		await settle();
		const search = m.root.querySelector<HTMLElement>(".cp-search")!;
		await click(search.querySelector('[aria-label="Show filters"]'));
		await click([...search.querySelectorAll<HTMLButtonElement>(".cp-toggle-chip")].find((b) => b.textContent.includes("Calls")));
		const clear = () => [...search.querySelectorAll("button")].find((b) => b.textContent === "Clear filters");
		expect(clear()).toBeDefined();
		await m.h.app.tags.edit("calls", { name: "Phone", parentKey: null, color: null });
		await settle();
		expect(clear()).toBeUndefined();
	});
});
