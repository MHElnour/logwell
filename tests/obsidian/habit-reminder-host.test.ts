// @vitest-environment happy-dom
import { Settings } from "luxon";
import { Plugin } from "obsidian";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { CheckpointApp } from "../../src/app/App";
import { CHECKIN_LABEL } from "../../src/app/HabitService";
import { MemoryReminderState, type ReminderStatePort, type SettingsPort } from "../../src/app/ports";
import { isDomainError } from "../../src/domain/errors";
import { emptyReminderState, parseReminderState } from "../../src/domain/habitReminders";
import type { HabitInput } from "../../src/domain/habits";
import { HabitReminderHost, type ReminderApp, type ReminderHostUi } from "../../src/obsidian/habitReminderHost";
import type { NoticeAction } from "../../src/obsidian/notices";
import { SystemNotifier } from "../../src/obsidian/systemNotification";
import { FakeNotes, makeReadOnly } from "../app/harness";
import { progressText } from "../../src/ui/habits/format";
import { emptyDbText, harness } from "../persistence/fixtures";
import { sequentialIds } from "../helpers";
import { fakeApp, fakeLocal, loadPlugin } from "./fake-vault";
import { LocalStorageReminderState } from "../../src/obsidian/reminderState";

describe("reminder host", () => {
	// The habit reminder host. Europe/Berlin; 2026-10-14 is a Wednesday (CEST, UTC+2),
	// so 20:00 on the wall clock is 18:00Z.

	const MIN = 60_000;
	const at = (date: string, utcTime: string) => `${date}T${utcTime}.000Z`;
	const BEFORE = at("2026-10-14", "17:59:30"); // 19:59:30 local
	const AT_20 = at("2026-10-14", "18:00:10"); // 20:00:10 local

	const SETTINGS: SettingsPort = {
		zone: () => "Europe/Berlin",
		noteFolder: () => "Task notes",
		upcomingDays: () => 14,
		weekStart: () => "MO",
		eveningTime: () => "20:00",
	};

	const quantity = (patch: Partial<HabitInput> = {}): HabitInput => ({
		name: "Read",
		icon: null,
		color: null,
		timeOfDay: "evening",
		reminder: { time: "20:00" },
		goal: { type: "quantity", target: 30, unit: "min", period: "day" },
		schedule: { kind: "daily" },
		...patch,
	});
	const binary = (patch: Partial<HabitInput> = {}) => quantity({ name: "Meditate", goal: { type: "binary", target: 1, unit: null, period: "day" }, ...patch });
	const count = (patch: Partial<HabitInput> = {}) => quantity({ name: "Water", goal: { type: "count", target: 8, unit: "glasses", period: "day" }, ...patch });

	interface Shown {
		message: string;
		actions: NoticeAction[];
		timeout: number;
		hide: Mock<() => void>;
	}

	function fakeUi() {
		const shown: Shown[] = [];
		const ui = {
			actionNotice: vi.fn((message: string, actions: NoticeAction[], timeout: number) => {
				const hide = vi.fn<() => void>();
				shown.push({ message, actions, timeout, hide });
				return { hide };
			}),
			systemNotify: vi.fn(),
			openHabits: vi.fn(),
			notifyUndo: vi.fn(),
			requestNotifyPermission: vi.fn(),
			error: vi.fn(),
		} satisfies ReminderHostUi;
		return { ui, shown };
	}

	async function makeApp(dbId = "db-1", iso = at("2026-10-14", "10:00:00"), state: ReminderStatePort = new MemoryReminderState()) {
		const h = harness(emptyDbText(dbId));
		await h.store.open();
		h.clock.set(iso);
		const app = new CheckpointApp(h.store, h.clock, sequentialIds("h"), SETTINGS, new FakeNotes(), undefined, undefined, undefined, state);
		return { h, app };
	}

	/** The slice main.ts attaches: the session's services and reminder port, and its dbId read on every check. */
	function r(app: CheckpointApp, dbId: () => string = () => app.store.state.meta.dbId): ReminderApp {
		return { habits: app.habits, settings: app.settings, store: app.store, reminders: app.reminders, dbId };
	}

	async function setup(iso = at("2026-10-14", "10:00:00"), state: ReminderStatePort = new MemoryReminderState()) {
		const { h, app } = await makeApp("db-1", iso, state);
		const { ui, shown } = fakeUi();
		const host = new HabitReminderHost(ui, h.clock);
		/** Moves the clock and ticks, the way the 30 s interval does. */
		const tickAt = (iso2: string) => {
			h.clock.set(iso2);
			host.tick();
		};
		/** Ticks once per minute from now for `minutes` minutes. */
		const tickMinutes = (minutes: number) => {
			for (let i = 0; i < minutes; i++) {
				h.clock.advance(MIN);
				host.tick();
			}
		};
		return { h, app, ui, shown, host, state, tickAt, tickMinutes };
	}

	const labels = (s: Shown) => s.actions.map((a) => a.label);
	const press = async (s: Shown, label: string) => {
		const action = s.actions.find((a) => a.label === label);
		if (action === undefined) throw new Error(`no ${label}`);
		await action.run();
	};

	afterEach(() => vi.restoreAllMocks());

	describe("a reminder fires at its minute", () => {
		it("fires once with the text, both buttons, sticky, and one system notification", async () => {
			const { app, ui, shown, host, tickAt } = await setup();
			await app.habits.create(quantity());
			host.attach(r(app));
			tickAt(BEFORE);
			expect(shown).toHaveLength(0);
			tickAt(AT_20);
			expect(shown).toHaveLength(1);
			expect(shown[0]!.message).toBe("Time for Read · 0 of 30 min");
			expect(labels(shown[0]!)).toEqual(["Check in", "Snooze 10 min"]);
			expect(shown[0]!.timeout).toBe(0);
			expect(ui.systemNotify).toHaveBeenCalledTimes(1);
			expect(ui.systemNotify).toHaveBeenCalledWith("Time for Read", "0 of 30 min");
		});

		it("#100: fires at its minute, not before, on a device whose language writes other digits", async () => {
			const before = Settings.defaultLocale;
			Settings.defaultLocale = "ar-EG";
			try {
				const { app, shown, host, tickAt } = await setup();
				await app.habits.create(quantity());
				host.attach(r(app));
				tickAt(BEFORE);
				expect(shown).toHaveLength(0);
				tickAt(AT_20);
				expect(shown.map((s) => s.message)).toEqual(["Time for Read · 0 of 30 min"]);
			} finally {
				Settings.defaultLocale = before;
			}
		});

		it("does not fire again that day, and fires again on a new day", async () => {
			const { app, shown, host, tickAt, tickMinutes } = await setup();
			await app.habits.create(quantity());
			host.attach(r(app));
			tickAt(AT_20);
			expect(shown).toHaveLength(1);
			host.tick();
			tickMinutes(120);
			expect(shown).toHaveLength(1);
			tickAt(at("2026-10-15", "17:59:30"));
			expect(shown).toHaveLength(1);
			tickAt(at("2026-10-15", "18:00:05"));
			expect(shown).toHaveLength(2);
		});

		it("does nothing until the device minute changes (tick), while check() always checks", async () => {
			const { app, shown, host, h, state } = await setup();
			await app.habits.create(quantity());
			const load = vi.spyOn(state, "load");
			host.attach(r(app));
			const list = vi.spyOn(app.habits, "list");
			host.tick();
			host.tick();
			expect(list).not.toHaveBeenCalled();
			host.check();
			expect(list).toHaveBeenCalledTimes(1);
			h.clock.advance(MIN);
			host.tick();
			expect(list).toHaveBeenCalledTimes(2);
			expect(shown).toHaveLength(0);
			// The stored state is read on attach only; later checks build on the state in memory.
			expect(load).toHaveBeenCalledTimes(1);
		});

		it("shows the progress of each goal type", async () => {
			const { app, h } = await setup();
			const read = await app.habits.create(quantity());
			const water = await app.habits.create(count());
			const med = await app.habits.create(binary());
			const gym = await app.habits.create(
				binary({ name: "Gym", goal: { type: "binary", target: 3, unit: null, period: "week" }, schedule: { kind: "weekly" } }),
			);
			await app.habits.add(read.id, "2026-10-14", 20);
			for (let i = 0; i < 5; i++) await app.habits.add(water.id, "2026-10-14", 1);
			await app.habits.toggle(gym.id, "2026-10-14", true);
			const today = "2026-10-14";
			const index = app.habits.index();
			expect(progressText(read, index, today)).toBe("20 of 30 min");
			expect(progressText(water, index, today)).toBe("5 of 8 glasses");
			expect(progressText(med, index, today)).toBe("every day");
			expect(progressText(gym, index, today)).toBe("1 of 3 this week");
			void h;
		});
	});

	describe("Check in from the notice", () => {
		it("checks a binary habit in with the Undo notice carrying the service's label", async () => {
			const { app, ui, shown, host, tickAt } = await setup();
			const med = await app.habits.create(binary());
			host.attach(r(app));
			tickAt(AT_20);
			expect(shown[0]!.message).toBe("Time for Meditate · every day");
			const toggle = vi.spyOn(app.habits, "toggle");
			await press(shown[0]!, "Check in");
			expect(toggle).toHaveBeenCalledWith(med.id, "2026-10-14", true);
			expect(app.habits.index().active(med.id)).toHaveLength(1);
			expect(ui.notifyUndo).toHaveBeenCalledWith("Checked in Meditate.", expect.any(Function));
			expect(app.store.undoLabel).toBe(CHECKIN_LABEL);
			expect(ui.error).not.toHaveBeenCalled();
		});

		it("never turns off a binary check-in made in the meantime", async () => {
			const { app, ui, shown, host, tickAt } = await setup();
			const med = await app.habits.create(binary());
			host.attach(r(app));
			tickAt(AT_20);
			await app.habits.toggle(med.id, "2026-10-14", true);
			await press(shown[0]!, "Check in");
			expect(app.habits.index().active(med.id)).toHaveLength(1);
			expect(ui.notifyUndo).not.toHaveBeenCalled();
		});

		it("adds 1 to a count habit", async () => {
			const { app, ui, shown, host, tickAt } = await setup();
			const water = await app.habits.create(count());
			host.attach(r(app));
			tickAt(AT_20);
			expect(shown[0]!.message).toBe("Time for Water · 0 of 8 glasses");
			await press(shown[0]!, "Check in");
			const active = app.habits.index().active(water.id);
			expect(active.map((c) => c.value)).toEqual([1]);
			expect(ui.notifyUndo).toHaveBeenCalledWith("Checked in Water.", expect.any(Function));
			expect(app.store.undoLabel).toBe(CHECKIN_LABEL);
		});

		it("opens the Habits page on a quantity habit with its control focused, and writes nothing", async () => {
			const { app, ui, shown, host, tickAt } = await setup();
			const read = await app.habits.create(quantity());
			host.attach(r(app));
			tickAt(AT_20);
			const before = app.store.state.checkins;
			await press(shown[0]!, "Check in");
			expect(ui.openHabits).toHaveBeenCalledWith(read.id, true);
			expect(app.store.state.checkins).toBe(before);
			expect(ui.notifyUndo).not.toHaveBeenCalled();
		});
	});

	describe("Snooze 10 min", () => {
		it("is quiet for 10 minutes, then fires again while still not met", async () => {
			const { app, shown, host, tickAt, tickMinutes } = await setup();
			await app.habits.create(quantity());
			host.attach(r(app));
			tickAt(AT_20);
			await press(shown[0]!, "Snooze 10 min");
			tickMinutes(9); // up to 20:09:10
			expect(shown).toHaveLength(1);
			tickAt(at("2026-10-14", "18:09:59"));
			expect(shown).toHaveLength(1);
			tickAt(at("2026-10-14", "18:10:10")); // the snooze ends
			expect(shown).toHaveLength(2);
			expect(shown[1]!.message).toBe("Time for Read · 0 of 30 min");
		});

		it("a check-in during the snooze cancels it", async () => {
			const { app, shown, host, tickAt, tickMinutes } = await setup();
			const med = await app.habits.create(binary());
			host.attach(r(app));
			tickAt(AT_20);
			await press(shown[0]!, "Snooze 10 min");
			tickMinutes(3);
			await app.habits.toggle(med.id, "2026-10-14", true);
			tickMinutes(30);
			expect(shown).toHaveLength(1);
		});
	});

	describe("catch-up and device state", () => {
		it("attach at 21:00 with two 20:00 reminders shows one combined notice and marks both fired", async () => {
			const { app, ui, shown, host, h, state } = await setup();
			const read = await app.habits.create(quantity());
			const med = await app.habits.create(binary());
			host.attach(r(app)); // seen at 12:00, before their time
			host.detach();
			h.clock.set(at("2026-10-14", "19:00:00"));
			host.attach(r(app));
			expect(shown).toHaveLength(1);
			expect(shown[0]!.message).toBe("Habit reminders: Read, Meditate");
			expect(labels(shown[0]!)).toEqual(["Open habits"]);
			expect(shown[0]!.timeout).toBe(0);
			expect(ui.systemNotify).toHaveBeenCalledWith("Habit reminders", "Read, Meditate");
			expect(parseReminderState(state.load("db-1"))?.fired).toEqual({ [read.id]: true, [med.id]: true });
			await press(shown[0]!, "Open habits");
			expect(ui.openHabits).toHaveBeenCalledWith(null, false);

			host.detach();
			h.clock.set(at("2026-10-15", "10:00:00"));
			host.attach(r(app));
			expect(shown).toHaveLength(1);
		});

		it("closing the notice without an action leaves it fired for today", async () => {
			const { app, shown, host, tickAt, state } = await setup();
			const read = await app.habits.create(quantity());
			host.attach(r(app));
			tickAt(AT_20);
			shown[0]!.hide();
			expect(parseReminderState(state.load("db-1"))?.fired[read.id]).toBe(true);
			host.check();
			expect(shown).toHaveLength(1);
		});

		it("marks fired and saves before showing, so a notice that throws never repeats", async () => {
			const { app, ui, host, tickAt, state, tickMinutes } = await setup();
			const read = await app.habits.create(quantity());
			host.attach(r(app));
			ui.actionNotice.mockImplementationOnce(() => {
				throw new Error("notice broke");
			});
			expect(() => tickAt(AT_20)).not.toThrow();
			expect(ui.error).toHaveBeenCalledTimes(1);
			expect(parseReminderState(state.load("db-1"))?.fired[read.id]).toBe(true);
			tickMinutes(5);
			expect(ui.actionNotice).toHaveBeenCalledTimes(1);
		});

		it("ignores an unreadable stored state (arms what is past, fires later ones)", async () => {
			const bad: ReminderStatePort = new MemoryReminderState();
			const raw = { v: 1, date: "not a date", fired: 3 };
			let stored: unknown = raw;
			bad.load = () => stored;
			bad.save = (_db, s) => void (stored = s);
			const { app, shown, host, tickAt, ui } = await setup(at("2026-10-14", "10:00:00"), bad);
			await app.habits.create(quantity());
			await app.habits.create(binary({ reminder: { time: "08:00" } }));
			host.attach(r(app));
			expect(shown).toHaveLength(0); // 08:00 is already past: armed, not fired
			expect(ui.error).not.toHaveBeenCalled();
			tickAt(AT_20);
			expect(shown.map((s) => s.message)).toEqual(["Time for Read · 0 of 30 min"]);
		});

		it("tick never throws: errors go to ui.error, an identical one once per attach and day", async () => {
			const { app, ui, host, h, tickMinutes } = await setup();
			await app.habits.create(quantity());
			host.attach(r(app));
			let message = "boom";
			vi.spyOn(app.habits, "list").mockImplementation(() => {
				throw new Error(message);
			});
			h.clock.advance(MIN);
			expect(() => host.tick()).not.toThrow();
			expect(() => host.check()).not.toThrow();
			tickMinutes(30);
			expect(ui.error).toHaveBeenCalledTimes(1);
			message = "another";
			tickMinutes(1);
			expect(ui.error).toHaveBeenCalledTimes(2);
			message = "boom";
			tickMinutes(1);
			expect(ui.error).toHaveBeenCalledTimes(2);
			// A new day shows it again, once.
			h.clock.set(at("2026-10-15", "08:00:00"));
			host.tick();
			tickMinutes(5);
			expect(ui.error).toHaveBeenCalledTimes(3);
			// So does a new attach.
			host.attach(r(app));
			tickMinutes(5);
			expect(ui.error).toHaveBeenCalledTimes(4);
		});

		it("a state port that throws is reported, never thrown", async () => {
			const broken: ReminderStatePort = {
				load: () => {
					throw new Error("storage gone");
				},
				save: () => undefined,
			};
			const { app, ui, host } = await setup(at("2026-10-14", "10:00:00"), broken);
			await app.habits.create(quantity());
			expect(() => host.attach(r(app))).not.toThrow();
			expect(ui.error).toHaveBeenCalledTimes(1);
		});

		it("detach stops ticks and hides the open notices", async () => {
			const { app, shown, host, tickAt } = await setup();
			await app.habits.create(quantity());
			await app.habits.create(binary({ reminder: { time: "20:05" } }));
			host.attach(r(app));
			tickAt(AT_20);
			expect(shown).toHaveLength(1);
			host.detach();
			expect(shown[0]!.hide).toHaveBeenCalled();
			tickAt(at("2026-10-14", "18:06:00"));
			host.check();
			expect(shown).toHaveLength(1);
		});

		it("a database switch re-attaches with the new dbId and its own state", async () => {
			const state = new MemoryReminderState();
			const a = await makeApp("db-a", undefined, state);
			const b = await makeApp("db-b", undefined, state);
			const { ui, shown } = fakeUi();
			const clock = a.h.clock;
			const host = new HabitReminderHost(ui, clock);
			const ra = await a.app.habits.create(quantity());
			const rb = await b.app.habits.create(quantity({ name: "Run" }));
			expect(rb.id).toBe(ra.id); // the same id in both databases: only separate state keeps them apart
			host.attach(r(a.app));
			host.detach();
			host.attach(r(b.app));
			clock.set(AT_20);
			b.h.clock.set(AT_20);
			host.tick();
			expect(shown.map((s) => s.message)).toEqual(["Time for Run · 0 of 30 min"]);
			host.detach();
			host.attach(r(a.app));
			expect(shown.map((s) => s.message)).toEqual(["Time for Run · 0 of 30 min", "Time for Read · 0 of 30 min"]);
			host.detach();
			host.attach(r(b.app));
			expect(shown).toHaveLength(2);
			expect(Object.keys(parseReminderState(state.load("db-a"))!.fired)).toEqual([ra.id]);
			expect(Object.keys(parseReminderState(state.load("db-b"))!.fired)).toEqual([rb.id]);
		});

		it("a read-only database still fires, and Check in reports the ReadOnly error", async () => {
			const { app, ui, shown, host, tickAt, h } = await setup();
			await app.habits.create(binary());
			await h.store.flush();
			await makeReadOnly(h);
			host.attach(r(app));
			tickAt(AT_20);
			expect(shown).toHaveLength(1);
			await press(shown[0]!, "Check in");
			expect(ui.error).toHaveBeenCalledTimes(1);
			expect(isDomainError(ui.error.mock.calls[0]![0], "ReadOnly")).toBe(true);
			expect(ui.notifyUndo).not.toHaveBeenCalled();
		});
	});

	/** A port whose save always throws; load reads what the test puts in `stored`. */
	function failingSave(stored: unknown = null) {
		const save = vi.fn((): void => {
			throw new Error("storage full");
		});
		return { port: { load: () => stored, save } satisfies ReminderStatePort, save };
	}

	describe("notices across days, failing stores and database switches", () => {
		it("a sticky notice of yesterday is hidden by the first check of the new day", async () => {
			const { app, shown, host, tickAt } = await setup();
			await app.habits.create(quantity());
			await app.habits.create(binary({ reminder: { time: "23:00" } }));
			host.attach(r(app));
			tickAt(AT_20);
			expect(shown).toHaveLength(1);
			host.check();
			expect(shown[0]!.hide).not.toHaveBeenCalled();
			tickAt(at("2026-10-15", "06:00:00")); // 08:00 the next day
			expect(shown[0]!.hide).toHaveBeenCalledTimes(1);
		});

		it("a notice of today stays when another of today fires", async () => {
			const { app, shown, host, tickAt } = await setup();
			await app.habits.create(quantity());
			await app.habits.create(binary({ reminder: { time: "20:05" } }));
			host.attach(r(app));
			tickAt(AT_20);
			tickAt(at("2026-10-14", "18:05:10"));
			expect(shown).toHaveLength(2);
			expect(shown[0]!.hide).not.toHaveBeenCalled();
		});

		it("Check in on a notice of yesterday, clicked after midnight before any check, writes nothing and hides it", async () => {
			const { app, ui, shown, host, tickAt, h } = await setup();
			await app.habits.create(binary());
			host.attach(r(app));
			tickAt(AT_20);
			const before = app.store.state.checkins;
			h.clock.set(at("2026-10-15", "06:00:00"));
			await press(shown[0]!, "Check in");
			expect(app.store.state.checkins).toBe(before);
			expect(shown[0]!.hide).toHaveBeenCalled();
			expect(ui.notifyUndo).not.toHaveBeenCalled();
			expect(ui.error).not.toHaveBeenCalled();
		});

		it("Snooze on a notice of yesterday does nothing (no save, no fire)", async () => {
			const { app, shown, host, tickAt, h, state } = await setup();
			await app.habits.create(quantity({ reminder: { time: "23:55" } }));
			host.attach(r(app));
			tickAt(at("2026-10-14", "21:55:10"));
			expect(shown).toHaveLength(1);
			const save = vi.spyOn(state, "save");
			h.clock.set(at("2026-10-14", "22:01:00")); // 00:01 the next day
			await press(shown[0]!, "Snooze 10 min");
			expect(save).not.toHaveBeenCalled();
			expect(shown[0]!.hide).toHaveBeenCalled();
		});

		it("a store whose save throws fires a reminder once, not again on the next minutes", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			// The stored state already knows the habit's time (armed on an earlier day), so 20:00 fires when it comes.
			const stored = { v: 1, date: "2026-10-14", fired: {}, snoozedUntil: {}, times: {} as Record<string, string> };
			const { port, save } = failingSave(stored);
			const load = vi.spyOn(port, "load");
			const { app, ui, shown, host, tickAt, tickMinutes } = await setup(undefined, port);
			const habit = await app.habits.create(quantity());
			stored.times[habit.id] = "20:00";
			host.attach(r(app));
			tickAt(BEFORE);
			expect(shown).toHaveLength(0);
			tickAt(AT_20);
			expect(shown).toHaveLength(1);
			tickMinutes(30);
			expect(shown).toHaveLength(1);
			expect(save).toHaveBeenCalled();
			// Read once per attach, never again on the ticks; logged once, never shown as an error every minute.
			expect(load).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(ui.error).not.toHaveBeenCalled();
			// A new attach reads the store again (it still says "not fired"), fires once more and logs the failure once more.
			host.attach(r(app));
			expect(load).toHaveBeenCalledTimes(2);
			tickMinutes(30);
			expect(warn).toHaveBeenCalledTimes(2);
			expect(shown).toHaveLength(2);
		});

		it("Snooze works with a store whose save throws", async () => {
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const { port } = failingSave();
			const { app, shown, host, tickAt, tickMinutes } = await setup(undefined, port);
			await app.habits.create(quantity());
			host.attach(r(app));
			tickAt(AT_20);
			await press(shown[0]!, "Snooze 10 min");
			tickMinutes(9);
			expect(shown).toHaveLength(1);
			tickAt(at("2026-10-14", "18:10:10"));
			expect(shown).toHaveLength(2);
			tickMinutes(20);
			expect(shown).toHaveLength(2);
		});

		it("Snooze works with a store that cannot be read", async () => {
			const port: ReminderStatePort = {
				load: () => {
					throw new Error("storage gone");
				},
				save: () => undefined,
			};
			const { app, ui, shown, host, tickAt } = await setup(undefined, port);
			await app.habits.create(quantity());
			host.attach(r(app));
			expect(ui.error).toHaveBeenCalledTimes(1);
			tickAt(AT_20);
			expect(shown).toHaveLength(1);
			await press(shown[0]!, "Snooze 10 min");
			tickAt(at("2026-10-14", "18:05:10"));
			expect(shown).toHaveLength(1);
			tickAt(at("2026-10-14", "18:10:10"));
			expect(shown).toHaveLength(2);
			expect(ui.error).toHaveBeenCalledTimes(1);
		});

		it("a stored state of another date is reset on attach the same way a check does", async () => {
			const { app, shown, host, tickAt, state } = await setup();
			const read = await app.habits.create(quantity());
			state.save("db-1", { v: 1, date: "2026-10-13", fired: { [read.id]: true }, snoozedUntil: {}, times: { [read.id]: "20:00" } });
			host.attach(r(app));
			tickAt(AT_20);
			expect(shown).toHaveLength(1);
			expect(parseReminderState(state.load("db-1"))).toMatchObject({ date: "2026-10-14", fired: { [read.id]: true } });
		});

		it("the Undo acts on the database written to, and does nothing once the host moved on", async () => {
			const { app, ui, shown, host, tickAt } = await setup();
			const med = await app.habits.create(binary());
			host.attach(r(app));
			tickAt(AT_20);
			await press(shown[0]!, "Check in");
			const undo = ui.notifyUndo.mock.calls[0]![1] as () => Promise<boolean>;
			await expect(undo()).resolves.toBe(true);
			expect(app.habits.index().active(med.id)).toHaveLength(0);
			await expect(undo()).rejects.toThrow(); // its write is no longer the latest: UndoConflict

			// After a switch the Undo of the old database resolves false ("Nothing to undo.") and writes nothing.
			await press(shown[0]!, "Check in"); // the host is still on this app: writes again
			const undo2 = ui.notifyUndo.mock.calls[1]![1] as () => Promise<boolean>;
			host.detach();
			await expect(undo2()).resolves.toBe(false);
			expect(app.habits.index().active(med.id)).toHaveLength(1);
			expect(app.store.undoLabel).toBe(CHECKIN_LABEL);
		});

		it("a check-in whose write finishes after a database switch shows no Undo", async () => {
			const { app, ui, shown, host, tickAt } = await setup();
			await app.habits.create(binary());
			host.attach(r(app));
			tickAt(AT_20);
			const other = await makeApp("db-2");
			const real = app.habits.toggle.bind(app.habits);
			vi.spyOn(app.habits, "toggle").mockImplementation(async (...args) => {
				const result = await real(...args);
				host.attach(r(other.app)); // the switch lands while the write is in flight
				return result;
			});
			await press(shown[0]!, "Check in");
			expect(ui.notifyUndo).not.toHaveBeenCalled();
			expect(ui.error).not.toHaveBeenCalled();
		});

		it("a dbId change between checks loads the other key's state, and saves go to the new key", async () => {
			const { app, shown, host, tickAt, state } = await setup();
			const read = await app.habits.create(quantity());
			state.save("db-real", { v: 1, date: "2026-10-14", fired: { [read.id]: true }, snoozedUntil: {}, times: { [read.id]: "20:00" } });
			let dbId = "unknown";
			host.attach(r(app, () => dbId));
			expect(parseReminderState(state.load("unknown"))).not.toBeNull();
			dbId = "db-real";
			tickAt(AT_20);
			expect(shown).toHaveLength(0); // the real key's state says fired
			await app.habits.create(binary({ reminder: { time: "20:05" } }));
			tickAt(at("2026-10-14", "18:05:10"));
			expect(shown).toHaveLength(1);
			expect(Object.keys(parseReminderState(state.load("db-real"))!.fired)).toHaveLength(2);
			expect(Object.keys(parseReminderState(state.load("unknown"))!.fired)).toHaveLength(0);
		});

		it("the host uses the port of the attached app", async () => {
			const own = new MemoryReminderState();
			const { app, host, tickAt } = await setup(undefined, own);
			const read = await app.habits.create(quantity());
			host.attach(r(app));
			tickAt(AT_20);
			expect(app.reminders).toBe(own);
			expect(parseReminderState(own.load("db-1"))?.fired[read.id]).toBe(true);
		});
	});

	describe("notice buttons after the host moved on", () => {
		it("Check in and Snooze after detach do nothing", async () => {
			const { app, ui, shown, host, tickAt, state } = await setup();
			await app.habits.create(binary());
			host.attach(r(app));
			tickAt(AT_20);
			host.detach();
			const before = app.store.state.checkins;
			const save = vi.spyOn(state, "save");
			await press(shown[0]!, "Check in");
			await press(shown[0]!, "Snooze 10 min");
			expect(app.store.state.checkins).toBe(before);
			expect(save).not.toHaveBeenCalled();
			expect(ui.notifyUndo).not.toHaveBeenCalled();
			expect(ui.error).not.toHaveBeenCalled();
		});

		it("Check in and Snooze after a database switch do nothing to either database", async () => {
			const { app, ui, shown, host, tickAt, state } = await setup();
			await app.habits.create(binary());
			host.attach(r(app));
			tickAt(AT_20);
			const other = await makeApp("db-2", AT_20, state);
			host.attach(r(other.app));
			const before = app.store.state.checkins;
			const otherBefore = other.app.store.state.checkins;
			const save = vi.spyOn(state, "save");
			await press(shown[0]!, "Check in");
			await press(shown[0]!, "Snooze 10 min");
			expect(app.store.state.checkins).toBe(before);
			expect(other.app.store.state.checkins).toBe(otherBefore);
			expect(save).not.toHaveBeenCalled();
			expect(ui.notifyUndo).not.toHaveBeenCalled();
		});
	});

	describe("edge times at host level", () => {
		it("a snooze across midnight does not fire on the new day", async () => {
			const { app, shown, host, tickAt, tickMinutes } = await setup();
			await app.habits.create(quantity({ reminder: { time: "23:55" } }));
			host.attach(r(app));
			tickAt(at("2026-10-14", "21:55:10")); // 23:55:10
			expect(shown).toHaveLength(1);
			await press(shown[0]!, "Snooze 10 min"); // until 00:05:10
			tickMinutes(60);
			expect(shown).toHaveLength(1);
			tickAt(at("2026-10-15", "21:55:05")); // 23:55 the next day: fires once, as usual
			expect(shown).toHaveLength(2);
		});

		it("a time first seen at its own minute fires", async () => {
			const { app, shown, host, tickAt, h } = await setup();
			host.attach(r(app));
			h.clock.set(at("2026-10-14", "17:59:45")); // 19:59:45: saved for 20:00, no check in between
			await app.habits.create(quantity());
			tickAt(at("2026-10-14", "18:00:05"));
			expect(shown.map((x) => x.message)).toEqual(["Time for Read · 0 of 30 min"]);
		});

		it("a time first seen after its minute is armed, not fired", async () => {
			const { app, shown, host, tickAt, tickMinutes } = await setup();
			host.attach(r(app));
			tickAt(at("2026-10-14", "18:06:00"));
			await app.habits.create(quantity());
			tickMinutes(30);
			expect(shown).toHaveLength(0);
		});

		it("DST end 2026-10-25: 02:30 Europe/Berlin fires once across the repeated hour", async () => {
			const { app, shown, host, tickAt, tickMinutes } = await setup(at("2026-10-24", "10:00:00"));
			await app.habits.create(quantity({ reminder: { time: "02:30" } }));
			host.attach(r(app));
			tickAt(at("2026-10-24", "23:00:00")); // 01:00 CEST on the 25th
			tickMinutes(89); // 00:29Z = 02:29 CEST
			expect(shown).toHaveLength(0);
			tickMinutes(1); // 00:30Z = 02:30 CEST
			expect(shown).toHaveLength(1);
			tickMinutes(150); // through the repeated hour (02:30 CET is 01:30Z) and on to 03:00Z
			expect(shown).toHaveLength(1);
		});

		it("DST start 2026-03-29: 02:30 Europe/Berlin, a time that does not exist, fires at 03:00", async () => {
			const { app, shown, host, tickAt, tickMinutes } = await setup(at("2026-03-28", "10:00:00"));
			await app.habits.create(quantity({ reminder: { time: "02:30" } }));
			host.attach(r(app));
			tickAt(at("2026-03-28", "23:00:00")); // 00:00 CET on the 29th
			tickMinutes(119); // 00:59Z = 01:59 CET
			expect(shown).toHaveLength(0);
			tickMinutes(1); // 01:00Z = 03:00 CEST
			expect(shown).toHaveLength(1);
			tickMinutes(120);
			expect(shown).toHaveLength(1);
		});
	});

	describe("gesture", () => {
		it("asks for the notification permission once per host lifetime", async () => {
			const { ui, host } = await setup();
			host.gesture();
			host.gesture();
			expect(ui.requestNotifyPermission).toHaveBeenCalledTimes(1);
		});
	});

	describe("SystemNotifier click", () => {
		it("passes a click handler to the notification only when one is given", () => {
			const api = { permission: "granted", requestPermission: vi.fn(), create: vi.fn() };
			const notifier = new SystemNotifier(() => ({ api, hasFocus: () => false }));
			const onClick = vi.fn();
			notifier.notify("Time for Read", "0 of 30 min", onClick);
			expect(api.create).toHaveBeenLastCalledWith("Time for Read", "0 of 30 min", onClick);
			notifier.notify("a", "b");
			expect(api.create).toHaveBeenLastCalledWith("a", "b");
		});
	});

	describe("plugin wiring", () => {
		interface Cmd {
			id: string;
			name: string;
			hotkeys?: unknown;
			callback?: () => void;
		}

		async function load() {
			const commands: Cmd[] = [];
			vi.spyOn(Plugin.prototype, "addCommand").mockImplementation(((c: Cmd) => void commands.push(c)) as never);
			const intervals: number[] = [];
			const setInterval = vi.spyOn(window, "setInterval");
			const fake = fakeApp();
			fake.files.set("A.cpbase", emptyDbText("db-a", "r-aaaaaaaaaaaa"));
			fake.files.set("B.cpbase", emptyDbText("db-b", "r-bbbbbbbbbbbb"));
			const plugin = await loadPlugin(fake, "A.cpbase");
			for (const call of setInterval.mock.calls) intervals.push(call[1] ?? 0);
			return { fake, plugin, commands, intervals };
		}

		it("registers open-habits next to the other open commands, with no hotkey and no plugin name", async () => {
			const { commands, plugin } = await load();
			const ids = commands.map((c) => c.id);
			const cmd = commands.find((c) => c.id === "open-habits")!;
			expect(cmd.name).toBe("Open habits");
			expect(cmd.hotkeys).toBeUndefined();
			expect(cmd.name.toLowerCase()).not.toContain("logwell");
			expect(ids.indexOf("open-habits")).toBe(ids.indexOf("open-calendar") + 1);
			const open = vi.spyOn(plugin, "openApp").mockResolvedValue(null);
			cmd.callback!();
			expect(open).toHaveBeenCalledWith("habits");
		});

		it("runs a 30 s reminder interval and exposes the host", async () => {
			const { plugin, intervals } = await load();
			expect(intervals).toContain(30_000);
			expect(typeof plugin.reminderHost.tick).toBe("function");
			expect(typeof plugin.reminderHost.check).toBe("function");
		});

		it("attaches the host to the open database, re-attaches on a switch, and detaches on unload", async () => {
			const { plugin, fake } = await load();
			const host = plugin.reminderHost;
			const attach = vi.spyOn(host, "attach");
			const detach = vi.spyOn(host, "detach");
			await plugin.session!.app.habits.create(quantity({ reminder: { time: "00:00" } }));
			host.check();
			expect(parseReminderState(fake.app.loadLocalStorage("logwell-habit-reminders-db-a"))).not.toBeNull();

			await plugin.setActiveDatabase("B.cpbase");
			expect(detach).toHaveBeenCalled();
			// The slice carries the session's own port and reads the dbId live.
			const slice = attach.mock.lastCall![0];
			expect(slice.dbId()).toBe("db-b");
			expect(slice.reminders).toBe(plugin.session!.app.reminders);
			expect(slice.habits).toBe(plugin.session!.app.habits);
			expect(slice.store).toBe(plugin.session!.app.store);

			const before = detach.mock.calls.length;
			plugin.onunload();
			expect(detach.mock.calls.length).toBeGreaterThan(before);
		});

		it("the session keeps the reminder state in local storage", async () => {
			const { plugin, fake } = await load();
			const app = plugin.session!.app;
			app.reminders.save("db-a", { v: 1, date: "2026-10-14", fired: {}, snoozedUntil: {}, times: {} });
			expect(fake.app.loadLocalStorage("logwell-habit-reminders-db-a")).not.toBeNull();
		});

		it("reminderGesture asks once through the plugin's host", async () => {
			const { plugin } = await load();
			const gesture = vi.spyOn(plugin.reminderHost, "gesture");
			plugin.reminderGesture();
			expect(gesture).toHaveBeenCalledTimes(1);
		});
	});
});

