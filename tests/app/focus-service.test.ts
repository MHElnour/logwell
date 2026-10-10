import { describe, expect, it } from "vitest";
import { mergeCollections } from "../../src/app/DataService";
import { FocusService } from "../../src/app/FocusService";
import type { ActiveTimerPort, FocusSettingsPort } from "../../src/app/ports";
import { type ActiveTimer, type FocusSetConfig, focusHistoryTree, focusOverview, focusedSec, taskFocusTotals } from "../../src/domain/focus";
import type { FocusSession } from "../../src/domain/types";
import { sequentialIds } from "../helpers";
import { type AppHarness, appHarness, makeReadOnly } from "./harness";

const DB = "db-1";
const cfg = (rounds = 1): FocusSetConfig => ({ rounds, focusSec: 1500, breakSec: 300, longBreakSec: 900 });

class TestPort implements ActiveTimerPort {
	readonly stored = new Map<string, string>();
	saves = 0;
	onSave: ((timer: ActiveTimer | null) => void) | null = null;

	load(dbId: string): unknown {
		const text = this.stored.get(dbId);
		return text === undefined ? null : (JSON.parse(text) as unknown);
	}

	save(dbId: string, timer: ActiveTimer | null): void {
		this.saves++;
		this.onSave?.(timer);
		if (timer === null) this.stored.delete(dbId);
		else this.stored.set(dbId, JSON.stringify(timer));
	}

	get timer(): ActiveTimer | null {
		return this.load(DB) as ActiveTimer | null;
	}
}

/** Set by a test to make the database file reject writes. */
const failWrites = { on: false };

interface Setup {
	h: AppHarness;
	port: TestPort;
	svc: FocusService;
	settings: { discard: boolean };
	/** A new service on the same store and port, as after a reload. */
	reload(): FocusService;
}

async function setup(): Promise<Setup> {
	const h = await appHarness({
		wrapFile: (file) => ({
			read: () => file.read(),
			write: (content, expected) => (failWrites.on ? Promise.reject(new Error("disk full")) : file.write(content, expected)),
		}),
	});
	const port = new TestPort();
	const settings = { discard: true };
	let n = 0;
	const make = (): FocusService => {
		const s: FocusSettingsPort = { deviceId: () => "d-test", discardShortFocus: () => settings.discard };
		return new FocusService(h.app.store, h.clock, sequentialIds(`e${n++}`), port, s);
	};
	const svc = make();
	await svc.open(DB);
	return { h, port, svc, settings, reload: make };
}

async function ticks(s: Setup, svc: FocusService, seconds: number, by = 1): Promise<void> {
	for (let done = 0; done < seconds; done += by) {
		s.h.clock.advance(by * 1000);
		await svc.tick();
	}
}

const sessions = (s: Setup): FocusSession[] => [...s.h.app.store.state.focusSessions.values()];

describe("start (B34)", () => {
	it("starts a set and keeps the timer on the port", async () => {
		const s = await setup();
		expect(await s.svc.start(cfg(), null)).toEqual({ kind: "started" });
		expect(s.svc.timer()).toMatchObject({ phase: "focus", round: 1, taskId: null });
		expect(s.port.timer).toMatchObject({ phase: "focus", state: "running" });
	});

	it("a second start is busy; sameTask for the same task or none, not for another", async () => {
		const s = await setup();
		const a = (await s.h.app.tasks.create({ title: "A" })).task;
		const b = (await s.h.app.tasks.create({ title: "B" })).task;
		await s.svc.start(cfg(), a.id);
		expect(await s.svc.start(cfg(), a.id)).toEqual({ kind: "busy", sameTask: true });
		expect(await s.svc.start(cfg(), null)).toEqual({ kind: "busy", sameTask: true });
		expect(await s.svc.start(cfg(), b.id)).toEqual({ kind: "busy", sameTask: false });
		expect(s.svc.timer()?.taskId).toBe(a.id);
	});

	it("refuses an unknown task and out-of-range values", async () => {
		const s = await setup();
		await expect(s.svc.start(cfg(), "nope")).rejects.toThrow(/no longer exists/);
		await expect(s.svc.start({ ...cfg(), rounds: 9 }, null)).rejects.toThrow();
		await expect(s.svc.start({ ...cfg(), focusSec: 0 }, null)).rejects.toThrow();
		expect(s.svc.timer()).toBeNull();
	});
});

