import { describe, expect, it } from "vitest";
import { CheckpointApp } from "../../src/app/App";
import {
	ARCHIVE_LABEL,
	CHECKIN_LABEL,
	DELETE_CHECKIN_LABEL,
	DELETE_HABIT_LABEL,
	EDIT_CHECKIN_LABEL,
	EDIT_HABIT_LABEL,
	NEW_HABIT_LABEL,
	RESTORE_LABEL,
	UNCHECK_LABEL,
	type WriteResult,
} from "../../src/app/HabitService";
import type { SettingsPort } from "../../src/app/ports";
import type { Tx } from "../../src/app/tx";
import { globalSearch } from "../../src/app/views";
import { isDomainError } from "../../src/domain/errors";
import { checkReminders, emptyReminderState } from "../../src/domain/habitReminders";
import { type HabitIndex, type HabitInput, indexCheckins, progressOn, streaks } from "../../src/domain/habits";
import { emptyFilter } from "../../src/domain/queries";
import type { Checkin, WeekStart } from "../../src/domain/types";
import { harness } from "../persistence/fixtures";
import { sequentialIds } from "../helpers";
import { FakeNotes, makeReadOnly } from "./harness";

// HabitService.
// Europe/Berlin; 2026-10-14 is a Wednesday.

async function setup(iso = "2026-10-14T10:00:00.000Z") {
	const h = harness();
	await h.store.open();
	h.clock.set(iso);
	const prefs = { weekStart: "MO" as WeekStart };
	const settings: SettingsPort = {
		zone: () => "Europe/Berlin",
		noteFolder: () => "Task notes",
		upcomingDays: () => 14,
		weekStart: () => prefs.weekStart,
		eveningTime: () => "20:00",
	};
	const app = new CheckpointApp(h.store, h.clock, sequentialIds("h"), settings, new FakeNotes());
	/** The write's label is the store's undo label. */
	const labelled = async (p: Promise<WriteResult>, label: string, wrote = true) => {
		const r = await p;
		expect(r).toEqual({ wrote, label });
		if (wrote) expect(app.store.undoLabel).toBe(label);
		return r;
	};
	return { h, app, prefs, labelled };
}

const input = (patch: Partial<HabitInput> = {}): HabitInput => ({
	name: "Read",
	icon: "book",
	color: "purple",
	timeOfDay: "evening",
	reminder: null,
	goal: { type: "quantity", target: 30, unit: "min", period: "day" },
	schedule: { kind: "daily" },
	...patch,
});
const binary = (patch: Partial<HabitInput> = {}) => input({ name: "Meditate", goal: { type: "binary", target: 1, unit: null, period: "day" }, ...patch });
const count = (patch: Partial<HabitInput> = {}) => input({ name: "Water", goal: { type: "count", target: 8, unit: "glasses", period: "day" }, ...patch });

async function refused(p: Promise<unknown>, code: "InvalidValue" | "NotFound" | "ReadOnly" = "InvalidValue"): Promise<void> {
	const err = await p.then(
		() => null,
		(e: unknown) => e,
	);
	expect(isDomainError(err, code), String(err)).toBe(true);
}

const active = (app: CheckpointApp, habitId: string): Checkin[] => app.habits.index().active(habitId);

