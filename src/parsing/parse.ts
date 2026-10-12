import { DateTime } from "luxon";
import { periodsAfter, repeatEndProblem, singleVersionRecurrence } from "../domain/recurrence";
import type { LocalDate, RepeatFreq, RepeatRule, WeekStart } from "../domain/types";
import { resolveListName } from "../domain/tasks";
import { collapseWhitespace } from "../domain/text";
import { addDays, dateSpecDate } from "../domain/time";
import { TagNames, hasAllowedTagDepth, hasRepeatedTagName, isValidTagKey, normalizeTagKey, resolveTagName, tagPrefixes } from "../domain/tags";
import { findDates, resolveDateSpec, todayOf, type DateCandidate, type DateOutcome } from "./dates";
import { isValidDuration } from "./duration";
import { tokenAtCursor } from "./cursor";
import { rebaseDecisions } from "./rebase";
import { parseRepeatText } from "./recurrence";
import { MASK_CHAR, isWordChar } from "./text";
import { findDurationTokens, findNoteTokens, findPriorityTokens, findRecurrence, findRepeatCounts, findWordTokens, type RepeatCount } from "./tokens";
import type {
	Chip,
	ChipKind,
	ParseContext,
	ParsedField,
	ParsedFields,
	ParseResult,
	Span,
	SpanDecision,
} from "./types";

export { rebaseDecisions, tokenAtCursor };

// The Quick Add parser. Pipeline:
//   1. plugin tokens ([[note]], #category, @tag, every …, for <duration>) and
//      the spans bound by decisions are found and masked;
//   2. chrono reads the masked text, and `by` turns its span into a deadline;
//   3. each span becomes a chip: applied, suggestion, choice, unresolved …;
//   4. manual fields and one-value-per-field rules are applied;
//   5. the title is the input without the applied spans.

const NOTICE = {
	superseded: "Replaced by a later value",
	useAsDate: "Use as date?",
	useAsEndDate: "Use as end date?",
	endWaits: "Applies once the repeat's time is chosen",
	replaceEnd: "Replace repeat end?",
	recurrence: "Recurrence not supported yet",
	duration: "Duration must be 1 to 1440 minutes",
} as const;

const REPLACE_NOTICE: Record<string, string> = {
	scheduled: "Replace date?",
	deadline: "Replace deadline?",
	duration: "Replace duration?",
	category: "Replace list?",
	note: "Replace note?",
	priority: "Replace priority?",
	recurrence: "Replace repeat?",
	repeatEnd: "Replace repeat?",
};

const FIELD_OF: Record<string, ParsedField> = {
	scheduled: "scheduled",
	deadline: "deadline",
	duration: "duration",
	category: "category",
	note: "note",
	priority: "priority",
	recurrence: "recurrence",
	repeatEnd: "recurrence",
	tag: "tags",
};

function overlaps(a: Span, b: Span): boolean {
	return a.start < b.end && b.start < a.end;
}

function chipId(kind: ChipKind, span: Span): string {
	return `${kind}:${span.start}:${span.end}`;
}

interface Decisions {
	literal: Span[];
	bound: Extract<SpanDecision, { kind: "category" | "tag" | "note" }>[];
	byChip: Map<string, SpanDecision>;
}

/** Keeps the decisions that still match the input, the last one per span. */
function usableDecisions(input: string, ctx: ParseContext): Decisions {
	const latest = new Map<string, SpanDecision>();
	for (const d of ctx.decisions) {
		const { start, end } = d.span;
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > input.length) continue;
		if (input.slice(start, end) !== d.text) continue;
		latest.set(`${start}:${end}`, d);
	}
	const categoryIds = new Set(ctx.categories.map((c) => c.id));
	const tagKeys = new Set(ctx.tags.map((t) => normalizeTagKey(t.key)));
	const literal: Span[] = [];
	const boundAll: Decisions["bound"] = [];
	const byChip = new Map<string, SpanDecision>();
	for (const d of latest.values()) {
		if (d.kind === "literal") literal.push(d.span);
		else if (d.kind === "category") {
			if (categoryIds.has(d.categoryId)) boundAll.push(d);
		} else if (d.kind === "tag") {
			// A tag deleted since the binding is not bound any more: the span is recognized again (a new tag).
			const key = normalizeTagKey(d.key);
			if (tagKeys.has(key)) boundAll.push(d);
		} else if (d.kind === "note") boundAll.push(d);
		else byChip.set(`${d.span.start}:${d.span.end}`, d);
	}
	const bound: Decisions["bound"] = [];
	for (const d of boundAll.sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end)) {
		if (literal.some((l) => overlaps(l, d.span))) continue;
		const last = bound.at(-1);
		if (last && overlaps(last.span, d.span)) continue;
		bound.push(d);
	}
	return { literal, bound, byChip };
}