describe("finalizing a round (D4, B36, POM-07)", () => {
	it("writes the record and flushes the file before the timer moves on", async () => {
		const s = await setup();
		const task = (await s.h.app.tasks.create({ title: "Study" })).task;
		await s.svc.start(cfg(2), task.id);
		const id = s.svc.timer()!.sessionId!;
		const seen: { inMemory: boolean; onDisk: boolean; phase: string | undefined }[] = [];
		s.port.onSave = (t) => seen.push({ inMemory: s.h.app.store.state.focusSessions.has(id), onDisk: s.h.dbText().includes(id), phase: t?.phase });
		await ticks(s, s.svc, 1500, 30);
		const afterEnd = seen.filter((x) => x.phase === "short-break");
		expect(afterEnd.length).toBeGreaterThan(0);
		expect(afterEnd.every((x) => x.inMemory && x.onDisk)).toBe(true);
		expect(s.port.timer).toMatchObject({ phase: "short-break", round: 1 });
	});

	it("is not undoable and never completes or edits the task", async () => {
		const s = await setup();
		const task = (await s.h.app.tasks.create({ title: "Study" })).task;
		await s.svc.start(cfg(), task.id);
		const label = s.h.app.store.undoLabel;
		const events: string[] = [];
		s.svc.bus.on("moment", (m) => events.push(m));
		s.svc.bus.on("set-done", (e) => events.push(`done:${e.rounds}:${e.focusedSec}`));
		await ticks(s, s.svc, 1500, 30);
		expect(s.h.app.store.undoLabel).toBe(label);
		expect(sessions(s)).toHaveLength(1);
		expect(sessions(s)[0]).toMatchObject({ status: "completed", taskId: task.id, taskTitleSnapshot: "Study", deviceId: "d-test" });
		expect(s.h.app.store.state.tasks.get(task.id)).toEqual(task);
		expect(events).toEqual(["set-done", "done:1:1500"]);
		expect(s.svc.timer()).toBeNull();
		expect(s.port.timer).toBeNull();
		expect(s.svc.lastSummary()).toEqual({ rounds: 1, focusedSec: 1500 });
	});

	it("takes the live task title into the snapshot", async () => {
		const s = await setup();
		const task = (await s.h.app.tasks.create({ title: "Old" })).task;
		await s.svc.start(cfg(), task.id);
		await s.h.app.tasks.update(task.id, { title: "New" });
		await ticks(s, s.svc, 1500, 30);
		expect(sessions(s)[0]?.taskTitleSnapshot).toBe("New");
	});

	it("a failed write puts the round back, pauses it, and does not fail again every second (A1, A2)", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 1470, 30);
		await makeReadOnly(s.h);
		s.h.clock.advance(40_000);
		await expect(s.svc.tick()).rejects.toThrow(/read-only/);
		expect(s.svc.timer()).toMatchObject({ phase: "focus", state: "paused", needsRecovery: false, unobserved: [] });
		expect(s.port.timer).toMatchObject({ phase: "focus", state: "paused" });
		s.h.clock.advance(1000);
		await expect(s.svc.tick()).resolves.toBeUndefined();
	});

	it("A1: flush resolves although the file write failed; the port still holds the focus round", async () => {
		const s = await setup();
		await s.svc.start(cfg(2), null);
		const id = s.svc.timer()!.sessionId!;
		await ticks(s, s.svc, 1470, 30);
		failWrites.on = true;
		try {
			s.h.clock.advance(40_000);
			await expect(s.svc.tick()).rejects.toThrow(/not saved|could not/i);
			expect(s.h.dbText()).not.toContain(id);
			expect(s.port.timer).toMatchObject({ phase: "focus", sessionId: id });
			expect(s.svc.timer()).toMatchObject({ phase: "focus", sessionId: id, state: "paused" });
		} finally {
			failWrites.on = false;
		}
		// The file works again: resume, the next tick finalizes, and the record reaches the file once.
		await s.svc.resume();
		s.h.clock.advance(1000);
		await s.svc.tick();
		expect(s.port.timer).toMatchObject({ phase: "short-break" });
		expect(s.h.dbText().split(id).length - 1).toBe(1);
		expect(sessions(s)).toHaveLength(1);
	});

	it("A3: a Pause during a failing finalize keeps the focus round recoverable", async () => {
		const s = await setup();
		await s.svc.start(cfg(2), null);
		const id = s.svc.timer()!.sessionId!;
		await ticks(s, s.svc, 1470, 30);
		failWrites.on = true;
		try {
			s.h.clock.advance(40_000);
			const tick = s.svc.tick();
			const paused = s.svc.pause();
			await expect(tick).rejects.toThrow();
			await paused;
			expect(s.svc.timer()).toMatchObject({ phase: "focus", sessionId: id, state: "paused" });
			expect(s.port.timer).toMatchObject({ phase: "focus", sessionId: id, state: "paused" });
		} finally {
			failWrites.on = false;
		}
		await s.svc.resume();
		s.h.clock.advance(1000);
		await s.svc.tick();
		expect(sessions(s).map((x) => x.id)).toEqual([id]);
	});

	it("A2: start, split and reassign are refused while the database is read-only", async () => {
		const s = await setup();
		await makeReadOnly(s.h);
		await expect(s.svc.start(cfg(), null)).rejects.toThrow(/read-only/);
		expect(s.svc.timer()).toBeNull();
		const s2 = await setup();
		const b2 = (await s2.h.app.tasks.create({ title: "B" })).task;
		await s2.svc.start(cfg(), null);
		await makeReadOnly(s2.h);
		await expect(s2.svc.split(b2.id)).rejects.toThrow(/read-only/);
		expect(s2.svc.timer()?.taskId).toBeNull();
	});

	it("reassign writes nothing to the file, so it works while the database is read-only", async () => {
		const s = await setup();
		const b = (await s.h.app.tasks.create({ title: "B" })).task;
		await s.svc.start(cfg(), null);
		await makeReadOnly(s.h);
		await s.svc.reassign(b.id);
		expect(s.svc.timer()?.taskId).toBe(b.id);
		expect(s.port.timer?.taskId).toBe(b.id);
	});

	it("A1: an unrelated edit landing during the first flush does not roll the round back", async () => {
		const s = await setup();
		await s.svc.start(cfg(2), null);
		await ticks(s, s.svc, 1470, 30);
		const host = s.h.app.store.host;
		const orig = host.flush.bind(host);
		let calls = 0;
		host.flush = async () => {
			calls++;
			await orig();
			if (calls === 1) await s.h.app.tasks.create({ title: "unrelated" });
		};
		s.h.clock.advance(40_000);
		await s.svc.tick();
		expect(calls).toBe(2);
		expect(s.svc.timer()).toMatchObject({ phase: "short-break", state: "running" });
		expect(sessions(s)).toHaveLength(1);
	});
});

describe("heartbeat (B32)", () => {
	it("saves lastHeartbeat to the port at most every 15 s", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		const base = s.port.saves;
		await ticks(s, s.svc, 14);
		expect(s.port.saves).toBe(base);
		await ticks(s, s.svc, 1);
		expect(s.port.saves).toBe(base + 1);
		expect(s.port.timer?.lastHeartbeat).toBe(s.h.clock.now().toISOString());
		await ticks(s, s.svc, 30);
		expect(s.port.saves).toBe(base + 3);
	});

	it("a tick more than 90 s after the previous asks for recovery and writes nothing", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 100, 50);
		const events: string[] = [];
		s.svc.bus.on("recovery-needed", () => events.push("recovery"));
		s.h.clock.advance(600_000);
		await s.svc.tick();
		expect(events).toEqual(["recovery"]);
		expect(s.svc.timer()).toMatchObject({ state: "paused", needsRecovery: true });
		expect(s.svc.timer()?.unobserved).toHaveLength(1);
		expect(sessions(s)).toEqual([]);
		expect(s.port.timer?.needsRecovery).toBe(true);
	});
});

