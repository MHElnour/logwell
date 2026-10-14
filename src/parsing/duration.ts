import { MAX_DURATION_MIN } from "../domain/tasks";
import { isSpaceChar, LIST_SEP_PATTERN, scanFor, sticky } from "./text";

// "for <duration>". Matched by hand-written sticky regexes
// so a long input cannot cause catastrophic backtracking.

const MIN_DURATION = 1;

const UNIT = "(hours?|hrs?|h|minutes?|mins?|m)";
// A digit may follow a unit ("1h30m"); a letter may not ("5 meetings").
const NOT_LETTER = "(?![\\p{L}])";
const PART_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT}${NOT_LETTER}`, "iyu");
const AND_PART_RE = new RegExp(`(?:${LIST_SEP_PATTERN}|\\s*)(\\d+(?:\\.\\d+)?)\\s*${UNIT}${NOT_LETTER}`, "iyu");
const BARE_MINUTES_RE = /(\d{1,2})(?![\p{L}\p{N}.:])/yu;
const WORDS_RE = /(half\s+an?\s+hour|half\s+hour|an?\s+hour|an?\s+minute)(?![\p{L}\p{N}])/iyu;

export interface DurationMatch {
	/** End offset (exclusive) of the duration text. */
	end: number;
	/** Rounded minutes; may be outside 1..1440 (the caller reports it as invalid). */
	minutes: number;
}

function isHourUnit(unit: string): boolean {
	return unit.toLowerCase().startsWith("h");
}

/** Parses a duration that starts exactly at `from`. */
function matchDurationAt(s: string, from: number): DurationMatch | null {
	const words = sticky(WORDS_RE, s, from);
	if (words?.[1]) {
		const w = words[1].toLowerCase().replace(/\s+/g, " ");
		const minutes = w.startsWith("half") ? 30 : w.endsWith("hour") ? 60 : 1;
		return { end: from + words[0].length, minutes };
	}
	const first = sticky(PART_RE, s, from);
	if (!first?.[1] || !first[2]) return null;
	let total = Number(first[1]) * (isHourUnit(first[2]) ? 60 : 1);
	let end = from + first[0].length;
	if (isHourUnit(first[2])) {
		const second = sticky(AND_PART_RE, s, end);
		if (second?.[1] && second[2] && !isHourUnit(second[2])) {
			total += Number(second[1]);
			end += second[0].length;
		} else {
			// "1h30": minutes written directly after the hour unit.
			const bare = sticky(BARE_MINUTES_RE, s, end);
			if (bare?.[1]) {
				total += Number(bare[1]);
				end += bare[0].length;
			}
		}
	}
	return { end, minutes: Math.round(total) };
}

export function isValidDuration(minutes: number): boolean {
	return Number.isFinite(minutes) && minutes >= MIN_DURATION && minutes <= MAX_DURATION_MIN;
}

/** Finds `for <duration>` spans. `taken` returns true for a span that may not be used. */
export function findDurations(
	s: string,
	taken: (start: number, end: number) => boolean,
): { start: number; end: number; minutes: number }[] {
	return scanFor(
		s,
		0,
		(start) => {
			let i = start + 3;
			if (!isSpaceChar(s.charAt(i))) return null;
			while (i < s.length && isSpaceChar(s.charAt(i))) i++;
			const d = matchDurationAt(s, i);
			return d ? { start, end: d.end, minutes: d.minutes } : null;
		},
		(found) => found,
		taken,
	);
}
