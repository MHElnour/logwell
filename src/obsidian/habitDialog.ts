import { type App, Modal, setIcon } from "obsidian";
import { type HabitInput, validateHabitInput } from "../domain/habits";
import { type GoalType, type TagColor, type TimeOfDay, WEEKDAYS, type Weekday } from "../domain/types";
import { TIME_OF_DAY_NAME, parseAmount } from "../ui/habits/format";
import type { HabitDialogOptions } from "../ui/host";
import { WEEKDAY_LONG, WEEKDAY_TWO_LETTER } from "../ui/repeat";
import { el } from "./dom";
import { buildColorRow, pickListIcon } from "./modals";

// The New habit / Edit habit dialog. The form is plain
// DOM (buildHabitForm) so it is tested without a Modal, as buildNewListForm is; HabitModal wraps it. The
// segments, chips and switch are aria-pressed / role=switch buttons, and every group is named by a visible label
// (aria-labelledby), never by an aria-label that Obsidian would show as a tooltip.

let formSeq = 0;

type ScheduleKind = "daily" | "weekdays" | "weekly";

export interface HabitFormDeps {
	setIcon: (el: HTMLElement, icon: string) => void;
	/** The icon picker; resolves a Lucide name, null for "None", or undefined when dismissed. */
	pickIcon: (current: string | null) => Promise<string | null | undefined>;
	/** The values to start from (Edit, an example chip), or null for an empty form. */
	initial: HabitInput | null;
	/** The swatch that starts selected for an empty form; null = the "Default" swatch (the accent). */
	defaultColor: TagColor | null;
	submitLabel: string;
	/** Resolves a message to show inline (the form stays as it is), or null when it saved. */
	onSubmit: (input: HabitInput) => Promise<string | null>;
	onCancel: () => void;
}

const TYPES: { value: GoalType; title: string; hint: string }[] = [
	{ value: "binary", title: "Done or not", hint: "Meditate, take vitamins" },
	{ value: "count", title: "Count", hint: "8 glasses, 50 push-ups" },
	{ value: "quantity", title: "Amount", hint: "30 min, 5 km, 20 pages" },
];

const SCHEDULES: { value: ScheduleKind; title: string; hint: string }[] = [
	{ value: "daily", title: "Every day", hint: "Streak counts days" },
	{ value: "weekdays", title: "Some days", hint: "Pick weekdays" },
	{ value: "weekly", title: "Times a week", hint: "Any days, n per week" },
];

const TIMES = (Object.keys(TIME_OF_DAY_NAME) as TimeOfDay[]).map((value) => ({ value, title: TIME_OF_DAY_NAME[value] }));

const DEFAULT_TARGET: Readonly<Record<GoalType, string>> = { binary: "1", count: "8", quantity: "30" };

/** A row of `aria-pressed` buttons where one is on. */
function segment<T extends string>(
	parent: HTMLElement,
	labelId: string,
	items: { value: T; title: string; hint?: string }[],
	initial: T,
	onPick: (value: T) => void,
	cls = "",
): { set: (value: T) => void } {
	const group = el(parent, "div", `cp-habit-seg${cls === "" ? "" : ` ${cls}`}`, { role: "group", "aria-labelledby": labelId });
	const buttons = items.map((item) => {
		const b = el(group, "button", "", { type: "button", "aria-pressed": String(item.value === initial) });
		el(b, "b", "", {}, item.title);
		if (item.hint !== undefined) el(b, "small", "", {}, item.hint);
		b.addEventListener("click", () => onPick(item.value));
		return b;
	});
	return { set: (value) => buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(items[i]!.value === value))) };
}

/**
 * The New habit form in `container`. Returns `focus()` for the name field. The Notification permission is not asked
 * here: the caller's `save` does it, in the click that submits.
 */
