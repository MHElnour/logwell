import { render } from "preact";
import { vi } from "vitest";
import { DEFAULT_SETTINGS, type CheckpointSettings } from "../../src/app/settings";
import { AppRoot, type AppRootHandle } from "../../src/ui/AppRoot";
import { type AppHarness, appHarness } from "../app/harness";
import { U1Host, settle as realSettle } from "./app-helpers";

/** Lets pending promises and zero-delay timers run; also works while vitest's timers are faked. */
export async function settle(): Promise<void> {
	if (!vi.isFakeTimers()) return realSettle();
	for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

export interface CalMount {
	h: AppHarness;
	host: U1Host;
	root: HTMLElement;
	handle: { current: AppRootHandle | null };
	/** Re-renders the app (settings and the clock are read on render). */
	rerender: () => Promise<void>;
	unmount: () => void;
}

/**
 * Mounts the whole app for the calendar tests. The fake clock starts at 2026-10-01T10:00Z, so
 * the display zone (Europe/Berlin) shows Thursday 2026-10-01, 12:00.
 */
export async function mountCal(settings: Partial<CheckpointSettings> = {}): Promise<CalMount> {
	(HTMLElement.prototype as unknown as { empty: () => void }).empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
	const h = await appHarness();
	const host = new U1Host(h);
	host.settings = () => ({ ...DEFAULT_SETTINGS, ...settings });
	const root = document.createElement("div");
	document.body.appendChild(root);
	const handle: { current: AppRootHandle | null } = { current: null };
	const view = () => <AppRoot host={host} initialSection={null} handle={(x) => (handle.current = x)} />;
	render(view(), root);
	await settle();
	return {
		h,
		host,
		root,
		handle,
		rerender: async () => {
			render(view(), root);
			await settle();
		},
		unmount: () => {
			render(null, root);
			root.remove();
		},
	};
}

export const cal = (root: HTMLElement) => root.querySelector<HTMLElement>(".cp-calendar")!;

export async function click(el: Element | null | undefined): Promise<void> {
	if (el === null || el === undefined) throw new Error("element not found");
	(el as HTMLElement).click();
	await settle();
}

export async function openCalendar(m: CalMount): Promise<HTMLElement> {
	await click(m.root.querySelector('.cp-rail [aria-label="Calendar"]'));
	return cal(m.root);
}

export const byLabel = (root: ParentNode, label: string) => root.querySelector<HTMLElement>(`[aria-label="${label}"]`);

export const title = (root: HTMLElement) => cal(root).querySelector(".cp-cal-title")?.textContent;

/** The visually hidden accessible name of an entry button. */
export const entryName = (btn: Element) => btn.querySelector(".cp-sr-only")?.textContent ?? "";

/** The entry button for a task title, optionally restricted to one container selector. */
export function entry(root: ParentNode, text: string, within = ""): HTMLButtonElement {
	const found = [...root.querySelectorAll<HTMLButtonElement>(`${within} .cp-cal-entry`.trim())].filter((b) => entryName(b).startsWith(`${text},`));
	if (found.length === 0) throw new Error(`no entry "${text}" in ${within || "calendar"}`);
	return found[0]!;
}

export const entries = (root: ParentNode, text: string, within = "") =>
	[...root.querySelectorAll<HTMLButtonElement>(`${within} .cp-cal-entry`.trim())].filter((b) => entryName(b).startsWith(`${text},`));

export const cell = (root: ParentNode, kind: "allday-cell" | "daycol" | "cell", date: string) =>
	root.querySelector<HTMLElement>(`.cp-cal-${kind}[data-date="${date}"]`)!;

export function press(el: Element, key: string, init: KeyboardEventInit = {}): boolean {
	return el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

export const weekDates = (root: HTMLElement) =>
	[...cal(root).querySelectorAll<HTMLElement>(".cp-cal-dayhead")].map((e) => e.getAttribute("data-date"));
