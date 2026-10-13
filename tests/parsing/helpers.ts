import { DateTime } from "luxon";
import { parseQuickAdd } from "../../src/parsing";
import type { Chip, DateLocale, ParseContext, ParseResult, ParsedField, SpanDecision } from "../../src/parsing/types";
import type { DateSpec, RepeatRule } from "../../src/domain/types";

export const NY = "America/New_York";
export const BERLIN = "Europe/Berlin";
export const TOKYO = "Asia/Tokyo";
/** The zones a repeat case runs in: each must give the same local reading. */
export const ZONES = [NY, BERLIN, TOKYO] as const;
/** Wednesday 2026-10-07 10:00: the local wall time of the repeat cases in each zone. */
export const WEDNESDAY = "2026-10-07T10:00";

/** A wall time in a zone as an instant. */
export function at(zone: string, local: string): Date {
	const dt = DateTime.fromISO(local, { zone });
	if (!dt.isValid) throw new Error(`bad test instant ${local} in ${zone}`);
	return dt.toJSDate();
}

/** The default Quick Add test vault. Distinct ids so a wrong match cannot pass by accident. */
export const CATEGORIES = [
	{ id: "cat-inbox-0001", name: "Inbox" },
	{ id: "cat-study-0002", name: "Study" },
	{ id: "cat-deepwork-0003", name: "Deep work" },
	{ id: "cat-health-0004", name: "Health_Care" },
	{ id: "cat-cafe-0005", name: "Café" },
];

export const TAGS = [
	{ key: "learning", displayName: "Learning" },
	{ key: "home", displayName: "Home" },
	{ key: "work/urgent", displayName: "Work/Urgent" },
];

export const NOTES: Record<string, string[]> = {
	Plan: ["Projects/Plan.md", "Archive/Plan.md"],
	"Python study plan": ["Notes/Python study plan.md"],
	"folder/Note": ["folder/Note.md"],
	Big: ["Notes/Big note.md"],
};

export function resolveNoteFixture(linktext: string): string[] {
	return NOTES[linktext] ?? [];
}

export interface CtxOptions {
	zone?: string;
	now?: Date;
	locale?: DateLocale;
	eveningTime?: string;
	decisions?: SpanDecision[];
	manual?: ParsedField[];
}

export function makeCtx(opts: CtxOptions = {}): ParseContext {
	const zone = opts.zone ?? NY;
	return {
		now: opts.now ?? at(zone, "2026-10-01T06:00"),
		zone,
		locale: opts.locale ?? "en",
		...(opts.eveningTime !== undefined ? { eveningTime: opts.eveningTime } : {}),
		categories: CATEGORIES,
		tags: TAGS,
		resolveNote: resolveNoteFixture,
		decisions: opts.decisions ?? [],
		manual: new Set(opts.manual ?? []),
	};
}

export interface ParseOptions extends Omit<CtxOptions, "zone" | "now"> {
	/** The local wall time of the reference instant in the zone; Wednesday 2026-10-07 10:00 when absent. */
	local?: string;
	/** A start date picked by hand (the model's start). */
	startDate?: string;
	/** A repeat picked by hand; it marks the repeat as set by hand too. */
	pickedRule?: RepeatRule;
}

/** Parses `input` in the default test context (New York, Thursday 2026-10-01 06:00) with these changes. */
export function parse(input: string, opts: CtxOptions = {}): ParseResult {
	return parseQuickAdd(input, makeCtx(opts));
}

/** Parses `input` in `zone` at a local wall time, with the default Quick Add test vault. */
export function parseAt(input: string, zone: string, opts: ParseOptions = {}): ParseResult {
	const { local, startDate, pickedRule, ...rest } = opts;
	const manual = pickedRule === undefined ? rest.manual : [...(rest.manual ?? []), "recurrence" as const];
	const ctx = makeCtx({ ...rest, manual, zone, now: at(zone, local ?? WEDNESDAY) });
	return parseQuickAdd(input, { ...ctx, ...(startDate === undefined ? {} : { startDate }), ...(pickedRule === undefined ? {} : { pickedRule }) });
}

