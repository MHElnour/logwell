import { DateTime } from "luxon";
import { isFinishedEarly } from "../../domain/focus";
import { plural } from "../../domain/text";
import { clockTimeOf } from "../../domain/time";
import type { FocusGap, FocusSession, Instant } from "../../domain/types";
import { formatDuration, pad2 } from "../format";

// Display text for the Focus page and the focus chips.

/** The timer face: "24:59", or "1:05:00" from one hour up. */
export function clockText(sec: number): string {
	const s = Math.max(0, Math.round(sec));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const rest = pad2(s % 60);
	return h > 0 ? `${h}:${pad2(m)}:${rest}` : `${m}:${rest}`;
}

/** Focused time as the chips and the overview show it: "45s", "25m", "1h 15m". */
export function focusedText(sec: number): string {
	if (sec < 60) return `${Math.max(0, Math.round(sec))}s`;
	return formatDuration(Math.floor(sec / 60));
}

/** "1 round", "4 rounds". */
export function roundsText(n: number): string {
	return plural(n, "round");
}

/** The set-done summary: "4 rounds · 2h focused". */
export function summaryText(rounds: number, focusedSec: number): string {
	return `${roundsText(rounds)} · ${focusedText(focusedSec)} focused`;
}

/** "09:30–09:55" in the display zone; `separator` goes between the two times. */
export function timeRange(session: Pick<FocusSession, "startedAt" | "endedAt">, zone: string, separator = "–"): string {
	const hm = (at: Instant) => clockTimeOf(DateTime.fromISO(at, { zone }));
	return `${hm(session.startedAt)}${separator}${hm(session.endedAt)}`;
}

export function gapSec(gap: FocusGap): number {
	return Math.round((Date.parse(gap.end) - Date.parse(gap.start)) / 1000);
}

/** The status of a round in words; a completed round that fell short of its plan reads "Finished early". */
export function roundStatusText(s: FocusSession): string {
	switch (s.status) {
		case "completed":
			return isFinishedEarly(s) ? "Finished early" : "Completed";
		case "stopped":
			return "Stopped early";
		case "interrupted":
			return "Interrupted";
		case "recovered":
			return "Recovered";
		case "split":
			return "Split to another task";
	}
}

/** The dot of a round: filled accent, half for finished early, hollow grey for stopped or split, yellow for recovered. */
export function dotClass(s: FocusSession): string {
	if (s.status === "recovered") return "is-recovered";
	if (s.status === "completed") return isFinishedEarly(s) ? "is-early" : "is-completed";
	return "is-stopped";
}
