import type { WallTimeWarning } from "../domain/time";
import type { DateLocale, DateSpec, LocalDate, Priority, RepeatEnd, RepeatRule, WeekStart } from "../domain/types";

// Quick Add parser contract.

export type { DateLocale };
export type ParsedField = "scheduled" | "deadline" | "duration" | "category" | "tags" | "note" | "priority" | "recurrence";
/** "repeatEnd": the end of a typed repeat (`until Dec 1`, `for 5 times`); it belongs to the recurrence field. */
export type ChipKind = "scheduled" | "deadline" | "duration" | "category" | "tag" | "note" | "recurrence" | "repeatEnd" | "priority";

/** UTF-16 offsets into the input; end is exclusive. */
export interface Span {
	start: number;
	end: number;
}

/** A user decision about one span. It applies only while input.slice(span.start, span.end) === text. */
export type SpanDecision =
	| { span: Span; text: string; kind: "literal" } // dismissed
	| { span: Span; text: string; kind: "accept" } // apply a suggestion, or replace a manual field
	| { span: Span; text: string; kind: "date"; value: DateSpec } // chosen alternative or edited value
	| { span: Span; text: string; kind: "rule"; rule: RepeatRule } // chosen reading of a typed repeat's bare hour
	| { span: Span; text: string; kind: "category"; categoryId: string } // suggester binding or unresolved pick
	| { span: Span; text: string; kind: "tag"; key: string } // suggester binding to an existing tag
	| { span: Span; text: string; kind: "note"; path: string }; // suggester binding or collision pick

export type ChipStatus =
	| "applied"
	| "suggestion"
	| "choice"
	| "unresolved"
	| "collision"
	| "missing"
	| "invalid"
	| "superseded"
	| "unsupported";

/** One option of a "choice" chip: a date value, or (a typed repeat's bare hour) the rule with that reading. */
export type ChipAlternative = { label: string; value: DateSpec; rule?: undefined } | { label: string; rule: RepeatRule; value?: undefined };

export interface Chip {
	/** Stable while the span text and position are unchanged: `${kind}:${start}:${end}`. */
	id: string;
	kind: ChipKind;
	span: Span;
	text: string;
	status: ChipStatus;
	date?: DateSpec;
	alternatives?: ChipAlternative[];
	warning?: WallTimeWarning;
	durationMin?: number;
	/** 1 high, 2 medium, 3 low (a chip never carries 0). */
	priority?: 1 | 2 | 3;
	categoryId?: string;
	tagKey?: string;
	newTag?: boolean;
	notePath?: string;
	candidates?: string[];
	/** The rule of a typed `every …` that was built (applied, or a suggestion for an ambiguous time). */
	rule?: RepeatRule;
	/** The end of a "repeatEnd" chip: a date or a count (`for N weeks` is a date, set once the start is known). */
	end?: RepeatEnd;
	/** Sentence-case text shown with the chip, e.g. "Recurrence not supported yet". */
	notice?: string;
}

export interface ParsedFields {
	scheduled?: DateSpec;
	deadline?: DateSpec;
	plannedDurationMin?: number;
	/** Set only when a priority chip is applied; absent means "no typed priority". */
	priority?: Exclude<Priority, 0>;
	categoryId?: string;
	tagKeys: string[]; // existing tags
	newTags: string[]; // names to create on save, as typed; deduped by key, first casing wins
	notePath?: string;
	/** Set only when a recurrence chip is applied. No anchor: the service starts it from the date. */
	recurrence?: RepeatRule;
	/** The typed end, when a "repeatEnd" chip is applied: of `recurrence`, or of a repeat picked by hand. */
	recurrenceEnd?: RepeatEnd;
}

export interface ParseResult {
	input: string;
	/** Sorted by span.start; never overlapping; literal decisions produce no chip. */
	chips: Chip[];
	title: string;
	titleFallback: boolean;
	fields: ParsedFields;
	/** Ids of chips that block saving: unresolved categories, invalid repeat ends. */
	blocking: string[];
}

export interface ParseContext {
	now: Date;
	zone: string; // IANA
	locale: DateLocale;
	/** "tonight" is today at this "HH:mm" local time; default "20:00". */
	eveningTime?: string;
	categories: readonly { id: string; name: string }[];
	/** `createdAt` decides who owns a name that two tags use: the oldest. */
	tags: readonly { key: string; displayName: string; createdAt?: string }[];
	resolveNote: (linktext: string) => string[];
	decisions: readonly SpanDecision[];
	manual: ReadonlySet<ParsedField>;
	/**
	 * The date a task starts from when no date is typed: one picked by hand or a view's preset. A typed repeat end counts
	 * from it (`for 2 weeks`) and is checked against it; absent means today.
	 */
	startDate?: LocalDate;
	/** The week start setting, for checking an end against a weekly repeat of several weeks; default Monday. */
	weekStart?: WeekStart;
	/** The repeat picked by hand has an end of its own: a typed end replaces it only when accepted. */
	pickedEnd?: boolean;
	/** The rule of the repeat picked by hand: a typed end with no typed repeat is checked against it. */
	pickedRule?: RepeatRule;
}
