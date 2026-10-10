import { describe, expect, it } from "vitest";
import {
	type ActiveTimer,
	type FocusEffect,
	type FocusSetConfig,
	type Step,
	focusOverview,
	focusedSec,
	parseActiveTimer,
	pause,
	reassign,
	recoverOnLoad,
	remainingSec,
	resolveRecovery,
	resume,
	skip,
	split,
	startSet,
	stop,
	taskFocusTotals,
	tick,
} from "../../src/domain/focus";
import type { FocusSession } from "../../src/domain/types";
import { sequentialIds } from "../helpers";

const T0 = Date.parse("2026-10-01T10:00:00.000Z");
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString();
const DEV = "d-test";
const TASK = { id: "task-a", title: "Study" };

// 25 min focus, 5 min break, 15 min long break.
const cfg = (rounds: number): FocusSetConfig => ({ rounds, focusSec: 1500, breakSec: 300, longBreakSec: 900 });

/** Drives a timer with a clock; ticks every `stepSec` seconds, as the host does. */
class Run {
	timer: ActiveTimer | null;
	effects: FocusEffect[] = [];
	readonly ids = sequentialIds("f");
	sec = 0;

	constructor(config: FocusSetConfig, task: { id: string; title: string } | null = TASK) {
		const step = startSet(config, task, at(0), this.ids);
		this.timer = step.timer;
		this.effects.push(...step.effects);
	}

	apply(step: Step): Step {
		this.timer = step.timer;
		this.effects.push(...step.effects);
		return step;
	}