interface Draft {
	chip: Chip;
	/** Whether the chip counts as applied before manual fields and decisions are considered. */
	field: ParsedField | null;
}

function plainResult(input: string): ParseResult {
	const collapsed = collapseWhitespace(input);
	return {
		input,
		chips: [],
		title: collapsed === "" ? input : collapsed,
		titleFallback: false,
		fields: { tagKeys: [], newTags: [] },
		blocking: [],
	};
}

/** The parser without its safety net. Tests call this directly so a bug cannot hide behind the guard. */
export function parseUnguarded(input: string, ctx: ParseContext): ParseResult {
	const zoneNow = DateTime.fromJSDate(ctx.now, { zone: ctx.zone });
	if (!zoneNow.isValid) throw new RangeError(`Invalid reference time or zone ${ctx.zone}`);
	const today = todayOf(zoneNow);

	const decisions = usableDecisions(input, ctx);
	const taken: Span[] = [...decisions.literal, ...decisions.bound.map((d) => d.span)];
	const isTaken = (start: number, end: number): boolean => taken.some((t) => t.start < end && start < t.end);
	const take = (span: Span): void => {
		taken.push(span);
	};

	const drafts: Draft[] = [];

	// Bound spans first: they define a token even when it contains spaces.
	for (const d of decisions.bound) {
		if (d.kind === "category") {
			drafts.push(draft(input, "category", d.span, "applied", { categoryId: d.categoryId }));
		} else if (d.kind === "tag") {
			drafts.push(draft(input, "tag", d.span, "applied", { tagKey: d.key }));
		} else {
			drafts.push(draft(input, "note", d.span, "applied", { notePath: d.path }));
		}
	}

	for (const t of findNoteTokens(input, isTaken)) {
		take(t.span);
		let matches: string[] = [];
		try {
			matches = ctx.resolveNote(t.linktext);
		} catch {
			matches = [];
		}
		if (matches.length === 1 && matches[0] !== undefined) {
			drafts.push(draft(input, "note", t.span, "applied", { notePath: matches[0] }));
		} else if (matches.length > 1) {
			drafts.push(draft(input, "note", t.span, "collision", { candidates: [...matches], notice: `${matches.length} matches` }));
		} else {
			drafts.push(draft(input, "note", t.span, "missing", { notice: `No note named ${t.linktext}` }));
		}
	}

	// A token of digits only ("Fix bug #42", "@5") is not a token unless it names something that
	// exists, so ticket numbers never block saving or disappear from the title.
	const digitsOnly = (name: string): boolean => /^\d+$/u.test(name);
	const categoryExists = (name: string): boolean => resolveListName(ctx.categories, name).kind !== "none";
	for (const t of findWordTokens(input, "#", isTaken, (name) => !digitsOnly(name) || categoryExists(name))) {
		take(t.span);
		const match = resolveListName(ctx.categories, t.name);
		if (match.kind === "one") drafts.push(draft(input, "category", t.span, "applied", { categoryId: match.list.id }));
		else {
			const notice = match.kind === "several" ? `\u201c${t.name}\u201d matches several lists. Use the exact name.` : `No list named ${t.name}`;
			drafts.push(draft(input, "category", t.span, "unresolved", { notice }));
		}
	}

	// The names in use: the existing tags, then each new tag this input accepts, in order. Built when a tag is not found by its key.
	let tagNames: TagNames | null = null;
	const namesOfTags = (): TagNames => (tagNames ??= TagNames.of(ctx.tags.map((x) => ({ key: normalizeTagKey(x.key), createdAt: x.createdAt ?? "" }))));
	// The existing tag a typed name stands for: its full key, or its name alone (`@calls` for `home/calls`).
	const tagFor = (key: string): ParseContext["tags"][number] | undefined => {
		const resolved = resolveTagName(namesOfTags(), key);
		return resolved === null ? undefined : ctx.tags.find((x) => normalizeTagKey(x.key) === resolved);
	};
	for (const t of findWordTokens(input, "@", isTaken, (name) => {
		const key = normalizeTagKey(name);
		if (!isValidTagKey(key)) return false;
		// A key too deep to create is not a token (it stays in the title) unless the tag already exists.
		// So is a new key whose name another tag (or an earlier new tag of this input) already uses
		// under another parent, or that repeats its parent's name.
		if (tagFor(key) !== undefined) return true;
		if (digitsOnly(key) || !hasAllowedTagDepth(key) || hasRepeatedTagName(key)) return false;
		const names = namesOfTags();
		// A new name longer than 64 characters stays in the title too.
		if (names.tooLong(key) || names.clash(key) !== null) return false;
		// A new tag of this input is newer than every existing one, so it never takes a name from them. Its parent is
		// created with it when missing (Lists, sections and tags rule 26), so the parent's name is taken too.
		for (const node of tagPrefixes(key)) if (!names.has(node)) names.add(node, "￿");
		return true;
	})) {
		take(t.span);
		const key = normalizeTagKey(t.name);
		const existing = tagFor(key);
		if (existing) drafts.push(draft(input, "tag", t.span, "applied", { tagKey: existing.key }));
		else drafts.push(draft(input, "tag", t.span, "applied", { tagKey: key, newTag: true }));
	}

	// A form Quick Add can build becomes a rule; any other `every …` stays unsupported (and in the title). The end typed
	// right after a repeat (`for 5 times`, `for 2 weeks`) is its own chip.
	const bare = new Map<Draft, Draft | null>();
	const counts: Draft[] = [];
	const periods = new Map<string, { n: number; freq: RepeatFreq }>();
	const startsOnDate = new Set<string>();
	const endDraftOf = (c: RepeatCount): Draft => {
		take(c.span);
		const end = draft(input, "repeatEnd", c.span, "applied", c.count !== undefined ? { end: { kind: "count", count: c.count } } : {});
		if (c.periods !== undefined) periods.set(end.chip.id, c.periods);
		counts.push(end);
		drafts.push(end);
		return end;
	};
	const repeatTokens = findRecurrence(input, isTaken);
	for (const t of repeatTokens) {
		take(t.span);
		const built = t.supported ? parseRepeatText(input.slice(t.span.start, t.span.end), ctx.zone) : null;
		let repeat: Draft;
		if (built === null) repeat = draft(input, "recurrence", t.span, "unsupported", { notice: NOTICE.recurrence });
		else if (built.other !== null) {
			// "every monday at 9": 09:00 or 21:00, the same two-way choice as "at 5" in a date. Neither is applied until chosen.
			const label = (r: RepeatRule): string => r.time ?? "";
			repeat = draft(input, "recurrence", t.span, "choice", {
				alternatives: [
					{ label: label(built.rule), rule: built.rule },
					{ label: label(built.other), rule: built.other },
				],
			});
		} else repeat = draft(input, "recurrence", t.span, "applied", { rule: built.rule });
		drafts.push(repeat);
		const end = t.end === null ? null : endDraftOf(t.end);
		if (t.bare) bare.set(repeat, end);
		if (t.onDate) startsOnDate.add(repeat.chip.id);
	}
	// After the first typed repeat, `for N <periods>` and `for N times` are its end, never part of a date. One is kept
	// below only when a repeat that stays ends before it.
	if (repeatTokens.length > 0) {
		const from = Math.min(...repeatTokens.map((t) => t.span.end));
		for (const c of findRepeatCounts(input, from, isTaken)) endDraftOf(c);
	}

	// The span is taken like every other token, so chrono never reads it.
	for (const t of findPriorityTokens(input, isTaken)) {
		take(t.span);
		drafts.push(draft(input, "priority", t.span, "applied", { priority: t.priority }));
	}

	for (const t of findDurationTokens(input, isTaken)) {
		take(t.span);
		if (isValidDuration(t.minutes)) drafts.push(draft(input, "duration", t.span, "applied", { durationMin: t.minutes }));
		else drafts.push(draft(input, "duration", t.span, "invalid", { notice: NOTICE.duration }));
	}

	// chrono reads the text with every taken span masked out.
	const masked = maskSpans(input, taken);
	const dates: DateCandidate[] = [];
	const dateEnv = { now: ctx.now, zone: ctx.zone, locale: ctx.locale, repeatRange: repeatTokens.length > 0, ...(ctx.eveningTime !== undefined ? { eveningTime: ctx.eveningTime } : {}) };
	for (const c of findDates(masked, dateEnv)) {
		if (!isTaken(c.span.start, c.span.end)) dates.push(c);
	}

	// A bare repeat word counts only at the end of the text, after title text ("Stretch daily", not "Daily standup").
	const dropped = new Set<Draft>();
	if (bare.size > 0) {
		const notTitle = coveredText(input, [...drafts.map((d) => d.chip.span), ...dates.map((c) => c.span)]);
		for (const [repeat, end] of bare) {
			if (notTitle.atEnd(repeat.chip.span)) continue;
			dropped.add(repeat);
			if (end !== null) dropped.add(end);
		}
	}
	// A repeat typed, or one picked by hand.
	const typed = drafts.some((d) => d.chip.kind === "recurrence" && !dropped.has(d));
	const repeats = typed || ctx.manual.has("recurrence");
	// A count or a number of periods ends only a typed repeat that stays and comes before it; otherwise it is text.
	const repeatEnds = drafts.filter((d) => d.chip.kind === "recurrence" && !dropped.has(d)).map((d) => d.chip.span.end);
	for (const d of counts) if (!repeatEnds.some((end) => end <= d.chip.span.start)) dropped.add(d);
	// A date range led by a start word (`starting Oct 12 to Dec 1`) or right after a typed repeat that stays is that
	// repeat's start and end (Repeating tasks rule 19); a repeat picked by hand never splits one.
	const afterRepeat = (at: number): boolean => repeatEnds.some((end) => end <= at && /^[\s,]*$/u.test(input.slice(end, at)));
	const readings = dates.flatMap((c) => (c.range !== undefined && typed && (c.range.led || afterRepeat(c.span.start)) ? [c.range.start, c.range.end] : [c]));
	for (const c of readings) {
		if (repeats || !c.repeatOnly) {
			// `until <date>` without a repeat is a deadline (decision 8). The end of a repeat picked by hand is not a
			// typed value it replaces, so the hand-picked repeat does not turn it into a suggestion.
			if (c.kind === "end" && repeats) drafts.push(typed ? endDraft(input, c, ctx.zone) : pickedEndDraft(input, c, ctx));
			else if (c.kind === "end") drafts.push(dateDraft(input, "deadline", c.span, c.outcome));
			else drafts.push(dateDraft(input, c.kind, c.span, c.outcome));
		} else {
			// `ending`, `starting` … lead a date only next to a repeat; otherwise they stay title words.
			drafts.push(dateDraft(input, "scheduled", { start: c.textStart, end: c.span.end }, c.outcome));
		}
	}

	drafts.sort((a, b) => a.chip.span.start - b.chip.span.start);
	// Defensive: spans cannot overlap by construction; keep the first if they ever do.
	const kept: Draft[] = [];
	for (const d of drafts) {
		const prev = kept.at(-1);
		if (dropped.has(d) || (prev && overlaps(prev.chip.span, d.chip.span))) continue;
		kept.push(d);
	}

	// The dates read with certainty, before a date picked by hand turns them into "Replace date?" suggestions.
	const readDates = new Set(kept.filter((d) => d.chip.kind === "scheduled" && (d.chip.status === "applied" || d.chip.status === "choice")).map((d) => d.chip.id));
	for (const d of kept) settle(d, decisions, ctx);
	supersede(kept);

	const chips = kept.map((d) => d.chip);
	requireStartDate(chips, startsOnDate, readDates, input);
	bindEnds(chips, periods, { zone: ctx.zone, start: ctx.startDate ?? today, weekStart: ctx.weekStart ?? "MO", ...(ctx.pickedRule === undefined ? {} : { pickedRule: ctx.pickedRule }) });
	return finish(input, chips);
}

