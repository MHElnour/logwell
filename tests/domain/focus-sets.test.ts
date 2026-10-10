import { describe, expect, it } from "vitest";
import {
	type ActiveTimer,
	type FocusEffect,
	type FocusSetConfig,
	type Step,
	finish,
	focusHistoryTree,
	isFinishedEarly,
	parseActiveTimer,
	skip,
	split,
	startSet,
	stop,
	tick,
} from "../../src/domain/focus";
import type { FocusSession } from "../../src/domain/types";
import { sequentialIds } from "../helpers";

// The set id, Finish and the history tree's grouping.

const T0 = Date.parse("2026-10-01T10:00:00.000Z");
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString();
const DEV = "d-test";
const cfg = (rounds: number): FocusSetConfig => ({ rounds, focusSec: 1500, breakSec: 300, longBreakSec: 900 });

class Run {
	timer: ActiveTimer | null;
	effects: FocusEffect[] = [];
	readonly ids = sequentialIds("f");
	sec = 0;
	constructor(config: FocusSetConfig) {
		const step = startSet(config, { id: "task-a", title: "Study" }, at(0), this.ids);
		this.timer = step.timer;
		this.effects.push(...step.effects);
	}
	apply(step: Step): Step {
		this.timer = step.timer;
		this.effects.push(...step.effects);
		return step;
	}
	run(to: number, by = 1): void {
		while (this.sec < to && this.timer !== null) {
			this.sec = Math.min(to, this.sec + by);
			this.apply(tick(this.timer, at(this.sec), DEV, this.ids));
		}
		this.sec = to;
	}
	saved(): FocusSession[] {
		return this.effects.flatMap((e) => (e.kind === "save" ? [e.session] : []));
	}
	moments(): string[] {
		return this.effects.flatMap((e) => (e.kind === "moment" ? [e.moment] : []));
	}
}

describe("set id (P3)", () => {
	it("every round of a set carries the same setId and rounds, a new set gets a new one", () => {
		const r = new Run(cfg(3));
		const id = r.timer!.setId;
		expect(id).toBeTruthy();
		expect(id).not.toBe(r.timer!.sessionId);
		r.run(3 * 1500 + 2 * 300 + 5);
		expect(r.timer).toBeNull();
		const saved = r.saved();
		expect(saved).toHaveLength(3);
		for (const s of saved) expect(s).toMatchObject({ setId: id, setRounds: 3 });
		expect(saved.map((s) => s.setRound)).toEqual([1, 2, 3]);
		expect(startSet(cfg(3), null, at(0), r.ids).timer!.setId).not.toBe(id);
	});

	it("Split keeps the set id on both parts and Stop and Skip stamp it too", () => {
		const r = new Run(cfg(2));
		const id = r.timer!.setId;
		r.run(100);
		const sp = r.apply(split(r.timer!, null, at(100), DEV, r.ids));
		expect(sp.timer!.setId).toBe(id);
		expect(r.saved()[0]).toMatchObject({ status: "split", setId: id, setRound: 1 });
		r.run(160);
		r.apply(skip(r.timer!, at(160), DEV, r.ids));
		expect(r.saved()[1]).toMatchObject({ status: "stopped", setId: id, splitFrom: r.saved()[0]!.id, setRound: 1 });
		expect(r.timer!.setId).toBe(id);
		const r2 = new Run(cfg(1));
		const id2 = r2.timer!.setId;
		r2.run(70);
		expect(r2.apply(stop(r2.timer!, at(70), DEV)).effects[0]).toMatchObject({ session: { setId: id2, setRounds: 1 } });
	});

	it("a stored timer from 0.2.0 without a set id still loads and gets one", () => {
		const r = new Run(cfg(2));
		const raw = JSON.parse(JSON.stringify(r.timer)) as Record<string, unknown>;
		delete raw.setId;
		const t = parseActiveTimer(raw);
		expect(t).not.toBeNull();
		expect(typeof t!.setId).toBe("string");
		expect(t!.setId.length).toBeGreaterThan(0);
		expect(parseActiveTimer(JSON.parse(JSON.stringify(r.timer)))!.setId).toBe(r.timer!.setId);
	});
});

