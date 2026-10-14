import { type AppMount, click, rect } from "./app-helpers";

// The calendar's parts, and its fake layout for drags (happy-dom has none): day column i spans x 100 i to 100 i + 100,
// minute m of a column is y = m * 48 / 60 (HOUR_PX), the all-day row is y -100 to -50, the sticky header ends at -50.

export const cal = (root: HTMLElement) => root.querySelector<HTMLElement>(".cp-calendar")!;

export async function openCalendar(m: AppMount): Promise<HTMLElement> {
	await click(m.root.querySelector('.cp-rail [aria-label="Calendar"]'));
	return cal(m.root);
}

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

export const weekDates = (root: HTMLElement) =>
	[...cal(root).querySelectorAll<HTMLElement>(".cp-cal-dayhead")].map((e) => e.getAttribute("data-date"));

/** Gives the week's day columns, all-day cells, scroller and sticky header their fake boxes. */
export function stubWeek(root: HTMLElement): void {
	const w = cal(root);
	w.querySelectorAll<HTMLElement>(".cp-cal-daycol").forEach((c, i) => (c.getBoundingClientRect = () => rect(100 * i, 0, 100 * i + 100, 1152)));
	w.querySelectorAll<HTMLElement>(".cp-cal-allday-cell").forEach((c, i) => (c.getBoundingClientRect = () => rect(100 * i, -100, 100 * i + 100, -50)));
	const scroller = w.querySelector<HTMLElement>(".cp-cal-scroller");
	if (scroller !== null) scroller.getBoundingClientRect = () => rect(0, -1000, 700, 2000);
	const sticky = w.querySelector<HTMLElement>(".cp-cal-sticky");
	if (sticky !== null) sticky.getBoundingClientRect = () => rect(0, -1000, 700, -50);
}

/** Gives the month's cells 100 x 100 boxes, seven to a row. */
export function stubMonth(root: HTMLElement): void {
	cal(root)
		.querySelectorAll<HTMLElement>(".cp-cal-cell")
		.forEach((c, i) => (c.getBoundingClientRect = () => rect(100 * (i % 7), 100 * Math.floor(i / 7), 100 * (i % 7) + 100, 100 * Math.floor(i / 7) + 100)));
}
