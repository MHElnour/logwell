import type { HabitInput } from "../../src/domain/habits";
import type { Habit } from "../../src/domain/types";
import type { HabitDialogOptions } from "../../src/ui/host";
import type { AppHarness } from "../app/harness";
import { type AppMount, click, mountApp, type Notice, qa, recordNotices, text } from "./app-helpers";

// Shared by the habit UI tests: a mounted app whose host records the Undo notices (message and store label), the
// dialogs it was asked to open and the reminder gestures, and the five habits of the mockup.

export interface HabitMount extends AppMount {
	notices: Notice[];
	dialogs: HabitDialogOptions[];
	gestures: { n: number };
	opened: string[];
}

export async function mountHabits(): Promise<HabitMount> {
	const m = await mountApp();
	const notices = recordNotices(m.host);
	const dialogs: HabitDialogOptions[] = [];
	const gestures = { n: 0 };
	const opened: string[] = [];
	m.host.habitDialog = async (o) => void dialogs.push(o);
	m.host.reminderGesture = () => void gestures.n++;
	(m.host as unknown as { openSection: (s: string) => void }).openSection = (s) => void opened.push(s);
	return Object.assign(m, { notices, dialogs, gestures, opened });
}

export const input = (patch: Partial<HabitInput> = {}): HabitInput => ({
	name: "Read",
	icon: "book-open",
	color: "purple",
	timeOfDay: "evening",
	reminder: null,
	goal: { type: "quantity", target: 30, unit: "min", period: "day" },
	schedule: { kind: "daily" },
	...patch,
});

export interface Seeded {
	read: Habit;
	water: Habit;
	meditate: Habit;
	gym: Habit;
	walk: Habit;
}

/** Sunday 2026-10-04, 20:30 in Europe/Berlin. */
export const SUNDAY_EVENING = "2026-10-04T18:30:00.000Z";

/**
 * The mockup's five habits, created on Monday 2026-09-28 and filled up to Sunday 2026-10-04 (20:30 Berlin):
 * Read (30 min, evening, 20:00 reminder) met Sep 29 to Oct 3 and 20 min today; Water (8 glasses) 5 today;
 * Meditate (morning) checked Sep 30 to Oct 4; Gym (3 a week, afternoon) once on Oct 2; Walk (Mon, Wed, Fri).
 * Today: 1 of 4 scheduled habits done.
 */
export async function seedMockup(h: AppHarness): Promise<Seeded> {
	const app = h.app;
	h.clock.set("2026-09-28T08:00:00.000Z");
	const read = await app.habits.create(input({ reminder: { time: "20:00" } }));
	const water = await app.habits.create(
		input({ name: "Drink water", icon: "droplet", color: "blue", timeOfDay: "anytime", goal: { type: "count", target: 8, unit: "glasses", period: "day" } }),
	);
	const meditate = await app.habits.create(
		input({ name: "Meditate", icon: "flower-2", color: "pink", timeOfDay: "morning", goal: { type: "binary", target: 1, unit: null, period: "day" } }),
	);
	const gym = await app.habits.create(
		input({ name: "Gym", icon: "dumbbell", color: "orange", timeOfDay: "afternoon", goal: { type: "binary", target: 3, unit: null, period: "week" }, schedule: { kind: "weekly" } }),
	);
	const walk = await app.habits.create(
		input({ name: "Walk", icon: "footprints", color: "cyan", timeOfDay: "anytime", goal: { type: "binary", target: 1, unit: null, period: "day" }, schedule: { kind: "weekdays", days: ["MO", "WE", "FR"] } }),
	);
	h.clock.set(SUNDAY_EVENING);
	for (const d of ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]) await app.habits.add(read.id, d, 30);
	await app.habits.add(read.id, "2026-10-04", 20);
	for (let i = 0; i < 5; i++) await app.habits.add(water.id, "2026-10-04", 1);
	for (const d of ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]) await app.habits.toggle(meditate.id, d, true);
	await app.habits.toggle(gym.id, "2026-10-02", true);
	return { read, water, meditate, gym, walk };
}

export async function openHabits(m: AppMount): Promise<HTMLElement> {
	await click(m.root.querySelector('.cp-rail [aria-label="Habits"]'));
	return m.root.querySelector<HTMLElement>(".cp-habits")!;
}

/** The row of a habit on the page, by name. */
export const rowOf = (root: ParentNode, name: string): HTMLElement => {
	const row = qa(root, ".cp-habit-row").find((r) => text(r.querySelector(".cp-habit-name")) === name);
	if (row === undefined) throw new Error(`no row "${name}"`);
	return row;
};
