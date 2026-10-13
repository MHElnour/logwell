import { periodsAfter, plainRule, repeatEndProblem, seriesAnchor, singleVersionRecurrence } from "../domain/recurrence";
import type { LocalDate, RepeatFreq, RepeatRule, WeekStart } from "../domain/types";
import { addDays, dateSpecDate } from "../domain/time";
import { NOTICE, type Draft, draft } from "./chipDraft";
import { rollEnd, rollsPastYear, type DateCandidate, type RollKind } from "./dates";
import type { Chip } from "./types";

// Binding a typed repeat's start and end parts to it, once every chip is known. The repeat picked by hand is an
// explicit input (`pickedEnd`, `pickedRule`, `picked`), never read from the parse context here.

/**
 * Where start and end parts of a repeat begin: right after the first typed repeat that stays (`typedEnds`, the ends of
 * those repeats); anywhere for a repeat picked by hand (`picked`); else nowhere (`inputLength + 1`). Before the first
 * typed repeat they read as without a repeat. A "Never" picked by hand is no repeat: the caller passes `picked` false.
 */
export function partsStart(typedEnds: readonly number[], picked: boolean, inputLength: number): number {
	return typedEnds.length > 0 ? Math.min(...typedEnds) : picked ? 0 : inputLength + 1;
}

/** The chip of a date led by `until`, `ending` or `ends on` while a repeat is typed: the repeat's end date. */
export function endDraft(input: string, c: DateCandidate, zone: string): Draft {
	const o = c.outcome;
	// A choice ("until friday" said on a Friday, "until 5") takes the later date.
	const value = o.status === "choice" ? o.alternatives[o.alternatives.length - 1]!.value : o.date;
	const extra: Partial<Chip> = { end: { kind: "date", date: dateSpecDate(value, zone) } };
	if (o.status === "suggestion") extra.notice = NOTICE.useAsEndDate;
	return draft(input, "repeatEnd", c.span, o.status === "suggestion" ? "suggestion" : "applied", extra);
}

/** Any rule's first date is on or after its anchor; a daily rule's is the anchor itself. */
const FROM_ANCHOR: RepeatRule = plainRule("daily");

/**
 * "every year on <date>": the date read right after "on" is the start. It counts when applied or a choice to make, or
 * when a date picked by hand made it a "Replace date?" suggestion (`readDates`: the picked date is the start, and the
 * repeat applies). When none is read there (dismissed, weak or unreadable), the repeat is not supported: it would
 * otherwise start on today's month and day. A second start after it (`every year on May 5 from Oct 12`, which
 * superseded the first) is two starts: the repeat is not supported and no date applies (each is a "Use as date?"
 * offer). Returns the ids of starts that are still a choice (`May 5 at 7`): they block saving until chosen, so the
 * series is never anchored on today; not when a date picked by hand (`manualDate`) is the start.
 */
export function requireStartDate(chips: Chip[], startsOnDate: ReadonlySet<string>, readDates: ReadonlySet<string>, input: string, manualDate: boolean): string[] {
	const open: string[] = [];
	if (startsOnDate.size === 0) return open;
	const unsupported = (c: Chip): void => {
		c.status = "unsupported";
		c.notice = NOTICE.recurrence;
		delete c.rule;
		delete c.alternatives;
	};
	for (const c of chips) {
		if (!startsOnDate.has(c.id) || c.status === "unsupported") continue;
		let next = c.span.end;
		while (next < input.length && /\s/u.test(input.charAt(next))) next++;
		const start = chips.find((d) => d.kind === "scheduled" && d.span.start === next);
		if (start !== undefined && (start.status === "applied" || start.status === "choice" || (start.status === "suggestion" && readDates.has(start.id)))) {
			if (start.status === "choice" && !manualDate) open.push(start.id);
			continue;
		}
		unsupported(c);
		if (start?.status !== "superseded") continue;
		for (const d of chips) {
			if (d.kind !== "scheduled" || d.span.start < start.span.start || (d.status !== "applied" && d.status !== "superseded")) continue;
			d.status = "suggestion";
			d.notice = NOTICE.useAsDate;
		}
	}
	return open;
}

/**
 * A typed end with no typed repeat, for the repeat picked by hand (`pickedEnd`: that repeat has an end): it applies at once when that repeat has no end, and
 * is a "Replace repeat end?" suggestion when it has one. Either way the picked repeat stays (no manual precedence).
 */