/**
 * Which text is not title text: the spans of chips. `atEnd(span)` is true when title text comes before the span
 * and only chips, spaces and punctuation after it.
 */
function coveredText(input: string, spans: readonly Span[]): { atEnd: (span: Span) => boolean } {
	const covered = new Uint8Array(input.length);
	for (const s of spans) covered.fill(1, s.start, s.end);
	let first = -1;
	let last = -1;
	for (let i = 0; i < input.length; i++) {
		if (covered[i] === 1 || !isWordChar(input.charAt(i))) continue;
		if (first === -1) first = i;
		last = i;
	}
	return { atEnd: (span) => first !== -1 && first < span.start && last < span.end };
}

/** The chip of a date led by `until`, `ending` or `ends on` while a repeat is typed: the repeat's end date. */
function endDraft(input: string, c: DateCandidate, zone: string): Draft {
	const o = c.outcome;
	// A choice ("until friday" said on a Friday, "until 5") takes the later date.
	const value = o.status === "choice" ? o.alternatives[o.alternatives.length - 1]!.value : o.date;
	const extra: Partial<Chip> = { end: { kind: "date", date: dateSpecDate(value, zone) } };
	if (o.status === "suggestion") extra.notice = NOTICE.useAsEndDate;
	return draft(input, "repeatEnd", c.span, o.status === "suggestion" ? "suggestion" : "applied", extra);
}

