import { DateTime } from "luxon";
import type { RepeatRule } from "../domain/types";
import { resolveListName } from "../domain/tasks";
import { collapseWhitespace } from "../domain/text";
import { TagNames, hasAllowedTagDepth, hasRepeatedTagName, isValidTagKey, normalizeTagKey, resolveTagName, tagPrefixes } from "../domain/tags";
import { findDates, resolveDateSpec, type DateOutcome } from "./dates";
import { isValidDuration } from "./duration";
import { tokenAtCursor } from "./cursor";
import { rebaseDecisions } from "./rebase";
import { parseRepeatText } from "./recurrence";
import { MASK_CHAR } from "./text";
import { findDurationTokens, findNoteTokens, findPriorityTokens, findRecurrence, findWordTokens } from "./tokens";
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
};

const FIELD_OF: Record<string, ParsedField> = {
	scheduled: "scheduled",
	deadline: "deadline",
	duration: "duration",
	category: "category",
	note: "note",
	priority: "priority",
	recurrence: "recurrence",
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

	// A form Quick Add can build becomes a rule; any other `every …` stays unsupported (and in the title).
	for (const span of findRecurrence(input, isTaken)) {
		take(span);
		const built = parseRepeatText(input.slice(span.start, span.end), ctx.zone);
		if (built === null) drafts.push(draft(input, "recurrence", span, "unsupported", { notice: NOTICE.recurrence }));
		else if (built.other !== null) {
			// "every monday at 9": 09:00 or 21:00, the same two-way choice as "at 5" in a date. Neither is applied until chosen.
			const label = (r: RepeatRule): string => r.time ?? "";
			drafts.push(
				draft(input, "recurrence", span, "choice", {
					alternatives: [
						{ label: label(built.rule), rule: built.rule },
						{ label: label(built.other), rule: built.other },
					],
				}),
			);
		} else drafts.push(draft(input, "recurrence", span, "applied", { rule: built.rule }));
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
	for (const c of findDates(masked, { now: ctx.now, zone: ctx.zone, locale: ctx.locale, ...(ctx.eveningTime !== undefined ? { eveningTime: ctx.eveningTime } : {}) })) {
		if (isTaken(c.span.start, c.span.end)) continue;
		drafts.push(dateDraft(input, c.kind, c.span, c.outcome));
	}

	drafts.sort((a, b) => a.chip.span.start - b.chip.span.start);
	// Defensive: spans cannot overlap by construction; keep the first if they ever do.
	const kept: Draft[] = [];
	for (const d of drafts) {
		const prev = kept.at(-1);
		if (prev && overlaps(prev.chip.span, d.chip.span)) continue;
		kept.push(d);
	}

	for (const d of kept) settle(d, decisions, ctx);
	supersede(kept);

	const chips = kept.map((d) => d.chip);
	return finish(input, chips);
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
		}
	}
	title += input.slice(at);
	const collapsed = collapseWhitespace(title);
	return {
		input,
		chips,
		title: collapsed === "" ? input : collapsed,
		titleFallback: collapsed === "" && appliedCount > 0,
		fields,
		blocking: chips.filter((c) => c.status === "unresolved").map((c) => c.id),
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

