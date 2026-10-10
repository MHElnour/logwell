import { type ActiveTimer, type FocusPhase, type FocusSetConfig, remainingSec } from "../../domain/focus";
import type { Instant } from "../../domain/types";
import { Icon } from "../common";
import type { UiHost } from "../host";
import { clockText, roundsText, summaryText } from "./format";

// The ring timer: time left, the phase, "Round n of N" and the round bars.

export const PHASE_LABEL: Record<FocusPhase, string> = { focus: "Focus", "short-break": "Short break", "long-break": "Long break" };

const RADIUS = 140;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * What the polite live region says. It depends on the phase, the round and the state only, never on
 * the seconds, so a screen reader hears a change of phase and nothing else.
 */
export function announcement(timer: ActiveTimer | null, summary: { rounds: number; focusedSec: number } | null): string {
	if (timer === null) return summary === null ? "" : `Set done. ${summaryText(summary.rounds, summary.focusedSec)}.`;
	const parts = [`${PHASE_LABEL[timer.phase]}, round ${timer.round} of ${timer.config.rounds}`];
	if (timer.needsRecovery) parts.push("interrupted, choose what to do");
	else if (timer.state === "paused") parts.push("paused");
	return parts.join(", ");
}

export function Ring(props: {
	host: UiHost;
	timer: ActiveTimer | null;
	now: Instant;
	idle: FocusSetConfig;
	summary: { rounds: number; focusedSec: number } | null;
}) {
	const { host, timer, now, idle, summary } = props;
	// A finished set (no timer, a summary) shows a full ring with a check instead of the time.
	const finishedSet = timer === null && summary !== null;
	const planned = timer === null ? idle.focusSec : timer.plannedSec;
	const left = timer === null ? idle.focusSec : remainingSec(timer, now);
	const elapsed = finishedSet ? 1 : planned > 0 ? Math.min(1, Math.max(0, 1 - left / planned)) : 0;
	const rounds = timer !== null ? timer.config.rounds : finishedSet ? summary.rounds : idle.rounds;
	// Rounds finished: all before the current focus round, or the current one once its break began.
	const finished = finishedSet ? rounds : timer === null ? 0 : timer.phase === "focus" ? timer.round - 1 : timer.round;
	const phase: FocusPhase = timer === null ? "focus" : timer.phase;
	const tone = phase === "focus" && !finishedSet ? "is-focus" : "is-break";
	const paused = timer?.state === "paused";
	const name = finishedSet ? "Set done" : timer === null ? "Ready" : paused ? "Paused" : PHASE_LABEL[phase];
	const round = timer !== null ? `Round ${timer.round} of ${rounds}` : finishedSet ? "" : roundsText(rounds);
	return (
		<div class={`cp-focus-ring-wrap ${tone}${paused ? " is-paused" : ""}${finishedSet ? " is-done" : ""}`}>
			<div class="cp-focus-ring">
				<svg viewBox="0 0 300 300" aria-hidden="true" focusable="false">
					<circle class="cp-focus-ring-track" cx="150" cy="150" r={RADIUS} />
					<circle
						class="cp-focus-ring-bar"
						cx="150"
						cy="150"
						r={RADIUS}
						stroke-dasharray={String(CIRCUMFERENCE)}
						stroke-dashoffset={String(CIRCUMFERENCE * (1 - elapsed))}
						transform="rotate(-90 150 150)"
					/>
				</svg>
				<div class="cp-focus-face">
					{finishedSet ? (
						<div class="cp-focus-check">
							<Icon host={host} icon="check" />
						</div>
					) : (
						<div class="cp-focus-time" role="timer">
							{clockText(left)}
						</div>
					)}
					<div class="cp-focus-phase-line">
						<span class="cp-focus-phase">{name}</span>
						{round !== "" && <span class="cp-focus-dim">·</span>}
						{round !== "" && <span class="cp-focus-round">{round}</span>}
					</div>
					<ol class="cp-focus-dots" aria-hidden="true">
						{Array.from({ length: rounds }, (_, i) => (
							<li
								key={i}
								class={`cp-focus-dot${i < finished ? " is-done" : ""}${timer !== null && phase === "focus" && i === finished ? " is-current" : ""}`}
								style={timer !== null && phase === "focus" && i === finished ? { "--cp-focus-fill": `${Math.round(elapsed * 100)}%` } : undefined}
							/>
						))}
					</ol>
				</div>
			</div>
			<div class="cp-sr-only" role="status" aria-live="polite">
				{announcement(timer, summary)}
			</div>
		</div>
	);
}