describe("finish (P5)", () => {
	it("mid-set: saves a completed round with its real seconds and goes to the break like a natural end", () => {
		const r = new Run(cfg(3));
		r.run(600);
		const step = r.apply(finish(r.timer!, at(600), DEV, r.ids));
		expect(step.effects.map((e) => e.kind)).toEqual(["save", "moment"]);
		expect(r.moments()).toEqual(["focus-start", "break-start"]);
		const s = r.saved()[0]!;
		expect(s).toMatchObject({ status: "completed", plannedSec: 1500, endedAt: at(600) });
		expect(isFinishedEarly(s)).toBe(true);
		expect(r.timer).toMatchObject({ phase: "short-break", round: 1, completedFocusCount: 1, setFocusedSec: 600, plannedSec: 300 });
		// The break runs to its end and the next round starts as after a natural end.
		r.run(600 + 300);
		expect(r.timer).toMatchObject({ phase: "focus", round: 2 });
		expect(r.moments()).toEqual(["focus-start", "break-start", "focus-start"]);
	});

	it("the last round: saves, plays set-done and ends the set", () => {
		const r = new Run(cfg(1));
		r.run(900);
		const step = r.apply(finish(r.timer!, at(900), DEV, r.ids));
		expect(r.timer).toBeNull();
		expect(step.effects.map((e) => e.kind)).toEqual(["save", "moment", "set-done"]);
		expect(step.effects[2]).toEqual({ kind: "set-done", rounds: 1, focusedSec: 900 });
		expect(r.moments()).toEqual(["focus-start", "set-done"]);
	});

	it("marks the save as a manual finish so the service can apply the 60 s rule (D7)", () => {
		const r = new Run(cfg(2));
		r.run(30);
		const save = r.apply(finish(r.timer!, at(30), DEV, r.ids)).effects[0]!;
		expect(save).toMatchObject({ kind: "save", manual: true, session: { status: "completed" } });
	});

	it("the last round is marked manual unless the set already has a saved round (clean-up review 2)", () => {
		const one = new Run(cfg(1));
		one.run(30);
		expect(one.apply(finish(one.timer!, at(30), DEV, one.ids)).effects[0]).toMatchObject({ kind: "save", manual: true });
		const two = new Run(cfg(2));
		two.run(1500 + 300 + 30);
		expect(two.timer).toMatchObject({ round: 2, setFocusedSec: 1500 });
		const save = two.apply(finish(two.timer!, at(1500 + 300 + 30), DEV, two.ids)).effects[0]!;
		expect(save).toEqual(expect.objectContaining({ kind: "save" }));
		expect(save).not.toHaveProperty("manual");
	});

	it("works while paused and does nothing in a break or while the recovery prompt waits", () => {
		const r = new Run(cfg(2));
		r.run(10);
		const paused = r.apply({ timer: { ...r.timer!, state: "paused", segments: r.timer!.segments.map((s) => ({ start: s.start, end: s.end ?? at(10) })) }, effects: [] });
		expect(paused.timer!.state).toBe("paused");
		const fin = finish(r.timer!, at(500), DEV, r.ids);
		expect(fin.effects[0]).toMatchObject({ session: { endedAt: at(500) } });
		const inBreak = fin.timer!;
		expect(finish(inBreak, at(520), DEV, r.ids)).toEqual({ timer: inBreak, effects: [] });
		const waiting = { ...r.timer!, needsRecovery: true };
		expect(finish(waiting, at(520), DEV, r.ids)).toEqual({ timer: waiting, effects: [] });
	});
});

describe("finished early is derived (P5)", () => {
	const base = (patch: Partial<FocusSession>): FocusSession => ({
		id: "x",
		deviceId: DEV,
		taskId: null,
		taskTitleSnapshot: "",
		plannedSec: 1500,
		status: "completed",
		segments: [{ start: at(0), end: at(1500) }],
		unobserved: [],
		splitFrom: null,
		startedAt: at(0),
		endedAt: at(1500),
		finalizedAt: at(1500),
		...patch,
	});
	it("only a completed round with less focus than planned", () => {
		expect(isFinishedEarly(base({}))).toBe(false);
		expect(isFinishedEarly(base({ segments: [{ start: at(0), end: at(900) }] }))).toBe(true);
		expect(isFinishedEarly(base({ status: "stopped", segments: [{ start: at(0), end: at(900) }] }))).toBe(false);
		// A split continuation plans the rounded-up remainder, so one second of rounding is not early.
		expect(isFinishedEarly(base({ plannedSec: 60, segments: [{ start: at(0), end: at(59.4) }] }))).toBe(false);
	});
});

