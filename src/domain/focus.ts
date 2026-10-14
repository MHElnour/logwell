import type { FocusGap, FocusSession, FocusStatus, ID, Instant, LocalDate } from "./types";
import { GAP_RESOLUTIONS, isRecord } from "./types";
import { instantDay, instantOf, isInstant } from "./time";
import { compareSortKeys } from "./sortKey";

// The focus state machine. Pure: no obsidian, no
// timers. `now` is always passed in, and every function returns a new timer.

export type FocusPhase = "focus" | "short-break" | "long-break";
export interface FocusSetConfig {
	rounds: number;
	focusSec: number;
	breakSec: number;
	longBreakSec: number;
}
export type FocusMoment = "focus-start" | "break-start" | "set-done";

export interface ActiveTimer {
	v: 1;
	/** The focus round's future record id; null in a break. */
	sessionId: ID | null;
	/** The id of this set; every round record carries it. */
	setId: ID;
	phase: FocusPhase;
	state: "running" | "paused";
	/** The recovery prompt is pending. */
	needsRecovery: boolean;
	/** 1-based. */
	round: number;
	config: FocusSetConfig;
	taskId: ID | null;
	taskTitleSnapshot: string;
	/** This phase. */
	plannedSec: number;
	/** This phase; the last may be open. */
	segments: { start: Instant; end: Instant | null }[];
	/** This focus round. */
	unobserved: FocusGap[];
	splitFrom: ID | null;
	/** This phase. */
	startedAt: Instant;
	lastHeartbeat: Instant;
	/** Rounds completed in this set. */
	completedFocusCount: number;
	/** Finalized focus in this set, for the summary. */
	setFocusedSec: number;
}

export type FocusEffect =
	/** `manual`: the user ended the round with Finish (the short-round rule applies to it; not to the last round of a set that already holds a saved round). */
	| { kind: "save"; session: FocusSession; manual?: true }
	| { kind: "moment"; moment: FocusMoment }
	| { kind: "recovery-needed" }
	| { kind: "set-done"; rounds: number; focusedSec: number };

export interface Step {
	timer: ActiveTimer | null;
	effects: FocusEffect[];
}

type TaskRef = { id: ID; title: string };
type NewId = () => ID;

/**
 * A tick this long after the previous one means the device slept or the app was frozen. 90 s, not 60:
 * Chromium's intensive timer throttling wakes a hidden window about once a minute.
 */
const GAP_MS = 90_000;
/** A clock that goes back by more than this re-anchors the running segment. */
const BACKWARDS_MS = 5_000;

const ms = (t: Instant): number => Date.parse(t);

function plannedMs(t: ActiveTimer): number {
	return t.plannedSec * 1000;
}

/** Observed time of this phase; only a running timer has an open segment. */
function elapsedMs(t: ActiveTimer, nowMs: number): number {
	let sum = 0;
	for (const seg of t.segments) sum += Math.max(0, (seg.end === null ? nowMs : ms(seg.end)) - ms(seg.start));
	return sum;
}

function remainingMs(t: ActiveTimer, nowMs: number): number {
	return plannedMs(t) - elapsedMs(t, nowMs);
}

/** The instant the running phase reaches its planned length. */
function phaseEndMs(t: ActiveTimer): number {
	const open = t.segments.find((s) => s.end === null);
	if (open === undefined) return ms(t.lastHeartbeat);
	return ms(open.start) + (plannedMs(t) - elapsedMs({ ...t, segments: t.segments.filter((s) => s.end !== null) }, 0));
}

function closeSegments(t: ActiveTimer, endMs: number): { start: Instant; end: Instant }[] {
	return t.segments.map((s) => ({ start: s.start, end: s.end ?? instantOf(Math.max(ms(s.start), endMs)) }));
}

function openSegment(at: Instant): { start: Instant; end: Instant | null } {
	return { start: at, end: null };
}

function breakPhase(t: ActiveTimer): "short-break" | "long-break" {
	return t.config.rounds > 4 && t.round % 4 === 0 ? "long-break" : "short-break";
}

/** The record of the focus round, closed at `endMs`. A round with any unobserved gap is `recovered`. */
function finalize(t: ActiveTimer, base: FocusStatus, endMs: number, now: Instant, deviceId: string): FocusSession {
	return {
		id: t.sessionId ?? "",
		deviceId,
		taskId: t.taskId,
		taskTitleSnapshot: t.taskTitleSnapshot,
		plannedSec: t.plannedSec,
		status: t.unobserved.length > 0 ? "recovered" : base,
		segments: closeSegments(t, endMs),
		unobserved: t.unobserved.map((g) => ({ ...g })),
		splitFrom: t.splitFrom,
		setId: t.setId,
		setRounds: t.config.rounds,
		setRound: t.round,
		startedAt: t.startedAt,
		endedAt: instantOf(endMs),
		finalizedAt: now,
	};
}