describe("open (B31, B33)", () => {
	it("B31: a running timer found on open is paused with a pending gap, nothing is written", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 60, 15);
		const writes = s.h.fs.writes.length;
		s.h.clock.advance(300_000);
		const svc2 = s.reload();
		const events: string[] = [];
		svc2.bus.on("recovery-needed", () => events.push("recovery"));
		expect(await svc2.open(DB)).toBe("recovery");
		expect(events).toEqual(["recovery"]);
		expect(svc2.timer()).toMatchObject({ state: "paused", needsRecovery: true });
		expect(svc2.timer()?.unobserved[0]).toMatchObject({ resolution: "pending" });
		expect(sessions(s)).toEqual([]);
		expect(s.h.fs.writes.length).toBe(writes);
		expect(s.port.timer?.needsRecovery).toBe(true);
	});

	it("B33: a timer whose session is already in the file is cleared and nothing is written", async () => {
		const s = await setup();
		await s.svc.start(cfg(2), null);
		const before = JSON.stringify(s.port.timer);
		await ticks(s, s.svc, 1500, 30);
		expect(sessions(s)).toHaveLength(1);
		// The crash: the file has the record, the port still has the old round.
		s.port.stored.set(DB, before);
		const writes = s.h.fs.writes.length;
		const svc2 = s.reload();
		expect(await svc2.open(DB)).toBe("already-saved");
		expect(svc2.timer()).toBeNull();
		expect(s.port.timer).toBeNull();
		expect(sessions(s)).toHaveLength(1);
		expect(s.h.fs.writes.length).toBe(writes);
	});

	it("treats a timer of another shape or version as no timer", async () => {
		const s = await setup();
		for (const junk of [{ v: 2, phase: "focus" }, "text", { v: 1 }, 7]) {
			s.port.stored.set(DB, JSON.stringify(junk));
			const svc2 = s.reload();
			expect(await svc2.open(DB)).toBe("none");
			expect(svc2.timer()).toBeNull();
		}
	});

	it("a paused timer without a prompt is restored as is", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 30, 15);
		await s.svc.pause();
		s.h.clock.advance(3_600_000);
		const svc2 = s.reload();
		expect(await svc2.open(DB)).toBe("restored");
		expect(svc2.timer()).toMatchObject({ state: "paused", needsRecovery: false, unobserved: [] });
	});
});

describe("AS-12", () => {
	it("start, kill after 3 min, open 10 min later: 3 min focused, 10 min pending; Finish saves 3 min; Include makes 13", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 180, 15);
		const killedAt = s.h.clock.now().getTime();
		// The service is dropped; ten minutes pass.
		s.h.clock.advance(600_000);
		const svc2 = s.reload();
		await svc2.open(DB);
		const t = svc2.timer()!;
		expect(t).toMatchObject({ state: "paused", needsRecovery: true });
		expect(t.segments).toHaveLength(1);
		expect(Date.parse(t.segments[0]!.end!) - Date.parse(t.segments[0]!.start)).toBe(180_000);
		expect(t.unobserved).toEqual([
			{ start: new Date(killedAt).toISOString(), end: s.h.clock.now().toISOString(), resolution: "pending" },
		]);
		// A second open adds no second gap.
		const svc3 = s.reload();
		expect(await svc3.open(DB)).toBe("recovery");
		expect(svc3.timer()?.unobserved).toHaveLength(1);
		expect(sessions(s)).toEqual([]);
		// Finish: one record, 3 minutes.
		await svc3.resolveRecovery("finish");
		expect(sessions(s)).toHaveLength(1);
		const rec = sessions(s)[0]!;
		expect(rec.status).toBe("recovered");
		expect(focusedSec(rec)).toBe(180);
		expect(svc3.timer()).toBeNull();
		expect(s.port.timer).toBeNull();
		// Include: 13 minutes.
		await svc3.includeGap(rec.id, 0, true);
		expect(focusedSec(s.h.app.store.state.focusSessions.get(rec.id)!)).toBe(780);
		expect(s.h.app.store.undoLabel).toBe("Edit focus record");
		await svc3.includeGap(rec.id, 0, false);
		expect(focusedSec(s.h.app.store.state.focusSessions.get(rec.id)!)).toBe(180);
	});

	it("Resume keeps the gap pending; Discard drops the set, writes nothing, and can be undone", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 60, 15);
		s.h.clock.advance(600_000);
		const svc2 = s.reload();
		await svc2.open(DB);
		await svc2.resolveRecovery("resume");
		expect(svc2.timer()).toMatchObject({ state: "running", needsRecovery: false });
		expect(svc2.timer()?.unobserved).toHaveLength(1);

		const svc3 = s.reload();
		s.h.clock.advance(600_000);
		await svc3.open(DB);
		const writes = s.h.fs.writes.length;
		await svc3.resolveRecovery("discard");
		expect(svc3.timer()).toBeNull();
		expect(s.port.timer).toBeNull();
		expect(sessions(s)).toEqual([]);
		expect(s.h.fs.writes.length).toBe(writes);
		expect(await svc3.restoreDiscardedTimer()).toBe(true);
		expect(svc3.timer()).toMatchObject({ state: "paused", needsRecovery: true });
		expect(s.port.timer?.needsRecovery).toBe(true);
		expect(await svc3.restoreDiscardedTimer()).toBe(false);
	});
});