describe("habit lifecycle (D9)", () => {
	it("creates a habit with the first version from today and the week start setting", async () => {
		const { app, prefs } = await setup();
		prefs.weekStart = "SU";
		const a = await app.habits.create(input({ name: "  Read  " }));
		expect(app.store.undoLabel).toBe(NEW_HABIT_LABEL);
		expect(a).toMatchObject({ name: "Read", icon: "book", color: "purple", timeOfDay: "evening", reminder: null, archivedAt: null });
		expect(a.versions).toEqual([{ effectiveFrom: "2026-10-14", goal: { type: "quantity", target: 30, unit: "min", period: "day" }, schedule: { kind: "daily" }, weekStart: "SU" }]);
		expect(a.createdAt).toBe("2026-10-14T10:00:00.000Z");
		const b = await app.habits.create(binary());
		expect(b.sortKey > a.sortKey).toBe(true);
		expect(app.store.state.habits.size).toBe(2);
	});

	it("normalizes: binary day goals are 1 with no unit, weekdays in week order, an empty count unit is none", async () => {
		const { app } = await setup();
		const m = await app.habits.create(
			binary({ goal: { type: "binary", target: 4, unit: "x", period: "day" }, schedule: { kind: "weekdays", days: ["FR", "MO", "FR"] } }),
		);
		expect(m.versions[0]).toMatchObject({ goal: { type: "binary", target: 1, unit: null, period: "day" }, schedule: { kind: "weekdays", days: ["MO", "FR"] } });
		const w = await app.habits.create(count({ goal: { type: "count", target: 8, unit: " ", period: "day" } }));
		expect(w.versions[0]!.goal.unit).toBeNull();
	});

	it("refuses invalid input with the dialog's message and writes nothing", async () => {
		const { app } = await setup();
		const err = await app.habits.create(input({ name: " " })).catch((e: unknown) => e);
		expect(isDomainError(err, "InvalidValue") && err.message).toBe("Enter a name.");
		await refused(app.habits.create(input({ color: "teal" as never })));
		await refused(app.habits.create(input({ timeOfDay: "noon" as never })));
		await refused(app.habits.create(input({ icon: "Not an icon!" })));
		expect(app.store.state.habits.size).toBe(0);
		expect(app.store.undoLabel).toBeNull();
	});

	it("an edit of name, icon, color, time of day or reminder adds no version; an unchanged edit writes nothing", async () => {
		const { app, labelled } = await setup();
		const a = await app.habits.create(input());
		await labelled(app.habits.update(a.id, input({ name: "Read books", icon: "library", color: "blue", timeOfDay: "morning", reminder: { time: "07:30" } })), EDIT_HABIT_LABEL);
		const b = app.store.state.habits.get(a.id)!;
		expect(b).toMatchObject({ name: "Read books", icon: "library", color: "blue", timeOfDay: "morning", reminder: { time: "07:30" } });
		expect(b.versions).toBe(a.versions);
		await labelled(app.habits.update(a.id, input({ name: "Read books", icon: "library", color: "blue", timeOfDay: "morning", reminder: { time: "07:30" } })), EDIT_HABIT_LABEL, false);
		await refused(app.habits.update("nope", input()), "NotFound");
	});

	it("archive and restore (HAB-10); an archived habit's reminder is skipped", async () => {
		const { app, labelled } = await setup("2026-10-14T19:00:00.000Z");
		const a = await app.habits.create(input({ reminder: { time: "20:00" } }));
		const now = { date: "2026-10-14", time: "21:00", instant: "2026-10-14T19:00:00.000Z" };
		const seen = { ...emptyReminderState("2026-10-14"), times: { [a.id]: "20:00" } };
		expect(checkReminders(app.store.state.habits.values(), app.habits.index(), seen, now).due).toHaveLength(1);
		await labelled(app.habits.archive(a.id), ARCHIVE_LABEL);
		expect(app.store.state.habits.get(a.id)?.archivedAt).toBe("2026-10-14T19:00:00.000Z");
		expect(checkReminders(app.store.state.habits.values(), app.habits.index(), seen, now).due).toEqual([]);
		await labelled(app.habits.archive(a.id), ARCHIVE_LABEL, false);
		await labelled(app.habits.restore(a.id), RESTORE_LABEL);
		expect(app.store.state.habits.get(a.id)?.archivedAt).toBeNull();
		await labelled(app.habits.restore(a.id), RESTORE_LABEL, false);
	});

	it("delete removes the habit and all its check-ins in one undo entry; Undo restores both", async () => {
		const { app, labelled } = await setup();
		const a = await app.habits.create(count());
		const other = await app.habits.create(binary());
		await app.habits.add(a.id, "2026-10-14", 1);
		await app.habits.add(a.id, "2026-10-14", 1);
		await app.habits.deleteCheckin(active(app, a.id)[0]!.id);
		await app.habits.toggle(other.id, "2026-10-14");
		const before = app.store.state;
		await labelled(app.habits.delete(a.id), DELETE_HABIT_LABEL);
		expect(app.store.state.habits.has(a.id)).toBe(false);
		expect([...app.store.state.checkins.values()].map((c) => c.habitId)).toEqual([other.id]);
		await app.store.undo();
		expect(app.store.state.habits.get(a.id)).toBe(before.habits.get(a.id));
		expect([...app.store.state.checkins.values()].sort((x, y) => (x.id < y.id ? -1 : 1))).toEqual(
			[...before.checkins.values()].sort((x, y) => (x.id < y.id ? -1 : 1)),
		);
		await refused(app.habits.delete("nope"), "NotFound");
	});
});

