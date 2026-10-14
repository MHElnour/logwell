import { expect } from "vitest";
import type { MenuItemSpec, MenuSpec } from "../../src/ui/host";
import { type AppMount, click, settle } from "./app-helpers";

// The ⋯ "View options" menu. The test host records each menu it is asked to show.

export const menuItems = (menu: MenuSpec): MenuItemSpec[] => menu.filter((i): i is MenuItemSpec => i !== "separator");
export const menuTitles = (menu: MenuSpec): string[] => menuItems(menu).map((i) => i.title);
export const viewButton = (scope: ParentNode) => scope.querySelector<HTMLButtonElement>('[aria-label="View options"]');

/** Clicks the scope's ⋯ button and returns the menu the host was asked to show. */
export async function openViewMenu(m: AppMount, scope: ParentNode): Promise<MenuSpec> {
	const before = m.host.menus.length;
	await click(viewButton(scope));
	expect(m.host.menus.length).toBe(before + 1);
	return m.host.menus.at(-1)!;
}

/** Runs the named item and returns the menu shown next, if any (a submenu shows itself again after a pick). */
export async function pickItem(m: AppMount, menu: MenuSpec, title: string): Promise<MenuSpec | null> {
	const item = menuItems(menu).find((i) => i.title === title);
	if (item === undefined) throw new Error(`no menu item "${title}" in ${JSON.stringify(menuTitles(menu))}`);
	const before = m.host.menus.length;
	item.run();
	await settle();
	return m.host.menus.length > before ? m.host.menus.at(-1)! : null;
}

export const checkedOf = (menu: MenuSpec, title: string) => menuItems(menu).find((i) => i.title === title)?.checked;