describe("split and reassign (B35)", () => {
	it("split saves A as split and B continues with the same end", async () => {
		const s = await setup();
		const a = (await s.h.app.tasks.create({ title: "A" })).task;
		const b = (await s.h.app.tasks.create({ title: "B" })).task;
		await s.svc.start(cfg(), a.id);
		await ticks(s, s.svc, 600, 30);
		const aId = s.svc.timer()!.sessionId;
		await s.svc.split(b.id);
		expect(sessions(s)).toHaveLength(1);
		expect(sessions(s)[0]).toMatchObject({ id: aId, status: "split", taskId: a.id });
		expect(focusedSec(sessions(s)[0]!)).toBe(600);
		expect(s.svc.timer()).toMatchObject({ taskId: b.id, taskTitleSnapshot: "B", splitFrom: aId, state: "running" });
		await ticks(s, s.svc, 900, 30);
		expect(sessions(s)).toHaveLength(2);
		const second = sessions(s).find((x) => x.taskId === b.id)!;
		expect(second).toMatchObject({ status: "completed", splitFrom: aId });
		expect(focusedSec(second)).toBe(900);
		const totals = taskFocusTotals(sessions(s));
		expect(totals.get(a.id)).toBe(600);
		expect(totals.get(b.id)).toBe(900);
	});

	it("reassign moves the running round without writing", async () => {
		const s = await setup();
		const b = (await s.h.app.tasks.create({ title: "B" })).task;
		await s.svc.start(cfg(), null);
		const id = s.svc.timer()!.sessionId;
		const writes = s.h.fs.writes.length;
		await s.svc.reassign(b.id);
		expect(s.svc.timer()).toMatchObject({ sessionId: id, taskId: b.id, taskTitleSnapshot: "B" });
		expect(sessions(s)).toEqual([]);
		expect(s.h.fs.writes.length).toBe(writes);
		expect(s.port.timer?.taskId).toBe(b.id);
		await s.svc.reassign(null);
		expect(s.svc.timer()?.taskId).toBeNull();
	});

	it("split to no task saves A and continues with no task (B2)", async () => {
		const s = await setup();
		const a = (await s.h.app.tasks.create({ title: "A" })).task;
		await s.svc.start(cfg(), a.id);
		await ticks(s, s.svc, 300, 30);
		await s.svc.split(null);
		expect(sessions(s)[0]).toMatchObject({ taskId: a.id, status: "split" });
		expect(s.svc.timer()).toMatchObject({ taskId: null, taskTitleSnapshot: "", splitFrom: sessions(s)[0]!.id });
	});

	it("resolveRecovery says whether it applied", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 30, 15);
		s.h.clock.advance(600_000);
		await s.svc.tick();
		expect(await s.svc.resolveRecovery("resume")).toBe(true);
		expect(await s.svc.resolveRecovery("resume")).toBe(false);
	});

	it("split needs a running focus round", async () => {
		const s = await setup();
		const b = (await s.h.app.tasks.create({ title: "B" })).task;
		await expect(s.svc.split(b.id)).rejects.toThrow();
		await s.svc.start(cfg(2), null);
		await ticks(s, s.svc, 1500, 30);
		expect(s.svc.timer()?.phase).toBe("short-break");
		await expect(s.svc.split(b.id)).rejects.toThrow();
	});
});

describe("pause, resume, skip, stop", () => {
	it("pause and resume keep the port in step", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 10);
		await s.svc.pause();
		expect(s.port.timer?.state).toBe("paused");
		s.h.clock.advance(5000);
		await s.svc.resume();
		expect(s.port.timer?.state).toBe("running");
	});

	it("skip in a focus saves it and starts the break; skip in a break starts the next focus", async () => {
		const s = await setup();
		await s.svc.start(cfg(2), null);
		await ticks(s, s.svc, 120, 30);
		await s.svc.skip();
		expect(sessions(s)).toHaveLength(1);
		expect(sessions(s)[0]?.status).toBe("stopped");
		expect(s.svc.timer()?.phase).toBe("short-break");
		await s.svc.skip();
		expect(s.svc.timer()).toMatchObject({ phase: "focus", round: 2 });
	});

	it("stop saves the real seconds (POM-05) and ends the set without a summary", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 300, 30);
		await s.svc.stop();
		expect(sessions(s)).toHaveLength(1);
		expect(sessions(s)[0]).toMatchObject({ status: "stopped" });
		expect(focusedSec(sessions(s)[0]!)).toBe(300);
		expect(s.svc.timer()).toBeNull();
		expect(s.port.timer).toBeNull();
		expect(s.svc.lastSummary()).toBeNull();
	});

	it("starting a new set clears the last summary", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 1500, 30);
		expect(s.svc.lastSummary()).not.toBeNull();
		await s.svc.start(cfg(), null);
		expect(s.svc.lastSummary()).toBeNull();
	});
});

describe("short sessions (D7)", () => {
	it("a stop under a minute is not saved, says so, and Undo saves it", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		const id = s.svc.timer()!.sessionId!;
		await ticks(s, s.svc, 30, 15);
		const events: string[] = [];
		s.svc.bus.on("short-discarded", (e) => events.push(e.sessionId));
		await s.svc.stop();
		expect(sessions(s)).toEqual([]);
		expect(events).toEqual([id]);
		expect(s.svc.timer()).toBeNull();
		expect(await s.svc.undoShortDiscard(id)).toBe(true);
		expect(sessions(s)).toHaveLength(1);
		expect(sessions(s)[0]).toMatchObject({ id, status: "stopped" });
		expect(focusedSec(sessions(s)[0]!)).toBe(30);
		expect(await s.svc.undoShortDiscard(id)).toBe(false);
	});

	it("A4: two short discards each keep their own Undo, and a new set does not wipe them", async () => {
		const s = await setup();
		const ids: string[] = [];
		s.svc.bus.on("short-discarded", (e) => ids.push(e.sessionId));
		await s.svc.start(cfg(2), null);
		const first = s.svc.timer()!.sessionId!;
		await ticks(s, s.svc, 20, 10);
		await s.svc.skip();
		await s.svc.skip();
		const second = s.svc.timer()!.sessionId!;
		await ticks(s, s.svc, 20, 10);
		await s.svc.stop();
		expect(ids).toEqual([first, second]);
		expect(sessions(s)).toEqual([]);
		await s.svc.start(cfg(), null);
		expect(await s.svc.undoShortDiscard(first)).toBe(true);
		expect(sessions(s).map((x) => x.id)).toEqual([first]);
		expect(await s.svc.undoShortDiscard(first)).toBe(false);
		expect(await s.svc.undoShortDiscard("unknown")).toBe(false);
		expect(await s.svc.undoShortDiscard(second)).toBe(true);
		expect(sessions(s).map((x) => x.id).sort()).toEqual([first, second].sort());
	});

	it("A4: an Undo whose write fails stays available", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		const id = s.svc.timer()!.sessionId!;
		await ticks(s, s.svc, 20, 10);
		await s.svc.stop();
		failWrites.on = true;
		try {
			await expect(s.svc.undoShortDiscard(id)).rejects.toThrow();
		} finally {
			failWrites.on = false;
		}
		expect(await s.svc.undoShortDiscard(id)).toBe(true);
		expect(sessions(s)).toHaveLength(1);
	});

	it("A8: a discarded short round is not in the set's focused total", async () => {
		const s = await setup();
		await s.svc.start(cfg(2), null);
		await ticks(s, s.svc, 20, 10);
		await s.svc.skip();
		expect(s.svc.timer()?.setFocusedSec).toBe(0);
		await s.svc.skip();
		await ticks(s, s.svc, 1500, 30);
		expect(sessions(s)).toHaveLength(1);
		expect(s.svc.lastSummary()).toEqual({ rounds: 2, focusedSec: 1500 });
	});

	it("a skip under a minute is not saved, and the set goes on", async () => {
		const s = await setup();
		await s.svc.start(cfg(2), null);
		await ticks(s, s.svc, 20, 10);
		await s.svc.skip();
		expect(sessions(s)).toEqual([]);
		expect(s.svc.timer()?.phase).toBe("short-break");
	});

	it("is saved at 60 s, and with the setting off", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 60, 30);
		await s.svc.stop();
		expect(sessions(s)).toHaveLength(1);

		s.settings.discard = false;
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 10, 5);
		await s.svc.stop();
		expect(sessions(s)).toHaveLength(2);
	});

	it("a split or a recovered round under a minute is saved", async () => {
		const s = await setup();
		const b = (await s.h.app.tasks.create({ title: "B" })).task;
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 10, 5);
		await s.svc.split(b.id);
		expect(sessions(s)).toHaveLength(1);
		expect(sessions(s)[0]?.status).toBe("split");
	});
});