describe("J5 and AS-11 at service level (HAB-05, HAB-09)", () => {
	it("quantity target 30: 20 + 10 meets it, a correction to 5 does not; a target change tomorrow leaves yesterday at 30", async () => {
		const { h, app, labelled } = await setup();
		const read = await app.habits.create(input());
		await labelled(app.habits.add(read.id, "2026-10-14", 20), CHECKIN_LABEL);
		await labelled(app.habits.add(read.id, "2026-10-14", 10), CHECKIN_LABEL);
		const at = (date: string) => progressOn(app.store.state.habits.get(read.id)!, app.habits.index(), date)!;
		expect(at("2026-10-14")).toMatchObject({ value: 30, target: 30, met: true });
		expect(streaks(app.store.state.habits.get(read.id)!, app.habits.index(), "2026-10-14").current).toBe(1);
		const ten = active(app, read.id).find((c) => c.value === 10)!;
		await labelled(app.habits.editCheckin(ten.id, { value: 5 }), EDIT_CHECKIN_LABEL);
		expect(at("2026-10-14")).toMatchObject({ value: 25, met: false });

		h.clock.advance(86_400_000);
		expect(app.habits.today()).toBe("2026-10-15");
		await labelled(app.habits.update(read.id, input({ goal: { type: "quantity", target: 20, unit: "min", period: "day" } })), EDIT_HABIT_LABEL);
		expect(at("2026-10-14")).toMatchObject({ value: 25, target: 30, met: false });
		expect(at("2026-10-15")).toMatchObject({ value: 0, target: 20, met: false });
		const versions = () => app.store.state.habits.get(read.id)!.versions.map((v) => [v.effectiveFrom, v.goal.target]);
		expect(versions()).toEqual([
			["2026-10-14", 30],
			["2026-10-15", 20],
		]);
		// A second edit the same day replaces the day's version.
		await labelled(app.habits.update(read.id, input({ goal: { type: "quantity", target: 25, unit: "min", period: "day" } })), EDIT_HABIT_LABEL);
		expect(versions()).toEqual([
			["2026-10-14", 30],
			["2026-10-15", 25],
		]);
	});

	it("a schedule change adds a version from today; a week period from the start of the week by the current setting", async () => {
		const { h, app, prefs } = await setup("2026-10-05T10:00:00.000Z");
		const gym = await app.habits.create(count({ name: "Gym" }));
		h.clock.set("2026-10-14T10:00:00.000Z");
		prefs.weekStart = "SU";
		await app.habits.update(gym.id, count({ name: "Gym", goal: { type: "count", target: 3, unit: null, period: "week" }, schedule: { kind: "weekly" } }));
		expect(app.store.state.habits.get(gym.id)!.versions.map((v) => [v.effectiveFrom, v.weekStart])).toEqual([
			["2026-10-05", "MO"],
			["2026-10-11", "SU"],
		]);
	});
});