/** Runs `check` once per zone of ZONES; name the zone in each `expect` message. */
export function inZones(check: (zone: string) => void): void {
	for (const zone of ZONES) check(zone);
}

/** A date or datetime as its date or local wall time. */
export const specText = (d: DateSpec | undefined): string | undefined => (d === undefined ? undefined : d.kind === "date" ? d.date : d.local);
export const scheduledOf = (r: ParseResult): string | undefined => specText(r.fields.scheduled);
export const deadlineOf = (r: ParseResult): string | undefined => specText(r.fields.deadline);
/** The typed repeat as a ruleKey. */
export const recOf = (r: ParseResult): string | undefined => (r.fields.recurrence === undefined ? undefined : ruleKey(r.fields.recurrence));
/** The repeat end: "2026-12-01" (a date), "5x" (a count) or "never". */
export function endOf(r: ParseResult): string | undefined {
	const e = r.fields.recurrenceEnd;
	return e === undefined ? undefined : e.kind === "date" ? e.date : e.kind === "count" ? `${e.count}x` : "never";
}
/** The first chip of a kind, and of a status when one is given. */
export const chipOf = (r: ParseResult, kind: Chip["kind"], status?: Chip["status"]): Chip | undefined =>
	r.chips.find((c) => c.kind === kind && (status === undefined || c.status === status));
/** One line per chip: kind|status|text. */
export const briefChips = (r: ParseResult): string[] => r.chips.map((c) => `${c.kind}|${c.status}|${c.text}`);
/** The chips that block saving, by kind. */
export const blockingKinds = (r: ParseResult): (Chip["kind"] | undefined)[] => r.blocking.map((id) => r.chips.find((c) => c.id === id)?.kind);

export function dateSpecOf(shorthand: string, zone: string): DateSpec {
	return shorthand.length === 10
		? { kind: "date", date: shorthand }
		: { kind: "datetime", local: shorthand, tz: zone };
}

/**
 * A compact, exact spelling of a rule: freq[/interval][:days][@time]. Weekly days are the weekdays;
 * monthly is d15 (day of month), FR#-1 (the Nth weekday, -1 = last) or last (the last day). No days means
 * the anchor decides (weekdays null, monthly null). The zone of an `@time` is checked on its own.
 */
export function ruleKey(r: RepeatRule): string {
	let s: string = r.freq;
	if (r.interval !== 1) s += `/${r.interval}`;
	if (r.weekdays !== null) s += `:${r.weekdays.join(",")}`;
	if (r.monthly !== null) {
		s += r.monthly.kind === "day" ? `:d${r.monthly.day}` : r.monthly.kind === "lastDay" ? ":last" : `:${r.monthly.weekday}#${r.monthly.n}`;
	}
	if (r.afterCompletion) s += "!after";
	if (r.time !== null) s += `@${r.time}`;
	return s;
}

/**
 * One line per chip: status|kind|text plus the extras that are present. Each alternative is label=value, the value a
 * date, a local wall time or a ruleKey.
 */
export function chipLine(c: Chip): string {
	let s = `${c.status}|${c.kind}|${c.text}`;
	if (c.warning) s += `|w=${c.warning}`;
	if (c.status === "suggestion" && c.date) s += `|d=${specText(c.date)}`;
	if (c.newTag) s += "|new";
	if (c.rule) s += `|r=${ruleKey(c.rule)}`;
	if (c.alternatives) s += `|a=${c.alternatives.map((a) => `${a.label}=${a.rule === undefined ? specText(a.value) : ruleKey(a.rule)}`).join("/")}`;
	if (c.candidates) s += `|c=${c.candidates.join("+")}`;
	if (c.notice) s += `|n=${c.notice}`;
	return s;
}

export function chipLines(r: ParseResult): string[] {
	return r.chips.map(chipLine);
}
