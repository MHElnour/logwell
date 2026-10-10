// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CalMount, byLabel, cal, mountCal, openCalendar, settle } from "./m3-helpers";
import { menuItems, openViewMenu, viewButton } from "./view-menu-helpers";

// "Lists…" and "Tags…" show their menu again after a pick. The loop must end when the
// menu is dismissed, when the section is hidden and when it unmounts.

const mounted: CalMount[] = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
	vi.useRealTimers();
});
async function mountWithCategory() {
	const m = await mountCal();
	mounted.push(m);
	await m.h.app.categories.create("Study", null);
	await openCalendar(m);
	return m;
}
const run = (menu: ReturnType<typeof menuItems>, title: string) => menu.find((i) => i.title === title)!.run();
const elapse = async () => {
	await vi.advanceTimersByTimeAsync(10);
	await settle();
};

describe("Lists… loop", () => {
	it("shows the menu again after a pick", async () => {
		const m = await mountWithCategory();
		const root = await openViewMenu(m, cal(m.root));
		run(menuItems(root), "Lists…");
		await elapse();
		const lists = m.host.menus.at(-1)!;
		const before = m.host.menus.length;
		run(menuItems(lists), "Study");
		await elapse();
		expect(m.host.menus.length).toBe(before + 1);
	});

	it("a dismissed menu does not reopen, and focus returns to the ⋯ button", async () => {
		const m = await mountWithCategory();
		const root = await openViewMenu(m, cal(m.root));
		run(menuItems(root), "Lists…");
		await elapse();
		const before = m.host.menus.length;
		m.host.dismissMenu();
		await elapse();
		await vi.advanceTimersByTimeAsync(1000);
		expect(m.host.menus.length).toBe(before);
		expect(document.activeElement).toBe(viewButton(cal(m.root)));
	});

	it("a pick followed by a dismissal of the reopened menu ends the loop", async () => {
		const m = await mountWithCategory();
		run(menuItems(await openViewMenu(m, cal(m.root))), "Lists…");
		await elapse();
		run(menuItems(m.host.menus.at(-1)!), "Study");
		await elapse();
		const before = m.host.menus.length;
		m.host.dismissMenu();
		await elapse();
		expect(m.host.menus.length).toBe(before);
	});

	it("a menu closed by its own pick is not taken for a dismissal", async () => {
		const m = await mountWithCategory();
		run(menuItems(await openViewMenu(m, cal(m.root))), "Lists…");
		await elapse();
		const before = m.host.menus.length;
		// The host closes the menu on a pick: the pick and the close signal both arrive.
		run(menuItems(m.host.menus.at(-1)!), "Study");
		m.host.dismissMenu();
		await elapse();
		expect(m.host.menus.length).toBe(before + 1);
	});

	it("does not reopen after the section unmounts", async () => {
		const m = await mountWithCategory();
		run(menuItems(await openViewMenu(m, cal(m.root))), "Lists…");
		await elapse();
		const before = m.host.menus.length;
		run(menuItems(m.host.menus.at(-1)!), "Study");
		m.unmount();
		await elapse();
		expect(m.host.menus.length).toBe(before);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not reopen once the section is hidden", async () => {
		const m = await mountWithCategory();
		run(menuItems(await openViewMenu(m, cal(m.root))), "Lists…");
		await elapse();
		const before = m.host.menus.length;
		run(menuItems(m.host.menus.at(-1)!), "Study");
		(byLabel(m.root, "Tasks") as HTMLElement).click(); // hides the calendar in the same tick as the pick
		await elapse();
		expect(m.host.menus.length).toBe(before);
	});
});