describe("check-ins (D8, HAB-06, HAB-07)", () => {
	it("HAB-06: toggle on, on again writes nothing, off soft-deletes, Undo restores the exact record", async () => {
		const { app, labelled } = await setup();
		const m = await app.habits.create(binary());
		await labelled(app.habits.toggle(m.id, "2026-10-14"), CHECKIN_LABEL);
		const on = active(app, m.id)[0]!;
		expect(on).toMatchObject({ habitId: m.id, date: "2026-10-14", value: 1, note: null, deletedAt: null });
		const state = app.store.state;
		await labelled(app.habits.toggle(m.id, "2026-10-14", true), CHECKIN_LABEL, false);
		expect(app.store.state).toBe(state);
		const mark = app.store.undoMark();
		await labelled(app.habits.toggle(m.id, "2026-10-14"), UNCHECK_LABEL);
		expect(app.store.state.checkins.get(on.id)).toMatchObject({ deletedAt: "2026-10-14T10:00:00.000Z", modifiedAt: "2026-10-14T10:00:00.000Z" });
		expect(active(app, m.id)).toEqual([]);
		await labelled(app.habits.toggle(m.id, "2026-10-14", false), UNCHECK_LABEL, false);
		expect(await app.store.undoFor(mark, UNCHECK_LABEL)()).toBe(true);
		expect(app.store.state.checkins.get(on.id)).toBe(on);
	});

	it("HAB-06: two active binary check-ins on one date (from an import) count as one, and toggling off removes both", async () => {
		const { app, h } = await setup();
		const m = await app.habits.create(binary());
		const twin = (id: string): Checkin => ({ id, habitId: m.id, date: "2026-10-14", value: 1, note: null, createdAt: "2026-10-14T08:00:00.000Z", modifiedAt: "2026-10-14T08:00:00.000Z", deletedAt: null });
		const checkins = new Map(app.store.state.checkins);
		checkins.set("t-1", twin("t-1"));
		checkins.set("t-2", twin("t-2"));
		h.store.commit({ ...h.store.data, checkins }, [
			{ c: "checkins", id: "t-1", v: twin("t-1") },
			{ c: "checkins", id: "t-2", v: twin("t-2") },
		]);
		expect(progressOn(app.store.state.habits.get(m.id)!, app.habits.index(), "2026-10-14")).toMatchObject({ value: 1, met: true });
		await app.habits.toggle(m.id, "2026-10-14");
		expect(active(app, m.id)).toEqual([]);
		expect(app.store.undoLabel).toBe(UNCHECK_LABEL);
	});

	it("a flip is decided in the queue: two quick toggles turn on, then off", async () => {
		const { app } = await setup();
		const m = await app.habits.create(binary());
		const [a, b] = await Promise.all([app.habits.toggle(m.id, "2026-10-14"), app.habits.toggle(m.id, "2026-10-14")]);
		expect(a).toEqual({ wrote: true, label: CHECKIN_LABEL });
		expect(b).toEqual({ wrote: true, label: UNCHECK_LABEL });
		expect(active(app, m.id)).toEqual([]);
		expect(app.store.undoLabel).toBe(UNCHECK_LABEL);
	});

	it("count +1 and amount Add each write a check-in; a past date is a backfill created now (D19)", async () => {
		const { app, labelled } = await setup();
		const w = await app.habits.create(count());
		await labelled(app.habits.add(w.id, "2026-10-14", 1), CHECKIN_LABEL);
		await labelled(app.habits.add(w.id, "2026-10-14", 1), CHECKIN_LABEL);
		expect(active(app, w.id)).toHaveLength(2);
		const r = await app.habits.create(input());
		await app.habits.add(r.id, "2026-10-14", 12.345678);
		expect(active(app, r.id)[0]!.value).toBe(12.345678);
		// Backfill: a habit created earlier gets a check-in for a past day.
		const { app: app2, h: h2 } = await setup("2026-10-01T10:00:00.000Z");
		const old = await app2.habits.create(input());
		h2.clock.set("2026-10-14T10:00:00.000Z");
		await app2.habits.add(old.id, "2026-10-02", 20);
		expect(active(app2, old.id)[0]).toMatchObject({ date: "2026-10-02", createdAt: "2026-10-14T10:00:00.000Z" });
	});

	it("edits a value and a note in place, keeps a binary value at 1, and soft-deletes", async () => {
		const { app, labelled } = await setup();
		const r = await app.habits.create(input());
		await app.habits.add(r.id, "2026-10-14", 20);
		const c = active(app, r.id)[0]!;
		await labelled(app.habits.editCheckin(c.id, { value: 25, note: " on the train " }), EDIT_CHECKIN_LABEL);
		expect(app.store.state.checkins.get(c.id)).toMatchObject({ value: 25, note: "on the train", date: "2026-10-14", createdAt: c.createdAt });
		await labelled(app.habits.editCheckin(c.id, { note: "" }), EDIT_CHECKIN_LABEL);
		expect(app.store.state.checkins.get(c.id)?.note).toBeNull();
		await labelled(app.habits.editCheckin(c.id, { value: 25 }), EDIT_CHECKIN_LABEL, false);
		await labelled(app.habits.deleteCheckin(c.id), DELETE_CHECKIN_LABEL);
		expect(app.store.state.checkins.get(c.id)?.deletedAt).toBe("2026-10-14T10:00:00.000Z");
		await labelled(app.habits.deleteCheckin(c.id), DELETE_CHECKIN_LABEL, false);
		await refused(app.habits.editCheckin(c.id, { value: 3 }), "NotFound");
		await refused(app.habits.deleteCheckin("nope"), "NotFound");

		const m = await app.habits.create(binary());
		await app.habits.toggle(m.id, "2026-10-14");
		const b = active(app, m.id)[0]!;
		await refused(app.habits.editCheckin(b.id, { value: 2 }));
		await labelled(app.habits.editCheckin(b.id, { value: 1, note: "calm" }), EDIT_CHECKIN_LABEL);
	});

	it("refuses bad writes and writes nothing (D8)", async () => {
		const { app } = await setup();
		const r = await app.habits.create(input());
		const w = await app.habits.create(count());
		const m = await app.habits.create(binary());
		await app.habits.add(r.id, "2026-10-14", 5);
		const c = active(app, r.id)[0]!;
		const state = app.store.state;
		const label = app.store.undoLabel;
		for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.0000001, 1_000_001]) {
			await refused(app.habits.add(r.id, "2026-10-14", value));
			await refused(app.habits.editCheckin(c.id, { value }));
		}
		await refused(app.habits.add(w.id, "2026-10-14", 1.5)); // count is whole
		await refused(app.habits.add(r.id, "2026-10-15", 5)); // future
		await refused(app.habits.add(r.id, "2026-10-13", 5)); // before the first version
		await refused(app.habits.toggle(m.id, "2026-10-15"));
		await refused(app.habits.toggle(m.id, "2026-10-13"));
		await refused(app.habits.toggle(r.id, "2026-10-14")); // toggle on a non-binary habit
		await refused(app.habits.add(m.id, "2026-10-14", 1)); // add on a binary habit
		await refused(app.habits.add("nope", "2026-10-14", 1), "NotFound");
		await refused(app.habits.toggle("nope", "2026-10-14"), "NotFound");
		expect(app.store.state).toBe(state);
		expect(app.store.undoLabel).toBe(label);
	});

	it("refuses check-in writes on an archived habit", async () => {
		const { app } = await setup();
		const r = await app.habits.create(input());
		const m = await app.habits.create(binary());
		await app.habits.add(r.id, "2026-10-14", 5);
		const c = active(app, r.id)[0]!;
		await app.habits.archive(r.id);
		await app.habits.archive(m.id);
		const state = app.store.state;
		await refused(app.habits.add(r.id, "2026-10-14", 5));
		await refused(app.habits.toggle(m.id, "2026-10-14"));
		await refused(app.habits.editCheckin(c.id, { value: 6 }));
		await refused(app.habits.deleteCheckin(c.id));
		expect(app.store.state).toBe(state);
	});

	it("a read-only database refuses the write", async () => {
		const { app, h } = await setup();
		const r = await app.habits.create(input());
		await h.saveNow();
		await makeReadOnly(h);
		await refused(app.habits.add(r.id, "2026-10-14", 5), "ReadOnly");
	});

	it("today follows the display zone across the DST change (2026-10-25, Europe/Berlin)", async () => {
		const { h, app } = await setup("2026-10-24T22:30:00.000Z");
		expect(app.habits.today()).toBe("2026-10-25"); // 00:30 CEST
		const r = await app.habits.create(input());
		await app.habits.add(r.id, app.habits.today(), 30);
		h.clock.set("2026-10-25T22:30:00.000Z"); // 23:30 CET, the same day
		expect(app.habits.today()).toBe("2026-10-25");
		expect(progressOn(app.store.state.habits.get(r.id)!, app.habits.index(), "2026-10-25")?.met).toBe(true);
	});
});