/** What follows a finished focus round: the break, or the end of the set. */
function afterFocus(t: ActiveTimer, session: FocusSession, at: Instant, now: Instant, natural: boolean, manual = false): Step {
	const effects: FocusEffect[] = [manual ? { kind: "save", session, manual: true } : { kind: "save", session }];
	const setFocusedSec = t.setFocusedSec + focusedSec(session);
	if (t.round >= t.config.rounds) {
		effects.push({ kind: "moment", moment: "set-done" }, { kind: "set-done", rounds: t.round, focusedSec: setFocusedSec });
		return { timer: null, effects };
	}
	const phase = breakPhase(t);
	effects.push({ kind: "moment", moment: "break-start" });
	return {
		timer: {
			...t,
			sessionId: null,
			phase,
			state: "running",
			needsRecovery: false,
			plannedSec: phase === "long-break" ? t.config.longBreakSec : t.config.breakSec,
			segments: [openSegment(at)],
			unobserved: [],
			splitFrom: null,
			startedAt: at,
			lastHeartbeat: now,
			completedFocusCount: t.completedFocusCount + (natural ? 1 : 0),
			setFocusedSec,
		},
		effects,
	};
}

function afterBreak(t: ActiveTimer, at: Instant, now: Instant, newId: NewId): Step {
	return {
		timer: {
			...t,
			sessionId: newId(),
			phase: "focus",
			state: "running",
			needsRecovery: false,
			round: t.round + 1,
			plannedSec: t.config.focusSec,
			segments: [openSegment(at)],
			unobserved: [],
			splitFrom: null,
			startedAt: at,
			lastHeartbeat: now,
		},
		effects: [{ kind: "moment", moment: "focus-start" }],
	};
}

export function startSet(config: FocusSetConfig, task: TaskRef | null, now: Instant, newId: NewId): Step {
	const sessionId = newId();
	return {
		timer: {
			v: 1,
			sessionId,
			setId: newId(),
			phase: "focus",
			state: "running",
			needsRecovery: false,
			round: 1,
			config: { ...config },
			taskId: task?.id ?? null,
			taskTitleSnapshot: task?.title ?? "",
			plannedSec: config.focusSec,
			segments: [openSegment(now)],
			unobserved: [],
			splitFrom: null,
			startedAt: now,
			lastHeartbeat: now,
			completedFocusCount: 0,
			setFocusedSec: 0,
		},
		effects: [{ kind: "moment", moment: "focus-start" }],
	};
}

export function pause(t: ActiveTimer, now: Instant): Step {
	if (t.state !== "running") return { timer: t, effects: [] };
	return { timer: { ...t, state: "paused", segments: closeSegments(t, ms(now)), lastHeartbeat: now }, effects: [] };
}

export function resume(t: ActiveTimer, now: Instant): Step {
	// A pending recovery prompt is answered with resolveRecovery, not resume.
	if (t.state !== "paused" || t.needsRecovery) return { timer: t, effects: [] };
	return { timer: { ...t, state: "running", segments: [...t.segments, openSegment(now)], lastHeartbeat: now }, effects: [] };
}

export function skip(t: ActiveTimer, now: Instant, deviceId: string, newId: NewId): Step {
	if (t.phase !== "focus") return afterBreak(t, now, now, newId);
	return afterFocus(t, finalize(t, "stopped", ms(now), now, deviceId), now, now, false);
}

/**
 * Finish: ends the focus round now as `completed` with its real seconds and moves the set on exactly as
 * a natural end does (break, next round or done). Nothing happens in a break or while a prompt waits.
 */
export function finish(t: ActiveTimer, now: Instant, deviceId: string, _newId: NewId): Step {
	if (t.phase !== "focus" || t.needsRecovery) return { timer: t, effects: [] };
	// The last round completes the set, so a short Finish of it is not dropped, but only when the set
	// already holds a saved round: a set with nothing saved would otherwise keep a record of a few seconds.
	const completesSet = t.round >= t.config.rounds && t.setFocusedSec > 0;
	return afterFocus(t, finalize(t, "completed", ms(now), now, deviceId), now, now, true, !completesSet);
}