describe("history tree (P2, P3)", () => {
	const rec = (id: string, startSec: number, lenSec: number, patch: Partial<FocusSession> = {}): FocusSession => ({
		id,
		deviceId: DEV,
		taskId: "t1",
		taskTitleSnapshot: "Write",
		plannedSec: 1500,
		status: "completed",
		segments: [{ start: at(startSec), end: at(startSec + lenSec) }],
		unobserved: [],
		splitFrom: null,
		startedAt: at(startSec),
		endedAt: at(startSec + lenSec),
		finalizedAt: at(startSec + lenSec),
		setId: "s1",
		setRounds: 4,
		...patch,
	});
	const tree = (list: FocusSession[], active: string | null = null) => focusHistoryTree(list, "UTC", active);

	it("groups by day (newest first), then by set, rounds in order", () => {
		const day = 86400;
		const days = tree([
			rec("b", 1800, 1500),
			rec("a", 0, 1500),
			rec("c", day + 100, 1500, { setId: "s2", setRounds: 1 }),
		]);
		expect(days.map((d) => d.day)).toEqual(["2026-10-02", "2026-10-01"]);
		const first = days[1]!.sets[0]!;
		expect(first.rounds.map((x) => [x.session.id, x.number])).toEqual([["a", 1], ["b", 2]]);
		expect(first).toMatchObject({ setId: "s1", plannedRounds: 4, roundCount: 2, totalSec: 3000, startedAt: at(0), endedAt: at(3300) });
		expect(days[1]!.totalSec).toBe(3000);
	});

	it("a record without a set id is a one-round set of its own", () => {
		const a = rec("a", 0, 1500, { setId: undefined, setRounds: undefined });
		const b = rec("b", 1800, 1500, { setId: undefined, setRounds: undefined });
		delete a.setId;
		delete b.setId;
		const sets = tree([a, b])[0]!.sets;
		expect(sets).toHaveLength(2);
		expect(sets.every((s) => s.roundCount === 1 && s.plannedRounds === null && s.setId === null)).toBe(true);
		expect(new Set(sets.map((s) => s.key)).size).toBe(2);
	});

	it("a split round and its continuation are one round", () => {
		const sets = tree([rec("a", 0, 600, { status: "split" }), rec("b", 600, 900, { splitFrom: "a", taskId: "t2" }), rec("c", 1800, 1500)])[0]!.sets;
		expect(sets[0]!.rounds.map((x) => x.number)).toEqual([1, 1, 2]);
		expect(sets[0]!.roundCount).toBe(2);
		expect(sets[0]!.mixedTasks).toBe(true);
	});

	it("tells whether the tasks of a set differ", () => {
		expect(tree([rec("a", 0, 1500), rec("b", 1800, 1500)])[0]!.sets[0]!.mixedTasks).toBe(false);
		expect(tree([rec("a", 0, 1500), rec("b", 1800, 1500, { taskId: null })])[0]!.sets[0]!.mixedTasks).toBe(true);
	});

	it("uses the stored round number: a dropped round leaves a hole, and the set still reads done", () => {
		const set = tree([
			rec("a", 0, 1500, { setRound: 1, setRounds: 4 }),
			rec("c", 3600, 1500, { setRound: 3, setRounds: 4 }),
			rec("d", 5400, 1500, { setRound: 4, setRounds: 4 }),
		])[0]!.sets[0]!;
		expect(set.rounds.map((x) => x.number)).toEqual([1, 3, 4]);
		// The heading counts rounds reached ("4 of 4"), not records kept.
		expect(set).toMatchObject({ end: "done", endedAfter: 4, roundCount: 4 });
	});

	it("a deleted middle round keeps the others' numbers", () => {
		const set = tree([rec("a", 0, 1500, { setRound: 1 }), rec("c", 3600, 1500, { setRound: 3 })])[0]!.sets[0]!;
		expect(set.rounds.map((x) => x.number)).toEqual([1, 3]);
		expect(set.end).toBe("stopped");
	});

	it("a split round and its continuation share the stored number", () => {
		const set = tree([rec("a", 0, 600, { status: "split", setRound: 2 }), rec("b", 600, 900, { splitFrom: "a", setRound: 2 })])[0]!.sets[0]!;
		expect(set.rounds.map((x) => x.number)).toEqual([2, 2]);
		// Round 2 was reached (round 1 is not in this list), so the heading reads "2 of N".
		expect(set.roundCount).toBe(2);
	});

	it("derives how the set ended", () => {
		const end = (list: FocusSession[], active: string | null = null) => tree(list, active)[0]!.sets[0]!;
		expect(end([rec("a", 0, 1500, { setRounds: 1 })])).toMatchObject({ end: "done", endedAfter: 1 });
		expect(end([rec("a", 0, 1500), rec("b", 1800, 900, { status: "stopped" })])).toMatchObject({ end: "stopped", endedAfter: 2 });
		// Stopped in the break after a completed round: not done, since rounds are left.
		expect(end([rec("a", 0, 1500)])).toMatchObject({ end: "stopped", endedAfter: 1 });
		expect(end([rec("a", 0, 1500, { status: "recovered" })])).toMatchObject({ end: "recovered" });
		expect(end([rec("a", 0, 1500)], "s1")).toMatchObject({ end: "active" });
		const legacy = rec("a", 0, 1500, { setRounds: undefined });
		delete legacy.setId;
		expect(end([legacy])).toMatchObject({ end: "done" });
	});
});