describe("check-in dates, kept reminders and zero values", () => {
	it("refuses a date that is not a real day and writes nothing", async () => {
		const { app } = await setup();
		const r = await app.habits.create(input());
		const m = await app.habits.create(binary());
		const state = app.store.state;
		for (const date of ["2026-10-00", "2026-02-30", "14.10.2026", ""]) {
			const err = await app.habits.add(r.id, date, 20).catch((e: unknown) => e);
			expect(isDomainError(err, "InvalidValue") && err.message).toBe("That date is not valid.");
			await refused(app.habits.toggle(m.id, date));
			await refused(app.habits.toggle(m.id, date, true));
		}
		expect(app.store.state).toBe(state);
	});

	it("an edit that keeps the reminder time keeps the stored reminder object (a newer build's fields)", async () => {
		const { app, h } = await setup();
		const a = await app.habits.create(input({ reminder: { time: "20:00" } }));
		const newer = { ...a, reminder: { time: "20:00", sound: "chime" } as never };
		h.store.commit({ ...h.store.data, habits: new Map([[a.id, newer]]) }, [{ c: "habits", id: a.id, v: newer }]);
		await app.habits.update(a.id, input({ name: "Read more", reminder: { time: "20:00" } }));
		const b = app.store.state.habits.get(a.id)!;
		expect(b.name).toBe("Read more");
		expect(b.reminder).toBe(newer.reminder);
		await app.habits.update(a.id, input({ name: "Read more", reminder: { time: "21:00" } }));
		expect(app.store.state.habits.get(a.id)!.reminder).toEqual({ time: "21:00" });
	});

	it("a value-0 check-in is not 'on'; toggling on adds one, toggling off removes both", async () => {
		const { app, h } = await setup();
		const m = await app.habits.create(binary());
		const zero: Checkin = { id: "z-1", habitId: m.id, date: "2026-10-14", value: 0, note: null, createdAt: "2026-10-14T08:00:00.000Z", modifiedAt: "2026-10-14T08:00:00.000Z", deletedAt: null };
		h.store.commit({ ...h.store.data, checkins: new Map([["z-1", zero]]) }, [{ c: "checkins", id: "z-1", v: zero }]);
		expect(app.habits.checkinCount(m.id)).toBe(0);
		await app.habits.toggle(m.id, "2026-10-14");
		expect(app.store.undoLabel).toBe(CHECKIN_LABEL);
		expect(active(app, m.id)).toHaveLength(1);
		await app.habits.toggle(m.id, "2026-10-14");
		expect(app.store.undoLabel).toBe(UNCHECK_LABEL);
		expect([...app.store.state.checkins.values()].filter((c) => c.deletedAt === null)).toEqual([]);
		expect(app.store.state.checkins.get("z-1")?.deletedAt).toBe("2026-10-14T10:00:00.000Z");
	});

	it("delete removes zero-value and deleted check-ins of the habit, and no other habit's", async () => {
		const { app, h } = await setup();
		const w = await app.habits.create(count());
		const other = await app.habits.create(count({ name: "Other" }));
		await app.habits.add(w.id, "2026-10-14", 1);
		await app.habits.add(other.id, "2026-10-14", 1);
		const zero: Checkin = { id: "z-1", habitId: w.id, date: "2026-10-14", value: 0, note: null, createdAt: "2026-10-14T08:00:00.000Z", modifiedAt: "2026-10-14T08:00:00.000Z", deletedAt: null };
		const checkins = new Map(app.store.state.checkins);
		checkins.set("z-1", zero);
		h.store.commit({ ...h.store.data, checkins }, [{ c: "checkins", id: "z-1", v: zero }]);
		await app.habits.delete(w.id);
		expect([...app.store.state.checkins.values()].map((c) => c.habitId)).toEqual([other.id]);
	});
});