describe("clock and shutdown", () => {
	it("A6: a clock that goes back persists the heartbeat and keeps the time counted", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 30, 5);
		const lastSave = s.port.saves;
		s.h.clock.advance(-20_000);
		await s.svc.tick();
		expect(s.port.saves).toBe(lastSave + 1);
		expect(s.port.timer?.lastHeartbeat).toBe(s.h.clock.now().toISOString());
		expect(s.svc.timer()?.segments).toHaveLength(2);
	});

	it("close returns null when nothing is running, so the session closes its store without an extra await", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await s.svc.tick();
		expect(s.svc.close()).toBeNull();
	});

	it("B1: a closed service ignores ticks and writes nothing", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 1470, 30);
		await s.svc.close();
		s.h.clock.advance(40_000);
		await s.svc.tick();
		expect(sessions(s)).toEqual([]);
		expect(s.port.timer).toMatchObject({ phase: "focus" });
	});

	it("D4: close() waits for a tick that is writing, and nothing is written after it resolves", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 1470, 30);
		const host = s.h.app.store.host;
		const orig = host.flush.bind(host);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((r) => (release = r));
		let inFlush: () => void = () => undefined;
		const started = new Promise<void>((r) => (inFlush = r));
		host.flush = async () => {
			inFlush();
			await gate;
			await orig();
		};
		s.h.clock.advance(40_000);
		const inFlight = s.svc.tick();
		await started;
		let closedDone = false;
		const closed = (s.svc.close() ?? Promise.reject(new Error("close did not wait for the tick"))).then(() => void (closedDone = true));
		await new Promise((r) => setTimeout(r, 0));
		expect(closedDone).toBe(false);
		release();
		await closed;
		await expect(inFlight).resolves.toBeUndefined();
		const after = s.h.dbText();
		expect(sessions(s)).toHaveLength(1);
		expect(after).toContain(sessions(s)[0]!.id);
		s.h.clock.advance(60_000);
		await s.svc.tick();
		expect(s.h.dbText()).toBe(after);
	});

	it("B1: a tick while one is in flight joins it, and there is none without a timer", async () => {
		const s = await setup();
		await expect(s.svc.tick()).resolves.toBeUndefined();
		await s.svc.start(cfg(), null);
		s.h.clock.advance(1000);
		const a = s.svc.tick();
		const b = s.svc.tick();
		expect(b).toBe(a);
		await a;
	});
});

describe("history actions", () => {
	it("assign sets or clears the task of a record (POM-10) with its own undo label", async () => {
		const s = await setup();
		const t = (await s.h.app.tasks.create({ title: "Later" })).task;
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 1500, 30);
		const rec = sessions(s)[0]!;
		expect(rec.taskId).toBeNull();
		await s.svc.assign(rec.id, t.id);
		expect(s.h.app.store.state.focusSessions.get(rec.id)).toMatchObject({ taskId: t.id, taskTitleSnapshot: "Later" });
		expect(s.h.app.store.undoLabel).toBe("Assign focus record");
		await s.svc.assign(rec.id, null);
		expect(s.h.app.store.state.focusSessions.get(rec.id)?.taskId).toBeNull();
		await expect(s.svc.assign(rec.id, "gone")).rejects.toThrow();
		await expect(s.svc.assign("missing", null)).rejects.toThrow();
	});

	it("includeGap refuses a bad index", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 1500, 30);
		await expect(s.svc.includeGap(sessions(s)[0]!.id, 0, true)).rejects.toThrow();
	});
});

describe("totals survive deleted tasks (D9, B8, B9)", () => {
	it("keeps the sessions and the snapshot when the task is deleted and purged", async () => {
		const s = await setup();
		const t = (await s.h.app.tasks.create({ title: "Gone soon" })).task;
		await s.svc.start(cfg(), t.id);
		await ticks(s, s.svc, 1500, 30);
		expect(taskFocusTotals(sessions(s)).get(t.id)).toBe(1500);
		await s.h.app.tasks.delete(t.id);
		expect(s.h.app.store.state.tasks.has(t.id)).toBe(false);
		expect(sessions(s)).toHaveLength(1);
		expect(taskFocusTotals(sessions(s)).get(t.id)).toBe(1500);
		s.h.clock.advance(31 * 86_400_000);
		expect(await s.h.app.tasks.purgeExpired()).toBe(1);
		expect(s.h.app.store.state.trash.size).toBe(0);
		expect(sessions(s)).toHaveLength(1);
		expect(sessions(s)[0]).toMatchObject({ taskId: t.id, taskTitleSnapshot: "Gone soon" });
		expect(taskFocusTotals(sessions(s)).get(t.id)).toBe(1500);
	});

	it("start refuses a task that is in Trash", async () => {
		const s = await setup();
		const t = (await s.h.app.tasks.create({ title: "Trashed" })).task;
		await s.h.app.tasks.delete(t.id);
		await expect(s.svc.start(cfg(), t.id)).rejects.toThrow();
	});
});