export function stop(t: ActiveTimer, now: Instant, deviceId: string): Step {
	if (t.phase !== "focus") return { timer: null, effects: [] };
	return { timer: null, effects: [{ kind: "save", session: finalize(t, "stopped", ms(now), now, deviceId) }] };
}

/** Closes the open segment at the last heartbeat and asks what to do with the gap. */
function interrupt(t: ActiveTimer, now: Instant): Step {
	const hb = Math.min(ms(t.lastHeartbeat), ms(now));
	const gap: FocusGap[] =
		t.phase === "focus" && ms(now) > hb ? [{ start: instantOf(hb), end: now, resolution: "pending" }] : [];
	return {
		timer: {
			...t,
			state: "paused",
			needsRecovery: true,
			segments: closeSegments(t, hb),
			unobserved: [...t.unobserved, ...gap],
			lastHeartbeat: now,
		},
		effects: [{ kind: "recovery-needed" }],
	};
}

export function tick(t: ActiveTimer, now: Instant, deviceId: string, newId: NewId): Step {
	if (t.state !== "running") return { timer: t, effects: [] };
	const nowMs = ms(now);
	const hbMs = ms(t.lastHeartbeat);
	if (nowMs - hbMs > GAP_MS) return interrupt(t, now);
	if (hbMs - nowMs > BACKWARDS_MS) {
		// The clock went back. Close the segment at the last tick and open a new one, so nothing is uncounted.
		return {
			timer: { ...t, segments: [...closeSegments(t, hbMs), openSegment(now)], lastHeartbeat: now },
			effects: [],
		};
	}
	const effects: FocusEffect[] = [];
	let cur: ActiveTimer | null = t;
	while (cur !== null && remainingMs(cur, nowMs) <= 0) {
		const endMs = phaseEndMs(cur);
		const next: Step =
			cur.phase === "focus"
				? afterFocus(cur, finalize(cur, "completed", endMs, now, deviceId), instantOf(endMs), now, true)
				: afterBreak(cur, instantOf(endMs), now, newId);
		effects.push(...next.effects);
		cur = next.timer;
	}
	return { timer: cur === null ? null : { ...cur, lastHeartbeat: now }, effects };
}

export function recoverOnLoad(t: ActiveTimer, now: Instant): Step {
	if (t.state !== "running") return { timer: t, effects: [] };
	return interrupt(t, now);
}

export function resolveRecovery(t: ActiveTimer, choice: "resume" | "finish" | "discard", now: Instant, deviceId: string): Step {
	if (!t.needsRecovery) return { timer: t, effects: [] };
	if (choice === "discard") return { timer: null, effects: [] };
	if (choice === "resume") {
		return {
			timer: { ...t, state: "running", needsRecovery: false, segments: [...t.segments, openSegment(now)], lastHeartbeat: now },
			effects: [],
		};
	}
	if (t.phase !== "focus") return { timer: null, effects: [] };
	return { timer: null, effects: [{ kind: "save", session: finalize(t, "recovered", ms(now), now, deviceId) }] };
}

/** Split: A is finalized as `split` now; B continues with the same phase end. */
export function split(t: ActiveTimer, task: TaskRef | null, now: Instant, deviceId: string, newId: NewId): Step {
	const session = finalize(t, "split", ms(now), now, deviceId);
	const running = t.state === "running";
	return {
		timer: {
			...t,
			sessionId: newId(),
			needsRecovery: false,
			taskId: task?.id ?? null,
			taskTitleSnapshot: task?.title ?? "",
			plannedSec: Math.max(1, Math.ceil(remainingMs(t, ms(now)) / 1000)),
			segments: running ? [openSegment(now)] : [],
			unobserved: [],
			splitFrom: t.sessionId,
			startedAt: now,
			lastHeartbeat: now,
			setFocusedSec: t.setFocusedSec + focusedSec(session),
		},
		effects: [{ kind: "save", session }],
	};
}

export function reassign(t: ActiveTimer, task: TaskRef | null): Step {
	return { timer: { ...t, taskId: task?.id ?? null, taskTitleSnapshot: task?.title ?? "" }, effects: [] };
}

export function remainingSec(t: ActiveTimer, now: Instant): number {
	return Math.max(0, Math.ceil(remainingMs(t, ms(now)) / 1000));
}

/** Σ segments + Σ included gaps. Derived, never stored. */
export function focusedSec(s: FocusSession): number {
	let sum = 0;
	for (const seg of s.segments) sum += Math.max(0, ms(seg.end) - ms(seg.start));
	for (const gap of s.unobserved) if (gap.resolution === "included") sum += Math.max(0, ms(gap.end) - ms(gap.start));
	return Math.round(sum / 1000);
}

