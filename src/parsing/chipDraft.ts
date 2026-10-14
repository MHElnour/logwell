import type { Chip, ChipKind, ParsedField, Span } from "./types";

// The chips the Quick Add parser drafts, and the notices they carry. Shared by the parser and the repeat binding.

export const NOTICE = {
	superseded: "Replaced by a later value",
	useAsDate: "Use as date?",
	useAsEndDate: "Use as end date?",
	endWaits: "Applies once the repeat's time is chosen",
	replaceEnd: "Replace repeat end?",
	recurrence: "Recurrence not supported yet",
	duration: "Duration must be 1 to 1440 minutes",
} as const;

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

function chipId(kind: ChipKind, span: Span): string {
	return `${kind}:${span.start}:${span.end}`;
}

export interface Draft {
	chip: Chip;
	/** Whether the chip counts as applied before manual fields and decisions are considered. */
	field: ParsedField | null;
}

export function draft(input: string, kind: ChipKind, span: Span, status: Chip["status"], extra: Partial<Chip>): Draft {
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