describe("set id (P3)", () => {
	it("stamps every round record with the set id and the planned rounds, and Split keeps them", async () => {
		const s = await setup();
		await s.svc.start(cfg(2), null);
		const setId = s.svc.timer()!.setId;
		await ticks(s, s.svc, 600, 30);
		await s.svc.split(null);
		await ticks(s, s.svc, 1500, 30);
		const recs = sessions(s);
		expect(recs.length).toBeGreaterThanOrEqual(2);
		for (const r of recs) expect(r).toMatchObject({ setId, setRounds: 2 });
		expect(s.port.timer).not.toBeNull();
		expect(s.port.timer!.setId).toBe(setId);
		expect(recs.map((r) => r.setRound)).toEqual([1, 1]);
	});

	it("stamps the round number; a round dropped under 60 s leaves a hole and the set still reads done (P2)", async () => {
		const s = await setup();
		await s.svc.start(cfg(4), null);
		await ticks(s, s.svc, 1500, 30); // round 1 completes, break
		await ticks(s, s.svc, 300, 30); // break ends, round 2 starts
		expect(s.svc.timer()).toMatchObject({ phase: "focus", round: 2 });
		await ticks(s, s.svc, 30, 10);
		await s.svc.skip(); // round 2 is under 60 s: not saved
		await s.svc.skip(); // the break is skipped, round 3 starts
		await ticks(s, s.svc, 1500, 30);
		await ticks(s, s.svc, 300, 30);
		await ticks(s, s.svc, 1500, 30);
		expect(s.svc.timer()).toBeNull();
		const recs = sessions(s).sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
		expect(recs.map((r) => r.setRound)).toEqual([1, 3, 4]);
		const set = focusHistoryTree(recs, "UTC")[0]!.sets[0]!;
		expect(set.rounds.map((r) => `Round ${r.number}`)).toEqual(["Round 1", "Round 3", "Round 4"]);
		expect(set.end).toBe("done");
	});

	it("the timer on the port carries the set id across a reload", async () => {
		const s = await setup();
		await s.svc.start(cfg(2), null);
		const setId = s.svc.timer()!.setId;
		const svc2 = s.reload();
		await svc2.open(DB);
		expect(svc2.timer()?.setId).toBe(setId);
	});
});

describe("finish (P5)", () => {
	it("mid-set: writes a completed record with the real seconds and starts the break, with the moment", async () => {
		const s = await setup();
		const events: string[] = [];
		s.svc.bus.on("moment", (m) => events.push(m));
		await s.svc.start(cfg(2), null);
		await ticks(s, s.svc, 600, 30);
		await s.svc.finish();
		const [rec] = sessions(s);
		expect(rec).toMatchObject({ status: "completed", plannedSec: 1500 });
		expect(focusedSec(rec!)).toBe(600);
		expect(s.svc.timer()).toMatchObject({ phase: "short-break", round: 1 });
		expect(s.port.timer).toMatchObject({ phase: "short-break" });
		expect(events).toEqual(["focus-start", "break-start"]);
	});

	it("the last round: writes the record, ends the set and reports the summary", async () => {
		const s = await setup();
		const done: { rounds: number; focusedSec: number }[] = [];
		s.svc.bus.on("set-done", (e) => done.push(e));
		await s.svc.start(cfg(1), null);
		await ticks(s, s.svc, 900, 30);
		await s.svc.finish();
		expect(s.svc.timer()).toBeNull();
		expect(s.port.timer).toBeNull();
		expect(sessions(s)[0]?.status).toBe("completed");
		expect(done).toEqual([{ rounds: 1, focusedSec: 900 }]);
		expect(s.svc.lastSummary()).toEqual({ rounds: 1, focusedSec: 900 });
	});

	it("under 60 s is not saved (D7) and Undo saves it, as for Stop", async () => {
		const s = await setup();
		const ids: string[] = [];
		s.svc.bus.on("short-discarded", (e) => ids.push(e.sessionId));
		await s.svc.start(cfg(2), null);
		await ticks(s, s.svc, 30, 10);
		await s.svc.finish();
		expect(sessions(s)).toHaveLength(0);
		expect(ids).toHaveLength(1);
		// The set still moves on to the break.
		expect(s.svc.timer()?.phase).toBe("short-break");
		expect(await s.svc.undoShortDiscard(ids[0]!)).toBe(true);
		expect(sessions(s)[0]?.status).toBe("completed");
	});

	it("a one-round set finished under 60 s is dropped by D7, with its Undo (clean-up review 2)", async () => {
		const s = await setup();
		const ids: string[] = [];
		s.svc.bus.on("short-discarded", (e) => ids.push(e.sessionId));
		await s.svc.start(cfg(1), null);
		await s.svc.finish();
		expect(ids).toHaveLength(1);
		expect(sessions(s)).toHaveLength(0);
		expect(s.svc.timer()).toBeNull();
		expect(await s.svc.undoShortDiscard(ids[0]!)).toBe(true);
		expect(sessions(s)).toHaveLength(1);
	});

	async function fourRoundSetAtLastRound(s: Setup): Promise<void> {
		await s.svc.start(cfg(4), null);
		await ticks(s, s.svc, 5400, 30);
		expect(s.svc.timer()).toMatchObject({ phase: "focus", round: 4 });
	}

	it("the last round of a set with an earlier saved round is kept under 60 s: the set reads done, no pomo, focus time counts (clean-up review 2)", async () => {
		const s = await setup();
		const ids: string[] = [];
		s.svc.bus.on("short-discarded", (e) => ids.push(e.sessionId));
		await fourRoundSetAtLastRound(s);
		await ticks(s, s.svc, 20, 10);
		await s.svc.finish();
		expect(ids).toHaveLength(0);
		expect(sessions(s)).toHaveLength(4);
		expect(s.svc.timer()).toBeNull();
		const set = focusHistoryTree(sessions(s), "UTC")[0]!.sets[0]!;
		expect(set.end).toBe("done");
		const o = focusOverview(sessions(s), "2000-01-01", "UTC");
		expect(o.totalCount).toBe(3);
		expect(o.totalSec).toBe(3 * 1500 + 20);
	});

	it("a short last Finish after a Split continuation is kept (clean-up review 7)", async () => {
		const s = await setup();
		const b = (await s.h.app.tasks.create({ title: "B" })).task;
		await s.svc.start(cfg(1), null);
		await ticks(s, s.svc, 600, 30);
		await s.svc.split(b.id);
		await ticks(s, s.svc, 20, 10);
		await s.svc.finish();
		expect(sessions(s).map((x) => x.status).sort()).toEqual(["completed", "split"]);
		expect(s.svc.timer()).toBeNull();
	});

	it("a short last Finish after a recovery Resume is kept when an earlier round is saved (clean-up review 7)", async () => {
		const s = await setup();
		await s.svc.start(cfg(2), null);
		await ticks(s, s.svc, 1500, 30);
		await ticks(s, s.svc, 300, 30);
		expect(s.svc.timer()).toMatchObject({ phase: "focus", round: 2 });
		await ticks(s, s.svc, 10, 10);
		s.h.clock.advance(600_000);
		const svc2 = s.reload();
		await svc2.open(DB);
		await svc2.resolveRecovery("resume");
		s.h.clock.advance(10_000);
		await svc2.finish();
		expect(sessions(s)).toHaveLength(2);
		expect(svc2.timer()).toBeNull();
	});

	it("Skip and Stop on the last round under 60 s are still dropped", async () => {
		const s = await setup();
		await s.svc.start(cfg(1), null);
		await ticks(s, s.svc, 30, 10);
		await s.svc.stop();
		expect(sessions(s)).toHaveLength(0);
	});

	it("under 60 s is saved when the setting is off", async () => {
		const s = await setup();
		s.settings.discard = false;
		await s.svc.start(cfg(2), null);
		await ticks(s, s.svc, 30, 10);
		await s.svc.finish();
		expect(sessions(s)).toHaveLength(1);
	});

	it("does nothing in a break or with no timer", async () => {
		const s = await setup();
		await s.svc.finish();
		await s.svc.start(cfg(2), null);
		await ticks(s, s.svc, 600, 30);
		await s.svc.skip();
		const before = s.svc.timer();
		await s.svc.finish();
		expect(s.svc.timer()).toEqual(before);
		expect(sessions(s)).toHaveLength(1);
	});
});