export function buildHabitForm(container: HTMLElement, deps: HabitFormDeps): { focus: () => void } {
	const seq = ++formSeq;
	const id = (part: string) => `cp-habit-form-${part}-${seq}`;
	const init = deps.initial;

	// State that is not read back from an input.
	let icon: string | null = init?.icon ?? null;
	let type: GoalType = init?.goal.type ?? "binary";
	// The period follows the schedule, so one value holds both.
	let schedule: ScheduleKind = init === null ? "daily" : init.goal.period === "week" || init.schedule.kind === "weekly" ? "weekly" : init.schedule.kind;
	const days = new Set<Weekday>(init?.schedule.kind === "weekdays" ? init.schedule.days : (["MO", "TU", "WE", "TH", "FR"] as Weekday[]));
	let timeOfDay: TimeOfDay = init?.timeOfDay ?? "anytime";
	let reminderOn = init?.reminder != null;
	let targetTouched = init !== null;

	const form = el(container, "form", "cp-habit-form");

	// Name, icon and color.
	const nameField = el(form, "div", "cp-habit-field");
	el(nameField, "label", "cp-habit-label", { for: id("name") }, "Name");
	const nameRow = el(nameField, "div", "cp-habit-name-row");
	const iconButton = el(nameRow, "button", "cp-habit-icon-button", { type: "button", "aria-label": "Choose icon" });
	const iconSlot = el(iconButton, "span", "cp-habit-icon-slot");
	const name = el(nameRow, "input", "cp-habit-text", { type: "text", id: id("name"), placeholder: "Read", maxlength: "80", autocomplete: "off" });
	name.value = init?.name ?? "";
	const colorLabelId = id("color");
	el(nameField, "span", "cp-habit-label", { id: colorLabelId }, "Color");
	const colors = buildColorRow(nameField, colorLabelId, init === null ? deps.defaultColor : init.color, (c) => paintIcon(c));
	const paintIcon = (color: TagColor | null) => {
		iconButton.className = `cp-habit-icon-button cp-habit-icon cp-hue-${color ?? "none"}`;
		iconSlot.replaceChildren();
		deps.setIcon(iconSlot, icon ?? "flame");
	};
	paintIcon(colors.value());
	iconButton.addEventListener("click", () => {
		void deps.pickIcon(icon).then((picked) => {
			if (picked === undefined) return;
			icon = picked;
			paintIcon(colors.value());
		});
	});

	// How do you track it?
	const typeField = el(form, "div", "cp-habit-field");
	const typeLabel = id("type");
	el(typeField, "span", "cp-habit-label", { id: typeLabel }, "How do you track it?");
	const typeSeg = segment(typeField, typeLabel, TYPES, type, (t) => setType(t));

	// Goal.
	const goalField = el(form, "div", "cp-habit-field");
	const goalLabel = id("goal");
	el(goalField, "span", "cp-habit-label", { id: goalLabel }, "Goal");
	const goalLine = el(goalField, "div", "cp-habit-goal-line", { role: "group", "aria-labelledby": goalLabel });
	const target = el(goalLine, "input", "cp-habit-text cp-habit-target", { type: "text", inputmode: "decimal", autocomplete: "off", "aria-label": "Target" });
	target.value = init === null ? DEFAULT_TARGET[type] : String(init.goal.target);
	const unit = el(goalLine, "input", "cp-habit-text cp-habit-unit-input", { type: "text", autocomplete: "off", maxlength: "12", "aria-label": "Unit" });
	unit.value = init?.goal.unit ?? "";
	const times = el(goalLine, "span", "cp-habit-goal-text", {}, "times per week");
	const per = el(goalLine, "span", "cp-habit-goal-text", {}, "per");
	const selectWrap = el(goalLine, "span", "cp-habit-select");
	const period = el(selectWrap, "select", "", { "aria-label": "Period" });
	el(period, "option", "", { value: "day" }, "day");
	el(period, "option", "", { value: "week" }, "week");
	target.addEventListener("input", () => {
		targetTouched = true;
	});
	period.addEventListener("change", () => setSchedule(period.value === "week" ? "weekly" : "daily"));

	// When.
	const whenField = el(form, "div", "cp-habit-field");
	const whenLabel = id("when");
	el(whenField, "span", "cp-habit-label", { id: whenLabel }, "When");
	const scheduleSeg = segment(whenField, whenLabel, SCHEDULES, schedule, (s) => setSchedule(s));
	// The weekday chips are their own group: they get their own (visually hidden) name, not the Schedule segment's.
	const chipsLabel = id("days");
	el(whenField, "span", "cp-sr-only", { id: chipsLabel }, "Weekdays");
	const chips = el(whenField, "div", "cp-habit-chips", { role: "group", "aria-labelledby": chipsLabel });
	WEEKDAYS.forEach((d) => {
		const b = el(chips, "button", "", { type: "button", "aria-pressed": String(days.has(d)), "aria-label": WEEKDAY_LONG[d] }, WEEKDAY_TWO_LETTER[d]);
		b.addEventListener("click", () => {
			if (!days.delete(d)) days.add(d);
			b.setAttribute("aria-pressed", String(days.has(d)));
		});
	});
	el(whenField, "p", "cp-habit-hint", {}, "Changing a goal later applies from that day on. Past days keep the goal they had.");

	// Time of day.
	const todField = el(form, "div", "cp-habit-field");
	const todLabel = id("tod");
	el(todField, "span", "cp-habit-label", { id: todLabel }, "Time of day");
	const todSeg = segment(todField, todLabel, TIMES, timeOfDay, (t) => {
		timeOfDay = t;
		todSeg.set(t);
	}, "is-four");

	// Reminder.
	const remField = el(form, "div", "cp-habit-field");
	const remLabel = id("rem");
	el(remField, "span", "cp-habit-label", { id: remLabel }, "Reminder");
	const rem = el(remField, "div", "cp-habit-rem", { role: "group", "aria-labelledby": remLabel });
	const remSwitch = el(rem, "button", "cp-habit-switch", { type: "button", role: "switch", "aria-label": "Remind me", "aria-checked": String(reminderOn) });
	el(rem, "span", "cp-habit-rem-text", {}, "Remind me at");
	const remTime = el(rem, "input", "cp-habit-time", { type: "time", "aria-label": "Reminder time" });
	remTime.value = init?.reminder?.time ?? "20:00";
	el(rem, "span", "cp-habit-hint", {}, "if not done yet");
	el(remField, "p", "cp-habit-hint", {}, "Reminders appear while Obsidian is open on this device: a notice, and a system notification on desktop.");
	remSwitch.addEventListener("click", () => {
		reminderOn = !reminderOn;
		syncReminder();
	});

	const error = el(form, "p", "cp-habit-form-error", { role: "alert" });
	error.hidden = true;

	const actions = el(form, "div", "cp-habit-actions");
	const cancel = el(actions, "button", "", { type: "button" }, "Cancel");
	cancel.addEventListener("click", () => deps.onCancel());
	const save = el(actions, "button", "mod-cta", { type: "submit" }, deps.submitLabel);

	// -- state changes ------------------------------------------------------------------

	function syncReminder(): void {
		remSwitch.setAttribute("aria-checked", String(reminderOn));
		remSwitch.classList.toggle("is-on", reminderOn);
		remTime.disabled = !reminderOn;
	}

	/** Which parts of the Goal line show: done-or-not has a target only under Times a week. */
	function syncGoal(): void {
		const binary = type === "binary";
		goalField.hidden = binary && schedule !== "weekly";
		unit.hidden = binary;
		unit.placeholder = type === "count" ? "glasses (optional)" : "min";
		unit.setAttribute("aria-label", type === "count" ? "Unit (optional)" : "Unit");
		times.hidden = !(binary && schedule === "weekly");
		per.hidden = binary;
		selectWrap.hidden = binary;
		period.value = schedule === "weekly" ? "week" : "day";
		target.setAttribute("aria-label", binary ? "Times per week" : "Target");
	}

	function setType(next: GoalType): void {
		type = next;
		typeSeg.set(next);
		if (!targetTouched) target.value = next === "binary" && schedule === "weekly" ? "3" : DEFAULT_TARGET[next];
		syncGoal();
	}

	/** Times a week is the week period; Every day and Some days are the day period. */
	function setSchedule(next: ScheduleKind): void {
		const wasWeekly = schedule === "weekly";
		schedule = next;
		scheduleSeg.set(next);
		chips.hidden = next !== "weekdays";
		if (type === "binary" && !targetTouched) target.value = next === "weekly" ? "3" : "1";
		else if (type === "binary" && wasWeekly && next !== "weekly") target.value = "1";
		syncGoal();
	}

	setType(type);
	setSchedule(schedule);
	syncReminder();

	// -- submit -------------------------------------------------------------------------

	const build = (): HabitInput => {
		const binaryDaily = type === "binary" && schedule !== "weekly";
		return {
			name: name.value.trim(),
			icon,
			color: colors.value(),
			timeOfDay,
			reminder: reminderOn ? { time: remTime.value } : null,
			goal: {
				type,
				target: binaryDaily ? 1 : parseAmount(target.value) ?? Number.NaN,
				unit: type === "binary" ? null : unit.value.trim() === "" ? null : unit.value.trim(),
				period: schedule === "weekly" ? "week" : "day",
			},
			schedule: schedule === "weekdays" ? { kind: "weekdays", days: WEEKDAYS.filter((d) => days.has(d)) } : { kind: schedule },
		};
	};

	const showError = (message: string) => {
		error.textContent = message;
		error.hidden = false;
		// The field the message is about takes the focus.
		const field = /name/iu.test(message) ? name : /unit/iu.test(message) ? unit : /goal|number|count|times|decimals|week/iu.test(message) ? target : null;
		field?.focus();
	};
	let busy = false;
	const submit = async () => {
		if (busy) return;
		const input = build();
		const message = validateHabitInput(input);
		if (message !== null) return showError(message);
		busy = true;
		save.disabled = true;
		try {
			// Called before the first await, so the click that submitted is still the user gesture.
			const answer = await deps.onSubmit(input);
			if (answer !== null && answer !== "") showError(answer);
		} finally {
			busy = false;
			save.disabled = false;
		}
	};
	form.addEventListener("submit", (e) => {
		e.preventDefault();
		void submit();
	});
	for (const input of [name, target, unit, remTime]) {
		input.addEventListener("input", () => {
			error.hidden = true;
		});
	}
	return { focus: () => name.focus() };
}