/**
 * A completed round whose focus is below its plan. Derived, never stored. One second of slack, because
 * a split continuation plans the rounded-up remainder.
 */
export function isFinishedEarly(s: FocusSession): boolean {
	return s.status === "completed" && focusedSec(s) + 1 < s.plannedSec;
}

/** A task's total sums its own sessions; sessions with no task are left out. */
export function taskFocusTotals(sessions: Iterable<FocusSession>): Map<ID, number> {
	const totals = new Map<ID, number>();
	for (const s of sessions) if (s.taskId !== null) totals.set(s.taskId, (totals.get(s.taskId) ?? 0) + focusedSec(s));
	return totals;
}

function dayOf(instant: Instant, zone: string): LocalDate {
	return instantDay(instant, zone) ?? "";
}

/** A pomo is a completed round with at least this much focus; shorter completed rounds only add time. */
const POMO_MIN_SEC = 60;

/** Pomo counts include only completed rounds of at least a minute; the time sums every session. */
export function focusOverview(
	sessions: Iterable<FocusSession>,
	today: LocalDate,
	zone: string,
): { todayCount: number; todaySec: number; totalCount: number; totalSec: number } {
	const out = { todayCount: 0, todaySec: 0, totalCount: 0, totalSec: 0 };
	for (const s of sessions) {
		const sec = focusedSec(s);
		const pomo = s.status === "completed" && sec >= POMO_MIN_SEC ? 1 : 0;
		out.totalCount += pomo;
		out.totalSec += sec;
		if (dayOf(s.startedAt, zone) === today) {
			out.todayCount += pomo;
			out.todaySec += sec;
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// The history tree: day, then focus set, then round.

export interface FocusRound {
	session: FocusSession;
	/** 1-based within the set: the stored `setRound`, else counted; a split round and its continuation share a number. */
	number: number;
}

export type FocusSetEnd = "done" | "stopped" | "recovered" | "active";

export interface FocusSetNode {
	/** Stable key for folding: the set id, or `solo:<record id>` for a record without one. */
	key: string;
	setId: ID | null;
	/** Oldest first. */
	rounds: FocusRound[];
	roundCount: number;
	/** The planned rounds, when the records say. */
	plannedRounds: number | null;
	startedAt: Instant;
	endedAt: Instant;
	totalSec: number;
	/** True when the rounds of the set have different tasks (Split or Reassign). */
	mixedTasks: boolean;
	end: FocusSetEnd;
	/** The number of the last round, for "stopped after round n". */
	endedAfter: number;
}

export interface FocusDayNode {
	day: LocalDate;
	totalSec: number;
	sets: FocusSetNode[];
}

function buildSet(key: string, setId: ID | null, list: FocusSession[], activeSetId: ID | null): FocusSetNode {
	const sorted = [...list].sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : 1));
	const ids = new Set(sorted.map((s) => s.id));
	let counted = 0;
	const rounds = sorted.map((session) => {
		// A continuation after a Split belongs to the round of the part it continues.
		if (session.splitFrom === null || !ids.has(session.splitFrom)) counted++;
		return { session, number: session.setRound ?? counted };
	});
	// Rounds reached, not records kept: a round dropped as short or deleted still counts ("4 of 4").
	const roundCount = Math.max(...rounds.map((r) => r.number));
	const last = rounds[rounds.length - 1]!;
	const planned = sorted.find((s) => s.setRounds !== undefined)?.setRounds ?? null;
	let end: FocusSetEnd;
	if (setId !== null && setId === activeSetId) end = "active";
	else if (last.session.status === "recovered") end = "recovered";
	else if (last.session.status === "completed" && (planned === null || last.number >= planned)) end = "done";
	else end = "stopped";
	return {
		key,
		setId,
		rounds,
		roundCount,
		plannedRounds: planned,
		startedAt: sorted[0]!.startedAt,
		endedAt: sorted.reduce((max, s) => (s.endedAt > max ? s.endedAt : max), sorted[0]!.endedAt),
		totalSec: sorted.reduce((sum, s) => sum + focusedSec(s), 0),
		mixedTasks: sorted.some((s) => s.taskId !== sorted[0]!.taskId),
		end,
		endedAfter: last.number,
	};
}

/**
 * Days newest first (by the day a set started in the display zone); in a day the sets run oldest first,
 * each with its rounds. A record without a set id is a set of one. `activeSetId` marks the
 * set whose timer is still running.
 */
export function focusHistoryTree(sessions: Iterable<FocusSession>, zone: string, activeSetId: ID | null = null): FocusDayNode[] {
	const groups = new Map<string, { setId: ID | null; list: FocusSession[] }>();
	for (const s of sessions) {
		const key = s.setId === undefined ? `solo:${s.id}` : s.setId;
		const g = groups.get(key);
		if (g === undefined) groups.set(key, { setId: s.setId ?? null, list: [s] });
		else g.list.push(s);
	}
	const byDay = new Map<LocalDate, FocusSetNode[]>();
	for (const [key, g] of groups) {
		const node = buildSet(key, g.setId, g.list, activeSetId);
		const day = dayOf(node.startedAt, zone);
		const list = byDay.get(day);
		if (list === undefined) byDay.set(day, [node]);
		else list.push(node);
	}
	return [...byDay.entries()]
		.sort((a, b) => compareSortKeys(b[0], a[0]))
		.map(([day, sets]) => ({
			day,
			totalSec: sets.reduce((sum, x) => sum + x.totalSec, 0),
			sets: sets.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.key < b.key ? -1 : 1)),
		}));
}

