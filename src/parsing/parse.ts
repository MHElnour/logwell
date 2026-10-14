import type { RepeatFreq, RepeatRule } from "../domain/types";
import { resolveListName } from "../domain/tasks";
import { collapseWhitespace } from "../domain/text";
import { sameDateSpec } from "../domain/time";
import { TagNames, hasAllowedTagDepth, hasRepeatedTagName, isValidTagKey, normalizeTagKey, resolveTagName, tagPrefixes } from "../domain/tags";
import { findDates, resolveDateSpec, todayOf, zoneNowOf, type DateCandidate, type DateOutcome, type RollKind } from "./dates";
import { isValidDuration } from "./duration";
import { tokenAtCursor } from "./cursor";
import { rebaseDecisions } from "./rebase";
import { parseRepeatText } from "./recurrence";
import { MASK_CHAR, atClockLength, isWordChar } from "./text";
import { type Draft, NOTICE, draft } from "./chipDraft";
import { bindEnds, endDraft, partsStart, pickedEndDraft, requireStartDate } from "./repeatBinding";
import { findDurationTokens, findLiteralTokens, findNoteTokens, findPriorityTokens, findRecurrence, findRepeatCounts, findWordTokens, type RepeatCount } from "./tokens";
import type {
	Chip,
	ChipKind,
	ParseContext,
	ParsedFields,
	ParseResult,
	Span,
	SpanDecision,
} from "./types";

export { rebaseDecisions, tokenAtCursor };

// The Quick Add parser. Pipeline:
//   1. the spans bound by decisions, literal text ("…", \word), then plugin tokens ([[note]], #category, @tag,
//      every …, for <duration>) are found and masked;
//   2. chrono reads the masked text, and `by` turns its span into a deadline;
//   3. each span becomes a chip: applied, suggestion, choice, unresolved …;
//   4. manual fields and one-value-per-field rules are applied;
//   5. the title is the input without the applied spans.


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