/** Any rule's first date is on or after its anchor; a daily rule's is the anchor itself. */
const FROM_ANCHOR: RepeatRule = { freq: "daily", interval: 1, weekdays: null, monthly: null, afterCompletion: false, time: null, tz: null };

/**
 * "every year on <date>": the date read right after "on" is the start. It counts when applied or a choice to make, or
 * when a date picked by hand made it a "Replace date?" suggestion (`readDates`: the picked date is the start, and the
 * repeat applies). When none is read there (dismissed, weak or unreadable), the repeat is not supported: it would
 * otherwise start on today's month and day.
 */
function requireStartDate(chips: Chip[], startsOnDate: ReadonlySet<string>, readDates: ReadonlySet<string>, input: string): void {
	if (startsOnDate.size === 0) return;
	for (const c of chips) {
		if (!startsOnDate.has(c.id) || c.status === "unsupported") continue;
		let next = c.span.end;
		while (next < input.length && /\s/u.test(input.charAt(next))) next++;
		const read = chips.some(
			(d) => d.kind === "scheduled" && d.span.start === next && (d.status === "applied" || d.status === "choice" || (d.status === "suggestion" && readDates.has(d.id))),
		);
		if (read) continue;
		c.status = "unsupported";
		c.notice = NOTICE.recurrence;
		delete c.rule;
		delete c.alternatives;
	}
}