// ---------------------------------------------------------------------------
// Reading a stored timer

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPos = (v: unknown): v is number => isNum(v) && v > 0;

/** Reads a stored timer of unknown shape; anything unreadable or of another `v` is no timer. */
export function parseActiveTimer(raw: unknown): ActiveTimer | null {
	if (!isRecord(raw) || raw.v !== 1) return null;
	const phase = raw.phase;
	if (phase !== "focus" && phase !== "short-break" && phase !== "long-break") return null;
	const state = raw.state;
	if (state !== "running" && state !== "paused") return null;
	const c = raw.config;
	if (!isRecord(c) || !isPos(c.rounds) || !isPos(c.focusSec) || !isPos(c.breakSec) || !isPos(c.longBreakSec)) return null;
	const sessionId = raw.sessionId;
	if (phase === "focus" ? !isStr(sessionId) || sessionId.length === 0 : sessionId !== null) return null;
	if (typeof raw.needsRecovery !== "boolean") return null;
	if (!isNum(raw.round) || !Number.isInteger(raw.round) || raw.round < 1) return null;
	if (raw.taskId !== null && !isStr(raw.taskId)) return null;
	if (!isStr(raw.taskTitleSnapshot) || !isPos(raw.plannedSec)) return null;
	if (raw.splitFrom !== null && !isStr(raw.splitFrom)) return null;
	if (!isInstant(raw.startedAt) || !isInstant(raw.lastHeartbeat)) return null;
	if (!isNum(raw.completedFocusCount) || !isNum(raw.setFocusedSec)) return null;
	// A timer saved by an older version has no set id; a stable stand-in keeps its remaining rounds together.
	const setId = isStr(raw.setId) && raw.setId.length > 0 ? raw.setId : `legacy-${isStr(sessionId) ? sessionId : String(raw.startedAt)}`;
	if (!Array.isArray(raw.segments) || !Array.isArray(raw.unobserved)) return null;
	const segments: ActiveTimer["segments"] = [];
	for (const s of raw.segments) {
		if (!isRecord(s) || !isInstant(s.start) || (s.end !== null && !isInstant(s.end))) return null;
		segments.push({ start: s.start, end: s.end });
	}
	const unobserved: FocusGap[] = [];
	for (const g of raw.unobserved) {
		if (!isRecord(g) || !isInstant(g.start) || !isInstant(g.end)) return null;
		if (!(GAP_RESOLUTIONS as readonly unknown[]).includes(g.resolution)) return null;
		unobserved.push({ start: g.start, end: g.end, resolution: g.resolution as FocusGap["resolution"] });
	}
	return {
		v: 1,
		sessionId: sessionId as string | null,
		setId,
		phase,
		state,
		needsRecovery: raw.needsRecovery,
		round: raw.round,
		config: { rounds: c.rounds, focusSec: c.focusSec, breakSec: c.breakSec, longBreakSec: c.longBreakSec },
		taskId: raw.taskId,
		taskTitleSnapshot: raw.taskTitleSnapshot,
		plannedSec: raw.plannedSec,
		segments,
		unobserved,
		splitFrom: raw.splitFrom,
		startedAt: raw.startedAt,
		lastHeartbeat: raw.lastHeartbeat,
		completedFocusCount: raw.completedFocusCount,
		setFocusedSec: raw.setFocusedSec,
	};
}