function overlaps(a: Span, b: Span): boolean {
	return a.start < b.end && b.start < a.end;
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
	const sectionLists = new Map((ctx.sections ?? []).map((x) => [x.id, x.categoryId]));
	const tagKeys = new Set(ctx.tags.map((t) => normalizeTagKey(t.key)));
	const literal: Span[] = [];
	const boundAll: Decisions["bound"] = [];
	const byChip = new Map<string, SpanDecision>();
	for (const d of latest.values()) {
		if (d.kind === "literal") literal.push(d.span);
		else if (d.kind === "category") {
			// A section deleted or moved since the binding: the span is read again.
			if (categoryIds.has(d.categoryId) && (d.sectionId === undefined || sectionLists.get(d.sectionId) === d.categoryId)) boundAll.push(d);
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

type ListReading = { kind: "list"; categoryId: string; sectionId?: string } | { kind: "unresolved" | "invalid"; notice: string };

/**
 * What a typed `#name` names: the list of that whole name; else, split at the first `/`, a list and one of its sections
 * (`#Work/Admin`, `#Work/` alone is the list), each matched as list names are. A list with no such section is invalid;
 * no list at all is unresolved, by the whole name.
 */
function readListName(ctx: ParseContext, name: string): ListReading {
	const whole = resolveListName(ctx.categories, name);
	if (whole.kind === "one") return { kind: "list", categoryId: whole.list.id };
	const slash = name.indexOf("/");
	const list = slash === -1 ? null : resolveListName(ctx.categories, name.slice(0, slash));
	if (list?.kind === "one") {
		const sectionName = name.slice(slash + 1);
		if (sectionName === "") return { kind: "list", categoryId: list.list.id };
		const section = resolveListName((ctx.sections ?? []).filter((x) => x.categoryId === list.list.id), sectionName);
		if (section.kind === "one") return { kind: "list", categoryId: list.list.id, sectionId: section.list.id };
		return { kind: "invalid", notice: `No section named ${sectionName} in ${list.list.name}` };
	}
	const notice = whole.kind === "several" ? `\u201c${name}\u201d matches several lists. Use the exact name.` : `No list named ${name}`;
	return { kind: "unresolved", notice };
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
	const today = todayOf(zoneNowOf(ctx.now, ctx.zone));

	const decisions = usableDecisions(input, ctx);
	const taken: Span[] = [...decisions.literal, ...decisions.bound.map((d) => d.span)];
	const isTaken = (start: number, end: number): boolean => taken.some((t) => overlaps(t, { start, end }));
	const take = (span: Span): void => {
		taken.push(span);
	};

	const drafts: Draft[] = [];

	// Quoted phrases and escaped words are never read; the title keeps them (an escape without its backslash).
	const literalTokens = findLiteralTokens(input, isTaken);
	for (const t of literalTokens) take(t.span);
	const keptText = [...decisions.literal, ...literalTokens.map((t) => t.span)];
	const escapes = literalTokens.filter((t) => t.escape).map((t) => t.span.start);

	// Bound spans first: they define a token even when it contains spaces.
	for (const d of decisions.bound) {
		if (d.kind === "category") {
			drafts.push(draft(input, "category", d.span, "applied", { categoryId: d.categoryId, ...(d.sectionId === undefined ? {} : { sectionId: d.sectionId }) }));
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
		const found = readListName(ctx, t.name);
		if (found.kind === "list") drafts.push(draft(input, "category", t.span, "applied", { categoryId: found.categoryId, ...(found.sectionId === undefined ? {} : { sectionId: found.sectionId }) }));
		else drafts.push(draft(input, "category", t.span, found.kind, { notice: found.notice }));
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
		// A clock time ("@4pm", "@noon") is a time, unless a tag of that name exists.
		if (atClockLength(name, 0) === name.length) return false;
		if (digitsOnly(key) || !hasAllowedTagDepth(key) || hasRepeatedTagName(key)) return false;
		const names = namesOfTags();
		// A new name longer than 64 characters stays in the title too.
		if (names.tooLong(key) || names.clash(key) !== null) return false;
		// A new tag of this input is newer than every existing one, so it never takes a name from them. Its parent is
		// created with it when missing, in the same write, so the parent's name is taken too.
		for (const node of tagPrefixes(key)) if (!names.has(node)) names.add(node, "￿");
		return true;
	})) {
		take(t.span);
		const key = normalizeTagKey(t.name);
		const existing = tagFor(key);
		if (existing) drafts.push(draft(input, "tag", t.span, "applied", { tagKey: existing.key }));
		else drafts.push(draft(input, "tag", t.span, "applied", { tagKey: key, newTag: true }));
	}

	// A form Quick Add can build becomes a rule; any other `every …` stays unsupported (and in the title); `each …` is
	// only taken (title text, never a date). The end typed right after a repeat (`for 5 times`, `for 2 weeks`) is its
	// own chip.
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
	const repeatTokens = findRecurrence(input, isTaken).filter((t) => {
		if (t.silent) take(t.span);
		return !t.silent;
	});
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
	const dateEnv = { now: ctx.now, zone: ctx.zone, locale: ctx.locale, repeatRange: repeatTokens.length > 0, ...(ctx.eveningTime !== undefined ? { eveningTime: ctx.eveningTime } : {}) };
	const datesNow = (): DateCandidate[] => findDates(maskSpans(input, taken), dateEnv).filter((c) => !isTaken(c.span.start, c.span.end));
	let dates = datesNow();

	// A bare repeat word counts only at the end of the text, after title text ("Stretch daily", not "Daily standup"). A
	// dropped one is title text again, its words free for the date reader ("weekly Monday" alone: Monday is a date).
	const dropped = new Set<Draft>();
	if (bare.size > 0) {
		const notTitle = coveredText(input, [...drafts.map((d) => d.chip.span), ...dates.map((c) => c.span)]);
		for (const [repeat, end] of bare) {
			if (notTitle.atEnd(repeat.chip.span)) continue;
			dropped.add(repeat);
			if (end !== null) dropped.add(end);
		}
		if (dropped.size > 0) {
			const freed = new Set([...dropped].map((d) => `${d.chip.span.start}:${d.chip.span.end}`));
			let kept = 0;
			for (const t of taken) if (!freed.has(`${t.start}:${t.end}`)) taken[kept++] = t;
			taken.length = kept;
			dates = datesNow();
		}
	}
	// Two typed repeats are several patterns: not supported, neither applied.
	const keptRepeats = drafts.filter((d) => d.chip.kind === "recurrence" && !dropped.has(d));
	if (keptRepeats.length > 1) {
		for (const d of keptRepeats) {
			d.chip.status = "unsupported";
			d.chip.notice = NOTICE.recurrence;
			delete d.chip.rule;
			delete d.chip.alternatives;
		}
	}
	const typed = keptRepeats.length > 0;
	// Only a repeat Quick Add built (applied, or a time to choose) takes start and end parts and splits a range into them;
	// after an `every …` it cannot build they apply nothing.
	const built = drafts.some((d) => d.chip.kind === "recurrence" && !dropped.has(d) && (d.chip.status === "applied" || d.chip.status === "choice"));
	// Start and end parts belong to the typed repeat only when typed after it, to one picked by hand anywhere: before the
	// first typed repeat that stays they read as without a repeat. Never picked by hand is no
	// repeat: `until Dec 1` is then a deadline, as on a task that does not repeat.
	const picked = ctx.manual.has("recurrence") && ctx.pickedNever !== true;
	const partsFrom = partsStart(keptRepeats.map((d) => d.chip.span.end), picked, input.length);
	const isPart = (c: DateCandidate): boolean => c.span.start >= partsFrom;
	// Under a weekly form `on` names days: `every week on Oct 12` is no start.
	const typedRule = keptRepeats.length === 1 ? (keptRepeats[0]!.chip.rule ?? keptRepeats[0]!.chip.alternatives?.[0]?.rule) : undefined;
	const onWeekly = (c: DateCandidate): boolean => typedRule?.freq === "weekly" && c.lead?.words === "on" && isPart(c);
	// A count or a number of periods ends only a typed repeat that stays and comes before it; otherwise it is text.
	const repeatEnds = drafts.filter((d) => d.chip.kind === "recurrence" && !dropped.has(d)).map((d) => d.chip.span.end);
	for (const d of counts) if (!repeatEnds.some((end) => end <= d.chip.span.start)) dropped.add(d);
	// A date range led by a start word (`starting Oct 12 to Dec 1`) or right after a typed repeat that stays is that
	// repeat's start and end; a repeat picked by hand never splits one.
	const afterRepeat = (at: number, joined = /^[\s,]*$/u): boolean => repeatEnds.some((end) => end <= at && joined.test(input.slice(end, at)));
	// After a repeat Quick Add cannot build, a date joined to it by `and` or `&` is as close as one after a comma
	// (`every May 5 and Dec 25`): it is offered at most.
	const JOINED = /^[\s,&]*(?:and[\s,&]+)?$/iu;
	// A start that is a choice: the end follows the alternative chosen for it (`starting Wednesday until Friday`, "Next week").
	const rangeEnd = (range: NonNullable<DateCandidate["range"]>): DateCandidate => {
		const o = range.start.outcome;
		const chosen = decisions.byChip.get(`${range.start.span.start}:${range.start.span.end}`);
		if (o.status !== "choice" || range.endByChoice === undefined || chosen?.kind !== "date") return range.end;
		const outcome = range.endByChoice[o.alternatives.findIndex((alt) => sameDateSpec(alt.value, chosen.value))];
		return outcome === undefined ? range.end : { ...range.end, outcome };
	};
	// The ends typed as a bare weekday or a month and day with no year: before the start they move past it (bindEnds).
	const rolling = new Map<string, RollKind>();
	const readings = dates.flatMap((c) => (c.range !== undefined && built && isPart(c) && !onWeekly(c) && (c.range.led || afterRepeat(c.span.start)) ? [c.range.start, rangeEnd(c.range)] : [c]));
	for (const c of readings) {
		if (!isPart(c)) {
			// `ending`, `starting` … lead a date only next to a repeat; otherwise they stay title words. `until <date>`
			// without a repeat is a deadline (decision 8).
			if (c.repeatOnly) drafts.push(dateDraft(input, "scheduled", { start: c.textStart, end: c.span.end }, c.outcome));
			else drafts.push(dateDraft(input, c.kind === "end" ? "deadline" : c.kind, c.span, c.outcome, c.durationMin));
		} else if (typed && !built && (c.kind === "end" || c.lead?.kind === "schedule" || c.lead?.kind === "end")) {
			// A start or end part of a repeat Quick Add cannot build applies nothing.
			drafts.push(draft(input, c.kind === "end" ? "repeatEnd" : "scheduled", c.span, "unsupported", { notice: NOTICE.recurrence }));
		} else if (typed && !built && c.kind === "scheduled" && afterRepeat(c.span.start, JOINED)) {
			// Nor does a date right after it, its start as typed, or joined to it by `and` or `&`: it is offered at most.
			drafts.push(offerDraft(input, c));
		} else if (c.kind === "end") {
			// The end of a repeat picked by hand is not a typed value it replaces, so the hand-picked repeat does not turn
			// it into a suggestion.
			const end = typed ? endDraft(input, c, ctx.zone) : pickedEndDraft(input, c, ctx.zone, ctx.pickedEnd === true);
			if (c.rolls !== null) rolling.set(end.chip.id, c.rolls);
			drafts.push(end);
		} else if (c.lead?.kind === "end" || onWeekly(c)) {
			// A time after an end word (`until 5pm`: an end must be a date) and a date after a weekly form's `on` are
			// visible offers, never applied as typed.
			drafts.push(offerDraft(input, c));
		} else drafts.push(dateDraft(input, c.kind, c.span, c.outcome, c.durationMin));
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
	const open = requireStartDate(chips, startsOnDate, readDates, input, ctx.manual.has("scheduled"));
	// A typed repeat whose hour is a choice blocks saving until it is chosen, unless a repeat picked by hand wins.
	if (!ctx.manual.has("recurrence")) for (const c of chips) if (c.kind === "recurrence" && c.status === "choice") open.push(c.id);
	bindEnds(chips, periods, rolling, { zone: ctx.zone, start: ctx.startDate ?? today, weekStart: ctx.weekStart ?? "MO", ...(ctx.pickedRule === undefined ? {} : { pickedRule: ctx.pickedRule }) });
	return finish(input, chips, open, keptText, escapes);
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

/** A date read whole with its lead word, offered as "Use as date?" (or the choice it is), never applied as typed. */
function offerDraft(input: string, c: DateCandidate): Draft {
	const d = dateDraft(input, "scheduled", c.span, c.outcome);
	if (d.chip.status === "applied") {
		d.chip.status = "suggestion";
		d.chip.notice = NOTICE.useAsDate;
	}
	return d;
}

function dateDraft(input: string, kind: "scheduled" | "deadline", span: Span, outcome: DateOutcome, durationMin?: number): Draft {
	const minutes: Partial<Chip> = durationMin === undefined ? {} : { durationMin };
	if (outcome.status === "choice") return draft(input, kind, span, "choice", { alternatives: outcome.alternatives, ...minutes });
	const extra: Partial<Chip> = { date: outcome.date, ...minutes };
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
	// An unresolved list or an unknown section before a later applied one no longer blocks: the later value wins.
	const lastCategory = lastOf.get("category");
	for (const d of drafts) {
		if (d.chip.kind === "category" && (d.chip.status === "unresolved" || d.chip.status === "invalid") && lastCategory && d.chip.span.start < lastCategory.chip.span.start) {
			d.chip.status = "superseded";
			d.chip.notice = NOTICE.superseded;
		}
	}
}

// A lone mark right before or after a removed span belonged to it ("Read every day, 20 pages", "Pay rent !1.", "Call
// Ann - tomorrow"): a comma, semicolon, period, colon, exclamation or question mark, hyphen or en dash, not one of a
// run of marks. A dash joined to words on both sides stays ("Meeting 4-3pm").
const MARK_AFTER_RE = /^\s*[,;.:!?\-\u2013](?![,;.:!?\-\u2013])/u;
const MARK_BEFORE_RE = /[,;.:!?\-\u2013]\s*$/u;
const isMarkChar = (ch: string): boolean => ch !== "" && ",;.:!?-\u2013".includes(ch);
// The two halves of a pair of parentheses with only removed spans between them ("Pay rent (#Work)").
const OPEN_PAREN_RE = /\(\s*$/u;
const CLOSE_PAREN_RE = /^\s*\)/u;
const BLANK_RE = /^\s*$/u;

/**
 * The title: the input without the applied spans, or the full text if nothing remains. A lone mark left next to a
 * removed span goes with it, as do the parentheses around removed spans only, and a sentence's last punctuation after a
 * repeat that leaves the title ("Plan meals every sunday."): no stray punctuation or spaces. An escaped word loses its
 * backslash (`escapes`, their indexes). Text the user kept as it is (`literal`: a dismissed chip, a quoted phrase, an
 * escaped word) is never touched.
 */
function titleOf(input: string, chips: readonly Chip[], literal: readonly Span[], escapes: readonly number[]): string {
	const parts: string[] = [];
	// Where each part starts in the input; moved on when a part loses its first characters.
	const starts: number[] = [];
	let at = 0;
	for (const c of chips) {
		if (c.status !== "applied") continue;
		parts.push(input.slice(at, c.span.start));
		starts.push(at);
		at = c.span.end;
	}
	parts.push(input.slice(at));
	starts.push(at);
	const kept = (index: number): boolean => literal.some((l) => l.start <= index && index < l.end);
	// A hyphen or en dash between two word characters joins them ("4-3pm"): not a lone mark.
	const joins = (mark: number): boolean => "-\u2013".includes(input.charAt(mark)) && isWordChar(input.charAt(mark - 1)) && isWordChar(input.charAt(mark + 1));
	const dropHead = (i: number, n: number): void => {
		parts[i] = parts[i]!.slice(n);
		starts[i] = starts[i]! + n;
	};
	for (let i = 0; i + 1 < parts.length; i++) {
		const open = OPEN_PAREN_RE.exec(parts[i]!);
		if (open === null || kept(starts[i]! + open.index)) continue;
		let j = i + 1;
		while (j + 1 < parts.length && BLANK_RE.test(parts[j]!)) j++;
		const close = CLOSE_PAREN_RE.exec(parts[j]!);
		if (close === null || kept(starts[j]! + close[0].length - 1)) continue;
		parts[i] = parts[i]!.slice(0, open.index);
		dropHead(j, close[0].length);
	}
	for (let i = 0; i + 1 < parts.length; i++) {
		const before = MARK_BEFORE_RE.exec(parts[i]!);
		if (before !== null) {
			const mark = starts[i]! + before.index;
			if (!kept(mark) && !isMarkChar(input.charAt(mark - 1)) && !joins(mark)) parts[i] = parts[i]!.slice(0, before.index);
		}
		const after = MARK_AFTER_RE.exec(parts[i + 1]!);
		if (after !== null) {
			const mark = starts[i + 1]! + after[0].length - 1;
			if (!kept(mark) && !joins(mark)) dropHead(i + 1, after[0].length);
		}
	}
	const lastKind = chips.filter((c) => c.status === "applied").at(-1)?.kind;
	const tail = parts.at(-1)!;
	if (parts.length > 1 && (lastKind === "recurrence" || lastKind === "repeatEnd") && /^[.,;:!?]+\s*$/u.test(tail) && /\s$/u.test(parts.at(-2)!)) parts[parts.length - 1] = "";
	if (escapes.length === 0) return collapseWhitespace(parts.join(""));
	// An escaped word sits inside one part, its backslash never touched by the cleanup above.
	return collapseWhitespace(parts.map((p, i) => withoutIndexes(p, starts[i]!, escapes)).join(""));
}

/** `text`, which starts at `start` in the input, without the characters at the input indexes `drop`. */
function withoutIndexes(text: string, start: number, drop: readonly number[]): string {
	let out = "";
	let from = 0;
	for (const index of drop) {
		const k = index - start;
		if (k < from || k >= text.length) continue;
		out += text.slice(from, k);
		from = k + 1;
	}
	return out + text.slice(from);
}

function finish(input: string, chips: Chip[], open: readonly string[], literal: readonly Span[], escapes: readonly number[]): ParseResult {
	const fields: ParsedFields = { tagKeys: [], newTags: [] };
	let appliedCount = 0;
	// A time range's duration (`3-4pm`); a typed `for` duration wins.
	let rangeMinutes: number | undefined;
	for (const c of chips) {
		if (c.status !== "applied") continue;
		appliedCount++;
		switch (c.kind) {
			case "scheduled":
				if (c.date) fields.scheduled = c.date;
				if (c.durationMin !== undefined) rangeMinutes = c.durationMin;
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
				if (c.sectionId !== undefined) fields.sectionId = c.sectionId;
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
	if (fields.plannedDurationMin === undefined && rangeMinutes !== undefined) fields.plannedDurationMin = rangeMinutes;
	const collapsed = titleOf(input, chips, literal, escapes);
	return {
		input,
		chips,
		title: collapsed === "" ? input : collapsed,
		titleFallback: collapsed === "" && appliedCount > 0,
		fields,
		// An unresolved list, an unknown section, an invalid repeat end, and a typed repeat or a yearly repeat's start whose
		// hour is still a choice (`open`) block saving until fixed, chosen or dismissed.
		blocking: chips.filter((c) => c.status === "unresolved" || ((c.kind === "repeatEnd" || c.kind === "category") && c.status === "invalid") || open.includes(c.id)).map((c) => c.id),
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