/**
 * A typed end with no typed repeat, for the repeat picked by hand: it applies at once when that repeat has no end, and
 * is a "Replace repeat end?" suggestion when it has one. Either way the picked repeat stays (no manual precedence).
 */
function pickedEndDraft(input: string, c: DateCandidate, ctx: ParseContext): Draft {
	const d = { ...endDraft(input, c, ctx.zone), field: null };
	if (ctx.pickedEnd === true && d.chip.status === "applied") {
		d.chip.status = "suggestion";
		d.chip.notice = NOTICE.replaceEnd;
	}
	return d;
}

/**
 * Binds the end chips to the repeat once the start is known (the applied typed date, else `start`: a date picked by
 * hand, a preset or today): `for N <periods>` becomes the day before N periods from the start; an end that leaves the
 * series no date is invalid (repeatEndProblem, the services' check), against the typed repeat, else the one picked by
 * hand; an end waits while its repeat's time is a choice; the end of a repeat Quick Add cannot build is not supported
 * either.
 */
function bindEnds(
	chips: Chip[],
	periods: ReadonlyMap<string, { n: number; freq: RepeatFreq }>,
	env: { zone: string; start: LocalDate; weekStart: WeekStart; pickedRule?: RepeatRule },
): void {
	if (!chips.some((c) => c.kind === "repeatEnd")) return;
	const repeats = chips.filter((c) => c.kind === "recurrence");
	const rule = repeats.find((c) => c.status === "applied")?.rule;
	const waiting = rule === undefined && repeats.some((c) => c.status === "choice");
	const unsupported = repeats.length > 0 && repeats.every((c) => c.status === "unsupported");
	const date = chips.find((c) => c.kind === "scheduled" && c.status === "applied")?.date;
	const anchor = date === undefined ? env.start : dateSpecDate(date, env.zone);
	// Without a known rule (none typed, none picked), only the anchor is checked, and the service checks the rest.
	const series = singleVersionRecurrence(anchor, rule ?? env.pickedRule ?? FROM_ANCHOR);
	for (const c of chips) {
		if (c.kind !== "repeatEnd") continue;
		const p = periods.get(c.id);
		if (p !== undefined) c.end = { kind: "date", date: addDays(periodsAfter(anchor, p.freq, p.n), -1) };
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

function draft(input: string, kind: ChipKind, span: Span, status: Chip["status"], extra: Partial<Chip>): Draft {
	const chip: Chip = {
		id: chipId(kind, span),
		kind,
		span: { start: span.start, end: span.end },
		text: input.slice(span.start, span.end),
		status,
		...extra,
	};
	return { chip, field: FIELD_OF[kind] ?? null };
}

function dateDraft(input: string, kind: "scheduled" | "deadline", span: Span, outcome: DateOutcome): Draft {
	if (outcome.status === "choice") return draft(input, kind, span, "choice", { alternatives: outcome.alternatives });
	const extra: Partial<Chip> = { date: outcome.date };
	if (outcome.warning) extra.warning = outcome.warning;
	if (outcome.status === "suggestion") extra.notice = NOTICE.useAsDate;
	return draft(input, kind, span, outcome.status, extra);
}

/** Applies decisions and manual-field precedence to one chip. */
function settle(d: Draft, decisions: Decisions, ctx: ParseContext): void {
	const chip = d.chip;
	const decision = decisions.byChip.get(`${chip.span.start}:${chip.span.end}`);
	if (decision && decision.text !== chip.text) return;
	const isDate = chip.kind === "scheduled" || chip.kind === "deadline";

	if (decision?.kind === "rule" && chip.kind === "recurrence" && chip.status === "choice") {
		// Only one of the offered readings can be chosen; any other rule is ignored and the choice stays.
		const wanted = JSON.stringify(decision.rule);
		const picked = chip.alternatives?.find((a) => a.rule !== undefined && JSON.stringify(a.rule) === wanted);
		if (picked?.rule !== undefined) {
			chip.status = "applied";
			chip.rule = picked.rule;
			delete chip.alternatives;
			delete chip.notice;
			return;
		}
	}
	if (decision?.kind === "date" && isDate) {
		const resolved = resolveDateSpec(decision.value);
		if (resolved) {
			chip.status = "applied";
			chip.date = resolved.value;
			delete chip.alternatives;
			delete chip.notice;
			if (resolved.warning) chip.warning = resolved.warning;
			else delete chip.warning;
			return;
		}
	}
	const accepted = decision?.kind === "accept";
	const manual = d.field !== null && d.field !== "tags" && ctx.manual.has(d.field);
	const replace = REPLACE_NOTICE[chip.kind];
	if (chip.status === "applied" && manual && !accepted) {
		chip.status = "suggestion";
		if (replace) chip.notice = replace;
	} else if (chip.status === "suggestion" && accepted) {
		chip.status = "applied";
		delete chip.notice;
	} else if ((chip.status === "suggestion" || chip.status === "choice") && manual && (isDate || chip.kind === "recurrence") && replace) {
		chip.notice = replace;
	}
}

/** One value per field: of several applied chips the last wins. Tags are a set. */
function supersede(drafts: Draft[]): void {
	const lastOf = new Map<ChipKind, Draft>();
	for (const d of drafts) {
		if (d.chip.status === "applied" && d.chip.kind !== "tag") lastOf.set(d.chip.kind, d);
	}
	for (const d of drafts) {
		if (d.chip.status !== "applied" || d.chip.kind === "tag") continue;
		if (lastOf.get(d.chip.kind) !== d) {
			d.chip.status = "superseded";
			d.chip.notice = NOTICE.superseded;
		}
	}
	// An unresolved category before a later applied one no longer blocks: the later value wins.
	const lastCategory = lastOf.get("category");
	for (const d of drafts) {
		if (d.chip.kind === "category" && d.chip.status === "unresolved" && lastCategory && d.chip.span.start < lastCategory.chip.span.start) {
			d.chip.status = "superseded";
			d.chip.notice = NOTICE.superseded;
		}
	}
}

function finish(input: string, chips: Chip[]): ParseResult {
	const fields: ParsedFields = { tagKeys: [], newTags: [] };
	let title = "";
	let at = 0;
	let appliedCount = 0;
	for (const c of chips) {
		if (c.status !== "applied") continue;
		appliedCount++;
		title += input.slice(at, c.span.start);
		at = c.span.end;
		switch (c.kind) {
			case "scheduled":
				if (c.date) fields.scheduled = c.date;
				break;
			case "deadline":
				if (c.date) fields.deadline = c.date;
				break;
			case "duration":
				if (c.durationMin !== undefined) fields.plannedDurationMin = c.durationMin;
				break;
			case "priority":
				if (c.priority !== undefined) fields.priority = c.priority;
				break;
			case "category":
				if (c.categoryId !== undefined) fields.categoryId = c.categoryId;
				break;
			case "note":
				if (c.notePath !== undefined) fields.notePath = c.notePath;
				break;
			case "tag":
				if (c.tagKey !== undefined) {
					if (c.newTag) {
						// The typed name (without "@"), so the display name keeps its casing;
						// deduped by key, the first occurrence wins.
						const typed = c.text.replace(/^@/u, "");
						if (!fields.newTags.some((n) => normalizeTagKey(n) === c.tagKey)) fields.newTags.push(typed);
					} else if (!fields.tagKeys.includes(c.tagKey)) fields.tagKeys.push(c.tagKey);
				}
				break;
			case "recurrence":
				if (c.rule !== undefined) fields.recurrence = c.rule;
				break;
			case "repeatEnd":
				if (c.end !== undefined) fields.recurrenceEnd = c.end;
				break;
		}
	}
	// A sentence's last punctuation after a repeat that leaves the title ("Plan meals every sunday.") goes with it.
	const tail = input.slice(at);
	const lastKind = chips.filter((c) => c.status === "applied").at(-1)?.kind;
	const orphan = (lastKind === "recurrence" || lastKind === "repeatEnd") && /^[.,;:!?]+\s*$/u.test(tail) && /\s$/u.test(title);
	if (!orphan) title += tail;
	const collapsed = collapseWhitespace(title);
	return {
		input,
		chips,
		title: collapsed === "" ? input : collapsed,
		titleFallback: collapsed === "" && appliedCount > 0,
		fields,
		// An unresolved list and an invalid repeat end block saving until fixed or dismissed.
		blocking: chips.filter((c) => c.status === "unresolved" || (c.kind === "repeatEnd" && c.status === "invalid")).map((c) => c.id),
	};
}

function maskSpans(input: string, spans: readonly Span[]): string {
	if (spans.length === 0) return input;
	const sorted = [...spans].sort((a, b) => a.start - b.start);
	let out = "";
	let at = 0;
	for (const s of sorted) {
		const start = Math.max(s.start, at);
		if (s.end <= start) continue;
		out += input.slice(at, start) + MASK_CHAR.repeat(s.end - start);
		at = s.end;
	}
	return out + input.slice(at);
}

/** Parses Quick Add input. Never throws: an unusable context gives a plain title. */
export function parseQuickAdd(input: string, ctx: ParseContext): ParseResult {
	try {
		return parseUnguarded(input, ctx);
	} catch {
		return plainResult(input);
	}
}

