import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import { LOCAL_FORMAT, addDays, isValidDateSpec, isValidLocalDate, pad2, resolveWallTime, type WallTimeWarning } from "../domain/time";
import type { DateSpec, LocalDate } from "../domain/types";
import { isSpaceChar, MASK_CHAR, wordBoundaryBefore } from "./text";
import type { DateLocale, Span } from "./types";

// Date and time recognition. chrono finds the spans and reports
// which components it is sure of; this file turns them into wall times in the
// configured zone with Luxon. chrono's own conversion to an instant is never
// used: it only knows fixed offsets, so a date across a DST change would get
// the wrong hour.

const DEFAULT_EVENING_TIME = "20:00";
const TONIGHT_RE = /\btonight\b/iu;
const STOP_LIST = new Set(["may", "sun", "sat", "march", "second", "now"]);
const BARE_DURATION_RE =
	/^(?:at\s+)?\d+(?:\.\d+)?\s*(?:h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?|d|days?|w|wks?|weeks?)$/iu;
const VAGUE_UNIT_RE = /^(?:the\s+)?(?:day|week|month|year)$/iu;
const DAY_PART_RE = /\b(?:noon|midnight|morning|afternoon|evening|night|tonight)\b/iu;
const SHIFT_WORD_RE = /\b(?:next|last|past|previous|coming)\b/iu;
// "0H:MM" with a leading-zero two-digit hour (01-09) is written 24-hour style and is certain.
// No lookbehind (iOS): the character before is matched and ignored.
const LEADING_ZERO_TIME_RE = /(?:^|[^\d:.])0[1-9]:[0-5]\d(?!\d)/u;
const PAST_WORD_RE = /^(?:last|past|previous)\b/iu;

export type DateOutcome =
	| { status: "applied" | "suggestion"; date: DateSpec; warning?: WallTimeWarning }
	| { status: "choice"; alternatives: { label: string; value: DateSpec }[] };

export interface DateCandidate {
	/** "end": a repeat's end (`until Dec 1`); the parser makes it a deadline when nothing repeats. */
	kind: "scheduled" | "deadline" | "end";
	/** Includes the lead word (LEADS) that directly precedes the date text. */
	span: Span;
	outcome: DateOutcome;
}

/** What a lead word directly before a date makes of it: a deadline, a joined time, a repeat end or the start. */
export type LeadKind = "deadline" | "time" | "end" | "schedule";

/**
 * The lead words before a date (Tasks and Quick Add rule 28, Repeating tasks rule 19), lower case, single spaces.
 * The span widens over the lead word; "time" joins only a date whose hour is certain.
 */
export const LEADS: readonly { words: string; kind: LeadKind }[] = [
	{ words: "by", kind: "deadline" },
	{ words: "at", kind: "time" },
	{ words: "until", kind: "end" },
	{ words: "till", kind: "end" },
	{ words: "ending on", kind: "end" },
	{ words: "ending", kind: "end" },
	{ words: "ends on", kind: "end" },
	{ words: "starting on", kind: "schedule" },
	{ words: "starting", kind: "schedule" },
	{ words: "starts on", kind: "schedule" },
	{ words: "beginning", kind: "schedule" },
];

/** The lead word that ends right before `index` (over spaces), the longest when several fit; null when none does. */
export function leadBefore(s: string, index: number): { start: number; kind: LeadKind } | null {
	let best: { start: number; kind: LeadKind } | null = null;
	for (const lead of LEADS) {
		let at = index;
		const words = lead.words.split(" ");
		for (let w = words.length - 1; w >= 0 && at !== -1; w--) at = wordBefore(s, at, words[w]!);
		if (at !== -1 && (best === null || at < best.start)) best = { start: at, kind: lead.kind };
	}
	return best;
}

export interface DateEnv {
	now: Date;
	zone: string;
	locale: DateLocale;
	/** What "tonight" means, "HH:mm" local time. */
	eveningTime?: string;
}

export interface Resolved {
	value: DateSpec;
	warning?: WallTimeWarning;
}

/** Applies the DST rules to a value. Null for a value that is not a real date or time. */
export function resolveDateSpec(spec: DateSpec): Resolved | null {
	if (!isValidDateSpec(spec)) return null;
	if (spec.kind === "date") return { value: { kind: "date", date: spec.date } };
	try {
		const r = resolveWallTime(spec.local, spec.tz);
		const value: DateSpec = { kind: "datetime", local: r.local, tz: spec.tz };
		return r.warning ? { value, warning: r.warning } : { value };
	} catch {
		return null;
	}
}

function isoDate(dt: DateTime): LocalDate | null {
	const d = dt.toISODate();
	return d !== null && isValidLocalDate(d) ? d : null;
}

function isWeakText(text: string): boolean {
	const t = text.trim();
	return STOP_LIST.has(t.toLowerCase()) || /^\d+$/u.test(t) || BARE_DURATION_RE.test(t) || VAGUE_UNIT_RE.test(t);
}

/** Looks backwards over whitespace for the word `word` directly before `index`. */
function wordBefore(s: string, index: number, word: string): number {
	let j = index;
	while (j > 0 && isSpaceChar(s.charAt(j - 1))) j--;
	if (j === index) return -1;
	const start = j - word.length;
	if (start < 0 || s.slice(start, j).toLowerCase() !== word) return -1;
	return wordBoundaryBefore(s, start) ? start : -1;
}