describe("index cache (D18) and search (D13)", () => {
	it("index() is the same object while the checkins map is unchanged", async () => {
		const { app } = await setup();
		const r = await app.habits.create(input());
		const first = app.habits.index();
		expect(app.habits.index()).toBe(first);
		await app.habits.update(r.id, input({ name: "Read more" }));
		expect(app.habits.index()).toBe(first);
		await app.habits.add(r.id, "2026-10-14", 5);
		expect(app.habits.index()).not.toBe(first);
	});

	it("the index built inside toggle is the one of the committed state before the write", async () => {
		const { app } = await setup();
		const med = await app.habits.create(binary());
		const before = app.store.state.checkins;
		const fresh = indexCheckins(before);
		await app.habits.toggle(med.id, "2026-10-14", true);
		const indexes = (app.habits as unknown as { indexes: WeakMap<object, HabitIndex> }).indexes;
		const inside = indexes.get(before);
		expect(inside).toBeDefined();
		expect(inside!.byDate(med.id).has("2026-10-14")).toBe(false);
		expect([...inside!.records(med.id)]).toEqual([...fresh.records(med.id)]);
		// The committed map is a new object, indexed fresh on first use.
		expect(app.store.state.checkins).not.toBe(before);
		expect(app.habits.index().active(med.id)).toHaveLength(1);
		await app.habits.toggle(med.id, "2026-10-14", false);
		expect(app.habits.index().active(med.id)).toHaveLength(0);
	});

	it("an index taken after a check-in write in the same transaction is never cached", async () => {
		const { app } = await setup();
		const med = await app.habits.create(binary());
		const service = app.habits as unknown as { txIndex(tx: Tx): HabitIndex; newCheckin(tx: Tx, id: string, date: string, value: number): Checkin };
		await app.store.run("Check in", (tx) => {
			tx.put("checkins", service.newCheckin(tx, med.id, "2026-10-13", 1));
			const mid = service.txIndex(tx);
			expect(mid.byDate(med.id).has("2026-10-13")).toBe(true);
			tx.put("checkins", service.newCheckin(tx, med.id, "2026-10-14", 1));
			return true;
		});
		// The writable map became the committed state: its index must show both check-ins, not the one cached mid-write.
		const index = app.habits.index();
		expect([...index.byDate(med.id).keys()].sort()).toEqual(["2026-10-13", "2026-10-14"]);
	});

	it("globalSearch returns habits by case-insensitive name, archived included", async () => {
		const { app } = await setup();
		const r = await app.habits.create(input({ name: "Read books" }));
		const m = await app.habits.create(binary({ name: "Bedtime reading" }));
		await app.habits.create(count({ name: "Water" }));
		await app.habits.archive(m.id);
		const res = globalSearch(app.store.state, "READ", app.queryContext(), emptyFilter());
		expect(res.habits.map((x) => x.id)).toEqual([r.id, m.id]);
		expect(globalSearch(app.store.state, "  ", app.queryContext(), emptyFilter()).habits).toEqual([]);
	});
});
