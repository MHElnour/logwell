import { INBOX_NAME, type Priority } from "../../domain/types";
import { formatDateSpec, formatDuration, specFromInputs } from "../format";
import { ICON } from "../icons";
import { repeatLine } from "../repeat";
import { priorityLabel } from "./chipLabels";
import type { QuickAddModel } from "./QuickAddModel";

// Pills for the values set by hand (the date popover, the more menu, the modal's fields).
// The parser's chips only cover what was typed, so without these a picked value would have
// no visible feedback in the inline bar. Same pill look, a different class: they are not chips.

interface ManualPill {
	key: string;
	kind: "scheduled" | "deadline" | "duration" | "priority" | "category" | "note" | "tag" | "quadrant" | "recurrence";
	label: string;
	icon: string;
	priority?: Priority;
	remove: () => void;
}

export function manualPills(model: QuickAddModel): ManualPill[] {
	const out: ManualPill[] = [];
	const app = model.env.app;
	const zone = app.settings.zone();
	const today = app.queryContext().today;
	const vals = model.vals;

	if (model.manual.has("scheduled")) {
		const spec = specFromInputs(vals.date, vals.time, zone);
		out.push({
			key: "scheduled",
			kind: "scheduled",
			label: spec === null ? "No date" : `Date: ${formatDateSpec(spec, zone, today)}`,
			icon: "calendar",
			remove: () => model.revertManual("scheduled"),
		});
	}
	if (model.manual.has("deadline")) {
		const spec = specFromInputs(vals.deadline, "", zone);
		out.push({
			key: "deadline",
			kind: "deadline",
			label: spec === null ? "No deadline" : `Deadline: ${formatDateSpec(spec, zone, today)}`,
			icon: ICON.flag,
			remove: () => model.revertManual("deadline"),
		});
	}
	if (model.manual.has("duration")) {
		const n = Number(vals.duration);
		out.push({
			key: "duration",
			kind: "duration",
			label: Number.isInteger(n) && n > 0 ? `Duration: ${formatDuration(n)}` : `Duration: ${vals.duration}`,
			icon: ICON.clock,
			remove: () => model.revertManual("duration"),
		});
	}
	// A repeat picked by hand. "Never" has no pill (like a priority of none); it only keeps a typed `every …` from applying.
	if (model.manual.has("recurrence") && vals.repeat !== null) {
		out.push({
			key: "recurrence",
			kind: "recurrence",
			label: `Repeat: ${repeatLine(vals.repeat, model.repeatAnchor(), today)}`,
			icon: "repeat",
			remove: () => model.revertManual("recurrence"),
		});
	}
	if (model.manual.has("priority") && vals.priority !== 0) {
		out.push({
			key: "priority",
			kind: "priority",
			label: priorityLabel(vals.priority),
			icon: ICON.flag,
			priority: vals.priority,
			remove: () => model.revertManual("priority"),
		});
	}
	if (model.manual.has("category") && model.parent === undefined) {
		const name = app.categories.list().find((c) => c.id === vals.categoryId)?.name ?? INBOX_NAME;
		out.push({ key: "category", kind: "category", label: `List: ${name}`, icon: ICON.list, remove: () => model.revertManual("category") });
	}
	if (model.manual.has("note") && vals.notePath !== null) {
		out.push({ key: "note", kind: "note", label: `Note: ${vals.notePath}`, icon: ICON.note, remove: () => model.setNote(null) });
	}
	if (model.tagKeys !== null) {
		const tags = app.tags.list();
		for (const key of model.tagKeys) {
			const name = tags.find((t) => t.key === key)?.displayName ?? key;
			out.push({
				key: `tag:${key}`,
				kind: "tag",
				label: `@${name}`,
				icon: "tag",
				remove: () => model.setTags((model.tagKeys ?? []).filter((k) => k !== key)),
			});
		}
	}
	if (model.urgent) out.push({ key: "urgent", kind: "quadrant", label: "Urgent", icon: "layout-grid", remove: () => model.setFlag("urgent", false) });
	if (model.important) out.push({ key: "important", kind: "quadrant", label: "Important", icon: "layout-grid", remove: () => model.setFlag("important", false) });
	return out;
}