describe("finish runs the tick logic first (P5)", () => {
	it("a stale heartbeat opens the recovery prompt instead of saving the round", async () => {
		const s = await setup();
		await s.svc.start(cfg(2), null);
		await ticks(s, s.svc, 120, 10);
		s.h.clock.advance(200_000);
		await s.svc.finish();
		expect(sessions(s)).toHaveLength(0);
		expect(s.svc.timer()).toMatchObject({ phase: "focus", needsRecovery: true });
	});

	it("a planned end that already passed is a natural end at the planned length, and Finish does nothing more", async () => {
		const s = await setup();
		await s.svc.start(cfg(2), null);
		await ticks(s, s.svc, 1490, 10);
		s.h.clock.advance(20_000);
		await s.svc.finish();
		const recs = sessions(s);
		expect(recs).toHaveLength(1);
		expect(focusedSec(recs[0]!)).toBe(1500);
		expect(s.svc.timer()).toMatchObject({ phase: "short-break", round: 1 });
		expect(s.svc.timer()!.completedFocusCount).toBe(1);
	});

	it("while paused it saves the round with the seconds focused so far", async () => {
		const s = await setup();
		await s.svc.start(cfg(2), null);
		await ticks(s, s.svc, 300, 30);
		await s.svc.pause();
		s.h.clock.advance(500_000);
		await s.svc.finish();
		expect(sessions(s)).toHaveLength(1);
		expect(sessions(s)[0]).toMatchObject({ status: "completed" });
		expect(focusedSec(sessions(s)[0]!)).toBe(300);
		expect(s.svc.timer()).toMatchObject({ phase: "short-break" });
	});

	it("a failed write puts the focus round back on the timer and the port (A1)", async () => {
		const s = await setup();
		await s.svc.start(cfg(2), null);
		const id = s.svc.timer()!.sessionId!;
		await ticks(s, s.svc, 300, 30);
		failWrites.on = true;
		try {
			await expect(s.svc.finish()).rejects.toThrow();
			expect(s.svc.timer()).toMatchObject({ phase: "focus", sessionId: id });
			expect(s.port.timer).toMatchObject({ phase: "focus", sessionId: id });
			expect(s.h.dbText()).not.toContain(id);
		} finally {
			failWrites.on = false;
		}
		await s.svc.finish();
		expect(sessions(s).map((x) => x.id)).toEqual([id]);
		expect(s.svc.timer()).toMatchObject({ phase: "short-break" });
	});

	it("a round with unobserved gaps is saved as recovered, as a natural end would be", async () => {
		const s = await setup();
		await s.svc.start(cfg(2), null);
		await ticks(s, s.svc, 120, 10);
		s.h.clock.advance(200_000);
		await s.svc.tick();
		expect(await s.svc.resolveRecovery("resume")).toBe(true);
		await ticks(s, s.svc, 30, 10);
		await s.svc.finish();
		expect(sessions(s)).toHaveLength(1);
		expect(sessions(s)[0]).toMatchObject({ status: "recovered" });
		expect(sessions(s)[0]!.unobserved).toHaveLength(1);
	});
});