export function findDates(masked: string, env: DateEnv): DateCandidate[] {
	const zoneNow = DateTime.fromJSDate(env.now, { zone: env.zone });
	if (!zoneNow.isValid) throw new RangeError(`Invalid reference time or zone ${env.zone}`);
	const parser = env.locale === "en-GB" ? chrono.en.GB : chrono.en.casual;
	const results = parser.parse(masked, { instant: env.now, timezone: zoneNow.offset }, { forwardDate: true });
	const today = isoDate(zoneNow);
	const nowLocal = zoneNow.toFormat(LOCAL_FORMAT);
	if (today === null) throw new RangeError("Invalid reference date");
	const todayWeekday = zoneNow.weekday % 7; // 0 = Sunday, chrono's numbering

	const out: DateCandidate[] = [];
	for (const r of results) {
		// A span that reaches into a mask, or one introduced by "for" ("for 2 days" is not a date).
		if (r.text.includes(MASK_CHAR) || /^for\s/iu.test(r.text)) continue;
		const start = r.start;
		const dayCertain = start.isCertain("day") || start.isCertain("weekday");
		const hourCertain = start.isCertain("hour");
		const base = DateTime.fromObject(
			{ year: start.get("year") ?? 0, month: start.get("month") ?? 0, day: start.get("day") ?? 0 },
			{ zone: env.zone },
		);
		let date = base.isValid ? isoDate(base) : null;
		if (date === null) continue;
		const hour = start.get("hour") ?? 0;
		const minute = start.get("minute") ?? 0;
		const weekday = start.get("weekday");

		// chrono's forwardDate puts "last friday" in the future; take the most recent past one.
		let looksBack = false;
		if (PAST_WORD_RE.test(r.text) && start.isCertain("weekday") && !start.isCertain("day") && weekday !== null) {
			date = addDays(today, -(((todayWeekday - weekday + 7) % 7) || 7));
			looksBack = true;
		}

		const mkTime = (d: LocalDate, h: number): DateSpec => ({
			kind: "datetime",
			local: `${d}T${pad2(h)}:${pad2(minute)}`,
			tz: env.zone,
		});
		// "tonight" without a time of its own is today at the evening setting.
		const tonight = !hourCertain && TONIGHT_RE.test(r.text);
		const mkValue = (d: LocalDate): DateSpec =>
			hourCertain
				? mkTime(d, hour)
				: tonight
					? { kind: "datetime", local: `${d}T${env.eveningTime ?? DEFAULT_EVENING_TIME}`, tz: env.zone }
					: { kind: "date", date: d };

		let outcome: DateOutcome | null = null;
		const lowConfidence = r.end != null || isWeakText(r.text) || (!dayCertain && !hourCertain) || looksBack;
		const meridiemKnown = start.isCertain("meridiem") || DAY_PART_RE.test(r.text) || LEADING_ZERO_TIME_RE.test(r.text);
		if (lowConfidence) {
			const res = resolveDateSpec(mkValue(date));
			if (!res) continue;
			outcome = res.warning
				? { status: "suggestion", date: res.value, warning: res.warning }
				: { status: "suggestion", date: res.value };
		} else if (hourCertain && hour >= 1 && hour <= 12 && !meridiemKnown) {
			// "at 5": 05:00 or 17:00. Without a certain day, each alternative is the next such time.
			const alt = (h: number): { label: string; value: DateSpec } => {
				let d = date;
				if (!dayCertain) {
					d = today;
					if (`${d}T${pad2(h)}:${pad2(minute)}` <= nowLocal) d = addDays(today, 1);
				}
				return { label: `${pad2(h)}:${pad2(minute)}`, value: mkTime(d, h) };
			};
			// Hour 12 lists noon before midnight, so the preselected option is 12:00.
			outcome = { status: "choice", alternatives: hour === 12 ? [alt(12), alt(0)] : [alt(hour), alt(hour + 12)] };
		} else if (
			!hourCertain &&
			start.isCertain("weekday") &&
			!start.isCertain("day") &&
			!SHIFT_WORD_RE.test(r.text) &&
			weekday === todayWeekday
		) {
			// A weekday said on that weekday. chrono answers today or next week depending on the time of
			// day (it implies noon), so the answer is never trusted: the user chooses.
			outcome = {
				status: "choice",
				alternatives: [
					{ label: "Today", value: { kind: "date", date: today } },
					{ label: "Next week", value: { kind: "date", date: addDays(today, 7) } },
				],
			};
		} else {
			const res = resolveDateSpec(mkValue(date));
			if (!res) continue;
			outcome = res.warning
				? { status: "applied", date: res.value, warning: res.warning }
				: { status: "applied", date: res.value };
		}

		// The span: chrono's text, widened over a directly preceding lead word (LEADS).
		let spanStart = r.index;
		let kind: DateCandidate["kind"] = "scheduled";
		const lead = leadBefore(masked, spanStart);
		if (lead !== null && (lead.kind !== "time" || hourCertain)) {
			spanStart = lead.start;
			if (lead.kind === "deadline" || lead.kind === "end") kind = lead.kind;
		} else if (/^by\s/iu.test(masked.slice(spanStart, spanStart + 3))) {
			kind = "deadline";
		}
		out.push({ kind, span: { start: spanStart, end: r.index + r.text.length }, outcome });
	}
	return out;
}
