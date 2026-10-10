import { DateTime } from "luxon";
import type { Chip, DateLocale, ParseContext, ParseResult, ParsedField, SpanDecision } from "../../src/parsing/types";
import type { DateSpec, RepeatRule } from "../../src/domain/types";

export const NY = "America/New_York";
export const BERLIN = "Europe/Berlin";
export const TOKYO = "Asia/Tokyo";

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

/** One line per chip: status|kind|text plus the extras that are present. */
export function chipLine(c: Chip): string {
	let s = `${c.status}|${c.kind}|${c.text}`;
	if (c.warning) s += `|w=${c.warning}`;
	if (c.status === "suggestion" && c.date) s += `|d=${c.date.kind === "date" ? c.date.date : c.date.local}`;
	if (c.newTag) s += "|new";
	if (c.rule) s += `|r=${ruleKey(c.rule)}`;
	if (c.alternatives) s += `|a=${c.alternatives.map((a) => a.label).join("/")}`;
	if (c.candidates) s += `|c=${c.candidates.join("+")}`;
	if (c.notice) s += `|n=${c.notice}`;
	return s;
}

export function chipLines(r: ParseResult): string[] {
	return r.chips.map(chipLine);
}