export class HabitModal extends Modal {
	constructor(
		app: App,
		private readonly cpOptions: HabitDialogOptions,
		private readonly cpResolve: () => void,
		private readonly cpAccentClass: string = "",
	) {
		super(app);
	}

	override onOpen(): void {
		this.setTitle(this.cpOptions.title);
		// "checkpoint-icon-picker" carries the design tokens (accent, hues) for modals; the others scope the form.
		this.modalEl.addClass("checkpoint-icon-picker", "checkpoint-habit-dialog");
		if (this.cpAccentClass !== "") this.modalEl.addClass(this.cpAccentClass);
		const form = buildHabitForm(this.contentEl, {
			setIcon: (el, icon) => setIcon(el, icon),
			pickIcon: (current) => pickListIcon(this.app, current, this.cpAccentClass),
			initial: this.cpOptions.initial,
			defaultColor: this.cpOptions.defaultColor,
			submitLabel: this.cpOptions.submit,
			onSubmit: async (input) => {
				const message = await this.cpOptions.save(input);
				if (message === null) this.close();
				return message;
			},
			onCancel: () => this.close(),
		});
		window.setTimeout(() => form.focus(), 0);
	}

	override onClose(): void {
		this.contentEl.empty();
		this.cpResolve();
	}
}

/** The New habit / Edit habit dialog. Resolves when it is gone: saved, or dismissed (Escape or Cancel). */
export function habitDialog(app: App, options: HabitDialogOptions, accentClass = ""): Promise<void> {
	return new Promise((resolve) => new HabitModal(app, options, resolve, accentClass).open());
}