describe("delete and remove task (P4)", () => {
	it("deleteRecord is refused while the database is read-only", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 1500, 30);
		const rec = sessions(s)[0]!;
		await makeReadOnly(s.h);
		await expect(s.svc.deleteRecord(rec.id)).rejects.toThrow(/read-only/);
		expect(s.h.app.store.state.focusSessions.has(rec.id)).toBe(true);
	});

	it("deleteRecord removes the record with its own undo label, and Undo restores it", async () => {
		const s = await setup();
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 1500, 30);
		const rec = sessions(s)[0]!;
		await s.svc.deleteRecord(rec.id);
		expect(sessions(s)).toHaveLength(0);
		expect(s.h.app.store.undoLabel).toBe("Delete focus record");
		expect(await s.h.app.store.undoIfLatest("Delete focus record")).toBe(true);
		expect(s.h.app.store.state.focusSessions.get(rec.id)).toEqual(rec);
	});

	it("deleteRecord refuses a record that is gone", async () => {
		const s = await setup();
		await expect(s.svc.deleteRecord("missing")).rejects.toThrow();
	});

	it("totals follow a delete", async () => {
		const s = await setup();
		const t = (await s.h.app.tasks.create({ title: "T" })).task;
		await s.svc.start(cfg(), t.id);
		await ticks(s, s.svc, 1500, 30);
		expect(taskFocusTotals(sessions(s)).get(t.id)).toBe(1500);
		await s.svc.deleteRecord(sessions(s)[0]!.id);
		expect(taskFocusTotals(sessions(s)).get(t.id)).toBeUndefined();
	});

	it("remove task is assign with no task, and it can be undone", async () => {
		const s = await setup();
		const t = (await s.h.app.tasks.create({ title: "T" })).task;
		await s.svc.start(cfg(), t.id);
		await ticks(s, s.svc, 1500, 30);
		const rec = sessions(s)[0]!;
		await s.svc.assign(rec.id, null);
		expect(s.h.app.store.state.focusSessions.get(rec.id)?.taskId).toBeNull();
		expect(await s.h.app.store.undoIfLatest("Assign focus record")).toBe(true);
		expect(s.h.app.store.state.focusSessions.get(rec.id)?.taskId).toBe(t.id);
	});
});

describe("edits report whether they wrote (clean-up review 1)", () => {
	it("assign resolves true once, false for the same task again, and Undo reverts it once", async () => {
		const s = await setup();
		const t = (await s.h.app.tasks.create({ title: "T" })).task;
		await s.svc.start(cfg(), null);
		await ticks(s, s.svc, 1500, 30);
		const rec = sessions(s)[0]!;
		expect(await s.svc.assign(rec.id, t.id)).toBe(true);
		expect(await s.svc.assign(rec.id, t.id)).toBe(false);
		expect(await s.h.app.store.undo()).toBe("Assign focus record");
		expect(s.h.app.store.state.focusSessions.get(rec.id)?.taskId).toBeNull();
		expect(s.h.app.store.undoLabel).not.toBe("Assign focus record");
	});

	async function withGap(): Promise<{ s: Setup; rec: FocusSession }> {
		const s = await setup();
		await s.svc.start(cfg(1), null);
		await ticks(s, s.svc, 90, 30);
		s.h.clock.advance(5 * 60_000);
		const svc2 = s.reload();
		await svc2.open(DB);
		await svc2.resolveRecovery("finish");
		return { s: { ...s, svc: svc2 }, rec: sessions(s)[0]! };
	}

	it("includeGap resolves true once and false when the gap already has that resolution", async () => {
		const { s, rec } = await withGap();
		expect(await s.svc.includeGap(rec.id, 0, true)).toBe(true);
		expect(await s.svc.includeGap(rec.id, 0, true)).toBe(false);
		expect(await s.h.app.store.undo()).toBe("Edit focus record");
		expect(s.h.app.store.undoLabel).not.toBe("Edit focus record");
	});

	it("Undo of a gap edit restores the record byte for byte, without modifiedAt (clean-up review 7)", async () => {
		const { s, rec } = await withGap();
		const before = JSON.stringify(s.h.app.store.state.focusSessions.get(rec.id));
		await s.svc.includeGap(rec.id, 0, true);
		expect(s.h.app.store.state.focusSessions.get(rec.id)!.modifiedAt).toBeDefined();
		await s.h.app.store.undo();
		const after = s.h.app.store.state.focusSessions.get(rec.id)!;
		expect(JSON.stringify(after)).toBe(before);
		expect(after).not.toHaveProperty("modifiedAt");
	});
});

describe("modifiedAt of an edited record (clean-up 3)", () => {
	async function withGap(): Promise<{ s: Setup; rec: FocusSession }> {
		const s = await setup();
		await s.svc.start(cfg(1), null);
		await ticks(s, s.svc, 90, 30);
		s.h.clock.advance(5 * 60_000);
		const svc2 = s.reload();
		await svc2.open(DB);
		await svc2.resolveRecovery("finish");
		return { s: { ...s, svc: svc2 }, rec: sessions(s)[0]! };
	}

	it("finalizing does not stamp it; includeGap, assign and remove task do", async () => {
		const { s, rec } = await withGap();
		const t = (await s.h.app.tasks.create({ title: "T" })).task;
		expect(rec.modifiedAt).toBeUndefined();
		s.h.clock.advance(1000);
		await s.svc.includeGap(rec.id, 0, true);
		const first = s.h.app.store.state.focusSessions.get(rec.id)!.modifiedAt;
		expect(first).toBe(new Date(s.h.clock.now()).toISOString());
		s.h.clock.advance(1000);
		await s.svc.assign(rec.id, t.id);
		const second = s.h.app.store.state.focusSessions.get(rec.id)!.modifiedAt!;
		expect(second > first!).toBe(true);
		s.h.clock.advance(1000);
		await s.svc.assign(rec.id, null);
		expect(s.h.app.store.state.focusSessions.get(rec.id)!.modifiedAt! > second).toBe(true);
	});

	it("a write that changes nothing does not stamp it", async () => {
		const { s, rec } = await withGap();
		await s.svc.assign(rec.id, null);
		expect(s.h.app.store.state.focusSessions.get(rec.id)!.modifiedAt).toBeUndefined();
	});

	it("an edited record wins over the unedited copy in a merge, in both directions", async () => {
		const { s, rec } = await withGap();
		const unedited = s.h.app.store.state;
		s.h.clock.advance(1000);
		await s.svc.includeGap(rec.id, 0, true);
		const edited = s.h.app.store.state;
		expect(mergeCollections(edited, unedited, s.h.app.store.now()).focusSessions.get(rec.id)!.unobserved[0]!.resolution).toBe("included");
		expect(mergeCollections(unedited, edited, s.h.app.store.now()).focusSessions.get(rec.id)!.unobserved[0]!.resolution).toBe("included");
	});
});