	/** Advances to second `to`, ticking every `by` seconds. */
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

describe("startSet", () => {
	it("starts round 1 as a running focus with one open segment", () => {
		const r = new Run(cfg(4));
		expect(r.timer).toMatchObject({
			v: 1,
			phase: "focus",
			state: "running",
			needsRecovery: false,
			round: 1,
			taskId: "task-a",
			taskTitleSnapshot: "Study",
			plannedSec: 1500,
			completedFocusCount: 0,
			setFocusedSec: 0,
			splitFrom: null,
			unobserved: [],
			segments: [{ start: at(0), end: null }],
		});
		expect(r.timer?.sessionId).toBeTruthy();
		expect(r.moments()).toEqual(["focus-start"]);
	});

	it("allows no task (POM-10)", () => {
		const r = new Run(cfg(1), null);
		expect(r.timer).toMatchObject({ taskId: null, taskTitleSnapshot: "" });
	});
});

describe("sets (D6)", () => {
	it("a 4-round set runs focus, short break, ... and ends with no break after the last round", () => {
		const r = new Run(cfg(4));
		const phases: string[] = [];
		let last = "";
		for (let s = 0; s <= 4 * 1500 + 3 * 300 + 5 && r.timer !== null; s += 1) {
			r.run(s);
			const label = r.timer === null ? "done" : `${r.timer.phase}:${r.timer.round}`;
			if (label !== last) phases.push(label);
			last = label;
		}
		expect(phases).toEqual(["focus:1", "short-break:1", "focus:2", "short-break:2", "focus:3", "short-break:3", "focus:4", "done"]);
		expect(r.saved()).toHaveLength(4);
		expect(r.saved().every((s) => s.status === "completed")).toBe(true);
		expect(r.moments()).toEqual([
			"focus-start",
			"break-start",
			"focus-start",
			"break-start",
			"focus-start",
			"break-start",
			"focus-start",
			"set-done",
		]);
		expect(r.effects.at(-1)).toEqual({ kind: "set-done", rounds: 4, focusedSec: 6000 });
	});

	it("a 6-round set has a long break after round 4 and short breaks otherwise", () => {
		const r = new Run(cfg(6));
		const breaks: string[] = [];
		let last = "";
		for (let s = 0; r.timer !== null; s += 5) {
			r.run(s, 5);
			if (r.timer === null) break;
			const label = `${r.timer.phase}:${r.timer.round}`;
			if (label !== last && r.timer.phase !== "focus") breaks.push(label);
			last = label;
		}
		expect(breaks).toEqual(["short-break:1", "short-break:2", "short-break:3", "long-break:4", "short-break:5"]);
	});

	it("a set of 4 or fewer rounds never has a long break", () => {
		const r = new Run(cfg(3));
		const seen = new Set<string>();
		for (let s = 0; r.timer !== null; s += 10) {
			r.run(s, 10);
			if (r.timer) seen.add(r.timer.phase);
		}
		expect(seen.has("long-break")).toBe(false);
	});

	it("each completed round is a record with exactly the planned seconds, even when ticks are late", () => {
		const r = new Run(cfg(2));
		r.run(1505, 7); // the ticks land at 1498 and 1505, past the end at 1500
		const [s] = r.saved();
		expect(s).toMatchObject({ plannedSec: 1500, status: "completed", taskId: "task-a", startedAt: at(0), endedAt: at(1500), finalizedAt: at(1505) });
		expect(focusedSec(s!)).toBe(1500);
		// The break started at the exact end of the focus.
		expect(r.timer).toMatchObject({ phase: "short-break", startedAt: at(1500), plannedSec: 300 });
		expect(remainingSec(r.timer!, at(1505))).toBe(295);
	});

	it("breaks add no focus (POM-04) and the next focus has its own session id", () => {
		const r = new Run(cfg(2));
		const first = r.timer!.sessionId;
		r.run(1500 + 300 + 10);
		expect(r.timer).toMatchObject({ phase: "focus", round: 2, completedFocusCount: 1, setFocusedSec: 1500 });
		expect(r.timer!.sessionId).not.toBe(first);
		expect(r.saved()).toHaveLength(1);
	});

	it("a break has no session id", () => {
		const r = new Run(cfg(2));
		r.run(1501);
		expect(r.timer).toMatchObject({ phase: "short-break", sessionId: null });
	});
});

describe("pause and resume", () => {
	it("pauses add no focus (POM-04) and remainingSec ignores paused time", () => {
		const r = new Run(cfg(1));
		r.run(600);
		r.apply(pause(r.timer!, at(600)));
		expect(r.timer?.state).toBe("paused");
		expect(remainingSec(r.timer!, at(600))).toBe(900);
		expect(remainingSec(r.timer!, at(5000))).toBe(900);
		r.apply(resume(r.timer!, at(1000)));
		expect(r.timer?.state).toBe("running");
		expect(remainingSec(r.timer!, at(1100))).toBe(800);
		r.sec = 1000;
		r.run(1000 + 900);
		expect(r.timer).toBeNull();
		const [s] = r.saved();
		expect(s!.segments).toEqual([
			{ start: at(0), end: at(600) },
			{ start: at(1000), end: at(1900) },
		]);
		expect(focusedSec(s!)).toBe(1500);
		expect(s!.endedAt).toBe(at(1900));
	});

	it("ticks while paused change nothing", () => {
		const r = new Run(cfg(1));
		r.run(100);
		r.apply(pause(r.timer!, at(100)));
		const before = r.timer;
		const step = tick(r.timer!, at(500), DEV, r.ids);
		expect(step.timer).toEqual(before);
		expect(step.effects).toEqual([]);
	});

	it("pause on a paused timer and resume on a running timer are no-ops", () => {
		const r = new Run(cfg(1));
		expect(resume(r.timer!, at(5)).timer).toEqual(r.timer);
		r.apply(pause(r.timer!, at(10)));
		expect(pause(r.timer!, at(20)).timer).toEqual(r.timer);
	});

	it("pause freezes a break too", () => {
		const r = new Run(cfg(2));
		r.run(1500 + 100);
		r.apply(pause(r.timer!, at(1600)));
		expect(remainingSec(r.timer!, at(9999))).toBe(200);
		r.apply(resume(r.timer!, at(2000)));
		r.run(2200);
		expect(r.timer).toMatchObject({ phase: "focus", round: 2 });
	});
});

describe("stop (POM-05)", () => {
	it("saves the real seconds as stopped and ends the set", () => {
		const r = new Run(cfg(4));
		r.run(400);
		const step = r.apply(stop(r.timer!, at(400), DEV));
		expect(step.timer).toBeNull();
		const [s] = r.saved();
		expect(s).toMatchObject({ status: "stopped", plannedSec: 1500, endedAt: at(400), finalizedAt: at(400) });
		expect(focusedSec(s!)).toBe(400);
		expect(step.effects.some((e) => e.kind === "set-done")).toBe(false);
	});

	it("while paused, saves only the observed seconds", () => {
		const r = new Run(cfg(4));
		r.run(400);
		r.apply(pause(r.timer!, at(400)));
		r.apply(stop(r.timer!, at(900), DEV));
		expect(focusedSec(r.saved()[0]!)).toBe(400);
	});

	it("in a break saves nothing and ends the set", () => {
		const r = new Run(cfg(4));
		r.run(1600);
		expect(r.timer?.phase).toBe("short-break");
		const step = r.apply(stop(r.timer!, at(1600), DEV));
		expect(step.timer).toBeNull();
		expect(r.saved()).toHaveLength(1); // only round 1
	});
});

describe("skip", () => {
	it("skipping a focus saves it as stopped and starts the break", () => {
		const r = new Run(cfg(4));
		r.run(300);
		r.apply(skip(r.timer!, at(300), DEV, r.ids));
		expect(r.saved()[0]).toMatchObject({ status: "stopped" });
		expect(focusedSec(r.saved()[0]!)).toBe(300);
		expect(r.timer).toMatchObject({ phase: "short-break", round: 1, startedAt: at(300), state: "running" });
		expect(r.moments().at(-1)).toBe("break-start");
	});

	it("skipping a break starts the next focus", () => {
		const r = new Run(cfg(4));
		r.run(1510);
		r.apply(skip(r.timer!, at(1510), DEV, r.ids));
		expect(r.timer).toMatchObject({ phase: "focus", round: 2, startedAt: at(1510), plannedSec: 1500, completedFocusCount: 1 });
		expect(r.moments().at(-1)).toBe("focus-start");
		expect(r.saved()).toHaveLength(1);
	});

	it("skipping the last focus ends the set with a summary", () => {
		const r = new Run(cfg(1));
		r.run(200);
		const step = r.apply(skip(r.timer!, at(200), DEV, r.ids));
		expect(step.timer).toBeNull();
		expect(step.effects).toContainEqual({ kind: "set-done", rounds: 1, focusedSec: 200 });
	});

	it("skipping a paused focus starts the break running", () => {
		const r = new Run(cfg(2));
		r.run(100);
		r.apply(pause(r.timer!, at(100)));
		r.apply(skip(r.timer!, at(500), DEV, r.ids));
		expect(r.timer).toMatchObject({ phase: "short-break", state: "running", startedAt: at(500) });
		expect(focusedSec(r.saved()[0]!)).toBe(100);
	});

	it("the long break follows skipping round 4 of 6", () => {
		const r = new Run(cfg(6));
		for (let i = 0; i < 3; i++) {
			r.apply(skip(r.timer!, at(0), DEV, r.ids)); // focus -> break
			r.apply(skip(r.timer!, at(0), DEV, r.ids)); // break -> focus
		}
		expect(r.timer).toMatchObject({ phase: "focus", round: 4 });
		r.apply(skip(r.timer!, at(0), DEV, r.ids));
		expect(r.timer).toMatchObject({ phase: "long-break", plannedSec: 900 });
	});
});

describe("remainingSec", () => {
	it("counts down while running and rounds up to whole seconds", () => {
		const r = new Run(cfg(1));
		expect(remainingSec(r.timer!, at(0))).toBe(1500);
		expect(remainingSec(r.timer!, new Date(T0 + 10_500).toISOString())).toBe(1490);
		expect(remainingSec(r.timer!, at(9999))).toBe(0);
	});
});

describe("B31 recoverOnLoad", () => {
	it("closes the segment at the heartbeat, adds a pending gap and pauses with a prompt", () => {
		const r = new Run(cfg(1));
		r.run(180, 60);
		const step = recoverOnLoad(r.timer!, at(780));
		expect(step.timer).toMatchObject({ state: "paused", needsRecovery: true, lastHeartbeat: at(780) });
		expect(step.timer?.segments).toEqual([{ start: at(0), end: at(180) }]);
		expect(step.timer?.unobserved).toEqual([{ start: at(180), end: at(780), resolution: "pending" }]);
		expect(step.effects).toEqual([{ kind: "recovery-needed" }]);
		expect(remainingSec(step.timer!, at(780))).toBe(1320);
	});

	it("is a no-op on a paused timer, so a second load adds no second gap", () => {
		const r = new Run(cfg(1));
		r.run(180, 60);
		const first = recoverOnLoad(r.timer!, at(780));
		const again = recoverOnLoad(first.timer!, at(1380));
		expect(again.timer).toEqual(first.timer);
		expect(again.effects).toEqual([]);
	});

	it("a break gap pauses with a prompt but records no unobserved time", () => {
		const r = new Run(cfg(2));
		r.run(1500 + 60, 60);
		const step = recoverOnLoad(r.timer!, at(3000));
		expect(step.timer).toMatchObject({ phase: "short-break", state: "paused", needsRecovery: true, unobserved: [] });
		expect(step.effects).toEqual([{ kind: "recovery-needed" }]);
	});
});

describe("B32 gap during a run", () => {
	it("a tick more than 90 s after the previous one pauses with a prompt", () => {
		const r = new Run(cfg(1));
		r.run(100);
		const step = r.apply(tick(r.timer!, at(100 + 900), DEV, r.ids));
		expect(step.timer).toMatchObject({ state: "paused", needsRecovery: true });
		expect(step.timer?.segments).toEqual([{ start: at(0), end: at(100) }]);
		expect(step.timer?.unobserved).toEqual([{ start: at(100), end: at(1000), resolution: "pending" }]);
		expect(step.effects).toEqual([{ kind: "recovery-needed" }]);
		expect(r.saved()).toEqual([]);
	});

	it("a gap that spans the phase end still does not count or finish the round", () => {
		const r = new Run(cfg(1));
		r.run(100);
		r.apply(tick(r.timer!, at(5000), DEV, r.ids));
		expect(r.timer?.needsRecovery).toBe(true);
		expect(r.saved()).toEqual([]);
	});

	it("exactly 90 s between ticks is not a gap, 91 s is (A5)", () => {
		const r = new Run(cfg(1));
		r.run(60);
		const step = tick(r.timer!, at(150), DEV, r.ids);
		expect(step.timer?.needsRecovery).toBe(false);
		expect(step.timer?.lastHeartbeat).toBe(at(150));
		expect(tick(r.timer!, at(151), DEV, r.ids).timer?.needsRecovery).toBe(true);
	});

	it("a throttled background tick 85 s apart is not a gap (A5)", () => {
		const r = new Run(cfg(1));
		r.run(100);
		expect(tick(r.timer!, at(185), DEV, r.ids).timer?.needsRecovery).toBe(false);
	});

	it("a clock that goes back by more than 5 s re-anchors the segment, so no time is lost (A6)", () => {
		const r = new Run(cfg(1));
		r.run(100);
		const step = r.apply(tick(r.timer!, at(80), DEV, r.ids));
		expect(step.timer).toMatchObject({ state: "running", needsRecovery: false, lastHeartbeat: at(80) });
		expect(step.timer?.segments).toEqual([
			{ start: at(0), end: at(100) },
			{ start: at(80), end: null },
		]);
		expect(remainingSec(step.timer!, at(90))).toBe(1390);
	});

	it("a clock that goes back by 5 s or less does not re-anchor (A6)", () => {
		const r = new Run(cfg(1));
		r.run(100);
		const step = tick(r.timer!, at(95), DEV, r.ids);
		expect(step.timer?.segments).toEqual([{ start: at(0), end: null }]);
	});
});

describe("resolveRecovery (D5)", () => {
	const needing = (): Run => {
		const r = new Run(cfg(2));
		r.run(180, 60);
		r.apply(recoverOnLoad(r.timer!, at(780)));
		return r;
	};

	it("resume continues the round and keeps the gap pending", () => {
		const r = needing();
		r.apply(resolveRecovery(r.timer!, "resume", at(800), DEV));
		expect(r.timer).toMatchObject({ state: "running", needsRecovery: false });
		expect(r.timer?.unobserved).toHaveLength(1);
		expect(r.timer?.segments.at(-1)).toEqual({ start: at(800), end: null });
		expect(remainingSec(r.timer!, at(900))).toBe(1500 - 180 - 100);
	});

	it("a resumed round that completes is saved as recovered with the gap pending", () => {
		const r = needing();
		r.apply(resolveRecovery(r.timer!, "resume", at(800), DEV));
		r.sec = 800;
		r.run(800 + 1320);
		const [s] = r.saved();
		expect(s).toMatchObject({ status: "recovered" });
		expect(s!.unobserved).toEqual([{ start: at(180), end: at(780), resolution: "pending" }]);
		expect(focusedSec(s!)).toBe(1500);
	});

	it("finish saves the round as recovered now, keeps the gap pending, and ends the set", () => {
		const r = needing();
		const step = r.apply(resolveRecovery(r.timer!, "finish", at(900), DEV));
		expect(step.timer).toBeNull();
		const [s] = r.saved();
		expect(s).toMatchObject({ status: "recovered", endedAt: at(900), finalizedAt: at(900) });
		expect(focusedSec(s!)).toBe(180);
		expect(s!.unobserved).toEqual([{ start: at(180), end: at(780), resolution: "pending" }]);
	});

	it("discard drops the round and the set and saves nothing", () => {
		const r = needing();
		const step = r.apply(resolveRecovery(r.timer!, "discard", at(900), DEV));
		expect(step).toEqual({ timer: null, effects: [] });
	});

	it("does nothing when no prompt is pending", () => {
		const r = new Run(cfg(1));
		const step = resolveRecovery(r.timer!, "finish", at(5), DEV);
		expect(step.timer).toEqual(r.timer);
		expect(step.effects).toEqual([]);
	});

	it("finish in a break ends the set without a record", () => {
		const r = new Run(cfg(2));
		r.run(1500 + 60, 60);
		r.apply(recoverOnLoad(r.timer!, at(3000)));
		const before = r.saved().length;
		const step = r.apply(resolveRecovery(r.timer!, "finish", at(3000), DEV));
		expect(step.timer).toBeNull();
		expect(r.saved()).toHaveLength(before);
	});

	it("stopping a round with a pending prompt saves it as recovered, not stopped", () => {
		const r = needing();
		r.apply(stop(r.timer!, at(900), DEV));
		expect(r.saved()[0]?.status).toBe("recovered");
	});
});

describe("split and reassign (B35)", () => {
	it("split finalizes A as split at now and keeps the phase end for B", () => {
		const r = new Run(cfg(2));
		r.run(600);
		const a = r.timer!.sessionId;
		const endBefore = 1500; // the phase ends 900 s from now
		r.apply(split(r.timer!, { id: "task-b", title: "Write" }, at(600), DEV, r.ids));
		const [sa] = r.saved();
		expect(sa).toMatchObject({ id: a, status: "split", taskId: "task-a", endedAt: at(600) });
		expect(focusedSec(sa!)).toBe(600);
		expect(r.timer).toMatchObject({
			phase: "focus",
			round: 1,
			state: "running",
			taskId: "task-b",
			taskTitleSnapshot: "Write",
			splitFrom: a,
			startedAt: at(600),
			setFocusedSec: 600,
		});
		expect(r.timer!.sessionId).not.toBe(a);
		expect(remainingSec(r.timer!, at(600))).toBe(endBefore - 600);
		// B's focus ends at the same instant the original round would have.
		r.run(1500);
		expect(r.saved()).toHaveLength(2);
		expect(r.saved()[1]).toMatchObject({ taskId: "task-b", splitFrom: a, status: "completed", endedAt: at(1500) });
		expect(focusedSec(r.saved()[1]!)).toBe(900);
		expect(r.timer).toMatchObject({ phase: "short-break" });
	});

	it("split of a paused round leaves B paused", () => {
		const r = new Run(cfg(1));
		r.run(300);
		r.apply(pause(r.timer!, at(300)));
		r.apply(split(r.timer!, { id: "task-b", title: "Write" }, at(400), DEV, r.ids));
		expect(r.timer).toMatchObject({ state: "paused", taskId: "task-b", segments: [] });
		expect(remainingSec(r.timer!, at(5000))).toBe(1200);
	});

	it("reassign moves the running round to B and writes nothing", () => {
		const r = new Run(cfg(1));
		r.run(300);
		const id = r.timer!.sessionId;
		const step = r.apply(reassign(r.timer!, { id: "task-b", title: "Write" }));
		expect(step.effects).toEqual([]);
		expect(r.timer).toMatchObject({ sessionId: id, taskId: "task-b", taskTitleSnapshot: "Write" });
	});

	it("reassign to no task clears the task", () => {
		const r = new Run(cfg(1));
		r.apply(reassign(r.timer!, null));
		expect(r.timer).toMatchObject({ taskId: null, taskTitleSnapshot: "" });
	});

	it("reassign during a break sets the next round's task", () => {
		const r = new Run(cfg(2));
		r.run(1600);
		r.apply(reassign(r.timer!, { id: "task-b", title: "Write" }));
		r.run(1500 + 300);
		expect(r.timer).toMatchObject({ phase: "focus", round: 2, taskId: "task-b", taskTitleSnapshot: "Write" });
	});
});

describe("focusedSec, totals, overview, history (D9, D10)", () => {
	const session = (id: string, patch: Partial<FocusSession> = {}): FocusSession => ({
		id,
		deviceId: DEV,
		taskId: "task-a",
		taskTitleSnapshot: "Study",
		plannedSec: 1500,
		status: "completed",
		segments: [{ start: at(0), end: at(600) }],
		unobserved: [],
		splitFrom: null,
		startedAt: at(0),
		endedAt: at(600),
		finalizedAt: at(601),
		...patch,
	});

	it("sums segments and only included gaps", () => {
		const s = session("s", {
			segments: [
				{ start: at(0), end: at(100) },
				{ start: at(200), end: at(260) },
			],
			unobserved: [
				{ start: at(100), end: at(200), resolution: "included" },
				{ start: at(260), end: at(360), resolution: "pending" },
				{ start: at(360), end: at(460), resolution: "excluded" },
			],
		});
		expect(focusedSec(s)).toBe(100 + 60 + 100);
	});

	it("clamps a backwards segment or gap at zero (A7)", () => {
		const s = session("s", {
			segments: [
				{ start: at(0), end: at(100) },
				{ start: at(300), end: at(200) },
			],
			unobserved: [{ start: at(500), end: at(400), resolution: "included" }],
		});
		expect(focusedSec(s)).toBe(100);
	});

	it("task totals sum a task's own sessions and skip unassigned ones", () => {
		const totals = taskFocusTotals([
			session("1"),
			session("2", { taskId: "task-b" }),
			session("3"),
			session("4", { taskId: null }),
		]);
		expect(totals.get("task-a")).toBe(1200);
		expect(totals.get("task-b")).toBe(600);
		expect(totals.size).toBe(2);
	});

	it("overview counts today by the session start in the display zone", () => {
		const day2 = Date.parse("2026-10-02T10:00:00.000Z");
		const later = (sec: number) => new Date(day2 + sec * 1000).toISOString();
		const sessions = [
			session("1"),
			session("2", { segments: [{ start: later(0), end: later(300) }], startedAt: later(0), endedAt: later(300) }),
		];
		expect(focusOverview(sessions, "2026-10-02", "Europe/Berlin")).toEqual({ todayCount: 1, todaySec: 300, totalCount: 2, totalSec: 900 });
	});

	it("overview counts only completed rounds as pomos, but sums the time of every session", () => {
		const day2 = Date.parse("2026-10-02T10:00:00.000Z");
		const later = (sec: number) => new Date(day2 + sec * 1000).toISOString();
		const today = { segments: [{ start: later(0), end: later(300) }], startedAt: later(0), endedAt: later(300) };
		const sessions = [
			session("1"), // completed, an earlier day
			session("2", { ...today, status: "stopped" }),
			session("3", { ...today, status: "split" }),
			session("4", { ...today, status: "completed" }),
		];
		expect(focusOverview(sessions, "2026-10-02", "Europe/Berlin")).toEqual({ todayCount: 1, todaySec: 900, totalCount: 2, totalSec: 1500 });
	});

	it("a completed round under 60 s is not a pomo, but its time counts (clean-up review 2)", () => {
		const day2 = Date.parse("2026-10-02T10:00:00.000Z");
		const later = (sec: number) => new Date(day2 + sec * 1000).toISOString();
		const short = session("s", { segments: [{ start: later(0), end: later(20) }], startedAt: later(0), endedAt: later(20), status: "completed" });
		const exact = session("e", { segments: [{ start: later(100), end: later(160) }], startedAt: later(100), endedAt: later(160), status: "completed" });
		expect(focusOverview([short, exact], "2026-10-02", "Europe/Berlin")).toEqual({ todayCount: 1, todaySec: 80, totalCount: 1, totalSec: 80 });
	});
});

describe("parseActiveTimer", () => {
	it("accepts a timer and rejects other shapes and versions", () => {
		const r = new Run(cfg(2));
		expect(parseActiveTimer(JSON.parse(JSON.stringify(r.timer)))).toEqual(r.timer);
		expect(parseActiveTimer(null)).toBeNull();
		expect(parseActiveTimer("x")).toBeNull();
		expect(parseActiveTimer({ ...r.timer, v: 2 })).toBeNull();
		expect(parseActiveTimer({ ...r.timer, phase: "nap" })).toBeNull();
		expect(parseActiveTimer({ ...r.timer, segments: "no" })).toBeNull();
		expect(parseActiveTimer({ ...r.timer, config: { rounds: 4 } })).toBeNull();
		expect(parseActiveTimer({ ...r.timer, lastHeartbeat: 5 })).toBeNull();
	});
});
