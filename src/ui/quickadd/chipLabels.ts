import { DST_WARNING_TEXT } from "../../app/TaskService";
import { tagLabel } from "../../domain/tags";
import type { Category, LocalDate, Priority, Tag } from "../../domain/types";
import type { Chip } from "../../parsing";
import { formatDateSpec, formatDuration } from "../format";
import { NEVER_END, ruleText } from "../repeat";

// Text of the Quick Add chips. Sentence case; no state, so it is easy to test.

interface LabelEnv {
	zone: string;
	today: LocalDate;
	categories: readonly Category[];
	tags: ReadonlyMap<string, Tag>;
	/** The date a typed repeat starts from (the picked date, else today); it names "on the 9th" for "every month". */
	anchor?: LocalDate;
}

/** "High priority", "Medium priority", "Low priority"; none has no label of its own. */
export function priorityLabel(priority: Priority): string {
	return priority === 1 ? "High priority" : priority === 2 ? "Medium priority" : priority === 3 ? "Low priority" : "No priority";
}

function dateText(chip: Chip, env: LabelEnv): string {
	return chip.date === undefined ? chip.text : formatDateSpec(chip.date, env.zone, env.today);
}

/** The visible label, without the notice or warning. */
export function chipLabel(chip: Chip, env: LabelEnv): string {
	switch (chip.kind) {
		case "scheduled":
			return chip.status === "choice" ? `Date or time: ${chip.text}` : `Date: ${dateText(chip, env)}`;
		case "deadline":
			return chip.status === "choice" ? `Deadline: ${chip.text}` : `Deadline: ${dateText(chip, env)}`;
		case "duration":
			return chip.durationMin === undefined ? `Duration: ${chip.text}` : `Duration: ${formatDuration(chip.durationMin)}`;
		case "category": {
			if (chip.status === "unresolved") return `Unknown list: ${chip.text.replace(/^#/u, "")}`;
			const name = env.categories.find((c) => c.id === chip.categoryId)?.name;
			return `List: ${name ?? chip.text}`;
		}
		case "tag": {
			if (chip.newTag === true) return `New tag: ${chip.text.replace(/^@/u, "")}`;
			return chip.tagKey === undefined ? `@${chip.text}` : `@${tagLabel(env.tags, chip.tagKey)}`;
		}
		case "note":
			if (chip.status === "applied") return `Note: ${chip.notePath ?? chip.text}`;
			return `Note: ${chip.text}`;
		case "priority":
			return chip.priority === undefined ? `Priority: ${chip.text}` : priorityLabel(chip.priority);
		case "recurrence":
			// An applied chip shows the rule it became ("every Fri"); a chip that is not applied keeps the typed text.
			return chip.rule === undefined ? `Repeat: ${chip.text}` : `Repeat: ${ruleText({ rule: chip.rule, end: NEVER_END }, env.anchor ?? env.today)}`;
	}
}

/** The line shown after the label: the parser's notice and the DST warning. */
export function chipHint(chip: Chip, notice: string | undefined): string | null {
	const parts: string[] = [];
	if (notice !== undefined) parts.push(notice);
	if (chip.warning !== undefined) parts.push(DST_WARNING_TEXT[chip.warning]);
	return parts.length === 0 ? null : parts.join(". ");
}

/** What Enter or a click does on the chip, for the accessible name. */
export function chipActionHint(chip: Chip, canEdit: boolean, fixed: boolean): string {
	if (chip.status === "suggestion") return fixed ? "" : "Press Enter to use it. ";
	if (chip.status === "choice") return "Press Enter to choose. ";
	if (chip.status === "unresolved") return fixed ? "" : "Press Enter to choose a list. ";
	if (chip.status === "collision") return "Press Enter to choose a note. ";
	if (chip.status === "applied" && canEdit) return "Press Enter to edit. ";
	return "";
}