describe("reminder state in local storage", () => {
	// The habit reminder state in the vault's local storage, per database (modeled on activeTimer).

	const state = () => ({ ...emptyReminderState("2026-10-14"), fired: { "h-1": true as const }, times: { "h-1": "20:00" } });

	afterEach(() => vi.restoreAllMocks());

	describe("LocalStorageReminderState", () => {
		it("stores the state under logwell-habit-reminders-<dbId> with v 1 and reads it back", () => {
			const f = fakeLocal();
			const port = new LocalStorageReminderState(f.app);
			port.save("db-1", state());
			expect([...f.store.keys()]).toEqual(["logwell-habit-reminders-db-1"]);
			const back = port.load("db-1");
			expect((back as { v: number }).v).toBe(1);
			expect(parseReminderState(back)).toEqual(state());
		});

		it("is per database", () => {
			const f = fakeLocal();
			const port = new LocalStorageReminderState(f.app);
			port.save("db-1", state());
			expect(port.load("db-2")).toBeNull();
		});

		it("null clears the entry", () => {
			const f = fakeLocal();
			const port = new LocalStorageReminderState(f.app);
			port.save("db-1", state());
			port.save("db-1", null);
			expect(f.store.size).toBe(0);
			expect(port.load("db-1")).toBeNull();
		});

		it("reads a value stored as JSON text", () => {
			const f = fakeLocal();
			f.store.set("logwell-habit-reminders-db-1", JSON.stringify(state()));
			const port = new LocalStorageReminderState(f.app);
			expect(parseReminderState(port.load("db-1"))).toEqual(state());
		});

		it("ignores bad JSON with a warning and never deletes it", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const f = fakeLocal();
			f.store.set("logwell-habit-reminders-db-1", "{not json");
			const port = new LocalStorageReminderState(f.app);
			expect(port.load("db-1")).toBeNull();
			expect(warn).toHaveBeenCalled();
			expect(f.store.get("logwell-habit-reminders-db-1")).toBe("{not json");
		});

		it("ignores another version (a newer build may own it) and never deletes it", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const f = fakeLocal();
			const newer = { v: 2, whatever: true };
			f.store.set("logwell-habit-reminders-db-1", newer);
			const port = new LocalStorageReminderState(f.app);
			expect(port.load("db-1")).toBeNull();
			expect(warn).toHaveBeenCalled();
			expect(f.store.get("logwell-habit-reminders-db-1")).toBe(newer);
		});

		it("a storage that cannot be read is reported with a warning; a failing save throws for the host to log once", () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const app = {
				loadLocalStorage: () => {
					throw new Error("blocked");
				},
				saveLocalStorage: () => {
					throw new Error("full");
				},
			};
			const port = new LocalStorageReminderState(app);
			expect(port.load("db-1")).toBeNull();
			expect(warn).toHaveBeenCalledTimes(1);
			expect(() => port.save("db-1", state())).toThrow("full");
			expect(warn).toHaveBeenCalledTimes(1);
		});
	});
});