export function pickedEndDraft(input: string, c: DateCandidate, zone: string, pickedEnd: boolean): Draft {
	const d = { ...endDraft(input, c, zone), field: null };
	if (pickedEnd && d.chip.status === "applied") {
		d.chip.status = "suggestion";
		d.chip.notice = NOTICE.replaceEnd;
	}
	return d;
}

/** The one day of a typed date whose alternatives differ only in the hour (`Sep 28 2026 at 5`); undefined otherwise. */
function choiceDay(chips: readonly Chip[], zone: string): LocalDate | undefined {
	const days = chips.find((c) => c.kind === "scheduled" && c.status === "choice")?.alternatives?.map((a) => (a.value === undefined ? null : dateSpecDate(a.value, zone)));
	const first = days?.[0];
	return first != null && days!.every((d) => d === first) ? first : undefined;
}

/**
 * Binds the end chips to the repeat once the start is known (the applied typed date; under a typed repeat, the day of
 * a typed date whose hour is a choice; else `start`: a date picked by hand, a preset or today): `for N <periods>`
 * becomes the day before N periods from the start; an end typed as a bare weekday or a month and day with no year
 * (`rolling`) that falls before the start moves past it as in a typed range (`rollEnd`), a suggestion when that is
 * more than a year on; an end that leaves the series no date is invalid (repeatEndProblem, the services' check),
 * against the typed repeat, else the one picked by hand, from the anchor a new series gets (`seriesAnchor`); an end
 * waits while its repeat's time is a choice; the end of a repeat Quick Add cannot build is not supported either.
 */
export function bindEnds(
	chips: Chip[],
	periods: ReadonlyMap<string, { n: number; freq: RepeatFreq }>,
	rolling: ReadonlyMap<string, RollKind>,
	env: { zone: string; start: LocalDate; weekStart: WeekStart; pickedRule?: RepeatRule },
): void {
	if (!chips.some((c) => c.kind === "repeatEnd")) return;
	const repeats = chips.filter((c) => c.kind === "recurrence");
	const rule = repeats.find((c) => c.status === "applied")?.rule;
	const waiting = rule === undefined && repeats.some((c) => c.status === "choice");
	const unsupported = repeats.length > 0 && repeats.every((c) => c.status === "unsupported");
	const date = chips.find((c) => c.kind === "scheduled" && c.status === "applied")?.date;
	const anchor = date === undefined ? (rule === undefined ? undefined : choiceDay(chips, env.zone)) ?? env.start : dateSpecDate(date, env.zone);
	// Without a known rule (none typed, none picked), only the anchor is checked, and the service checks the rest.
	const effective = rule ?? env.pickedRule ?? FROM_ANCHOR;
	const series = singleVersionRecurrence(seriesAnchor(anchor, effective), effective);
	for (const c of chips) {
		if (c.kind !== "repeatEnd") continue;
		const p = periods.get(c.id);
		if (p !== undefined) c.end = { kind: "date", date: addDays(periodsAfter(anchor, p.freq, p.n), -1) };
		// After a typed start, an end before it moves past it (as in a typed range); an end more than a year past the start
		// is a suggestion. A start picked by hand keeps the end as typed: before the start it is invalid.
		const roll = rolling.get(c.id);
		if (c.status === "applied" && c.end?.kind === "date" && roll !== undefined && date !== undefined) {
			const moved = rollEnd(c.end.date, anchor, roll);
			if (moved !== null) {
				c.end = { kind: "date", date: moved };
				if (rollsPastYear(anchor, moved)) {
					c.status = "suggestion";
					c.notice = NOTICE.useAsEndDate;
				}
			}
		}
		if (c.status !== "applied" && c.status !== "suggestion") continue;
		if (unsupported) {
			c.status = "unsupported";
			c.notice = NOTICE.recurrence;
		} else if (waiting) {
			c.status = "suggestion";
			c.notice = NOTICE.endWaits;
		} else if (c.status === "applied" && c.end !== undefined) {
			const problem = repeatEndProblem(c.end, series, env.weekStart);
			if (problem !== null) {
				c.status = "invalid";
				c.notice = problem;
			}
		}
	}
}
