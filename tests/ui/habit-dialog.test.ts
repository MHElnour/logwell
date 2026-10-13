// @vitest-environment happy-dom
import { Modal } from "obsidian";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type HabitInput, validateHabitInput } from "../../src/domain/habits";
import { HabitModal, buildHabitForm } from "../../src/obsidian/habitDialog";
import { habitDialogOptions } from "../../src/ui/habits/actions";
import type { HabitDialogOptions } from "../../src/ui/host";
import { appHarness } from "../app/harness";
import { fill, mountNode, obsidianElement, type ObsidianElement, q as qIn, recordNotices, text, U1Host } from "./app-helpers";

// The New habit / Edit habit dialog (period coupling, rules and messages, prefill, Save, the Modal).
// The form is plain DOM (buildHabitForm), so it is tested without Obsidian's Modal, as buildNewListForm is.

afterEach(() => document.body.replaceChildren());

const empty: HabitInput = {
	name: "Read",
	icon: null,
	color: null,
	timeOfDay: "anytime",
	reminder: null,
	goal: { type: "binary", target: 1, unit: null, period: "day" },
	schedule: { kind: "daily" },
};

function form(patch: { initial?: HabitInput | null; defaultColor?: "red" | null; result?: string | null; pick?: string | null | undefined } = {}) {
	const container = mountNode(null);
	const onSubmit = vi.fn<(v: HabitInput) => Promise<string | null>>(async () => patch.result ?? null);
	const onCancel = vi.fn();
	const pickIcon = vi.fn<(current: string | null) => Promise<string | null | undefined>>(async () => patch.pick);
	const f = buildHabitForm(container, {
		setIcon: (el, icon) => el.setAttribute("data-icon", icon),
		pickIcon,
		initial: patch.initial ?? null,
		defaultColor: patch.defaultColor ?? null,
		submitLabel: "Create habit",
		onSubmit,
		onCancel,
	});
	const q = <T extends HTMLElement>(sel: string) => qIn<T>(container, sel);
	const group = (label: string) => {
		const labelEl = [...container.querySelectorAll<HTMLElement>("[id]")].find((e) => text(e) === label);
		if (labelEl === undefined) throw new Error(`no label ${label}`);
		return container.querySelector<HTMLElement>(`[role="group"][aria-labelledby="${labelEl.id}"]`)!;
	};
	const buttons = (label: string) => [...group(label).querySelectorAll<HTMLButtonElement>("button")];
	const pressed = (label: string) => buttons(label).filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => text(b.querySelector("b") ?? b));
	const pick = (label: string, title: string) => buttons(label).find((b) => text(b.querySelector("b") ?? b) === title)!.click();
	const type = fill;
	const submit = async () => {
		q("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		await new Promise((r) => setTimeout(r, 0));
	};
	const target = () => q<HTMLInputElement>(".cp-habit-target");
	const unit = () => q<HTMLInputElement>(".cp-habit-unit-input");
	const period = () => q<HTMLSelectElement>(".cp-habit-select select");
	const error = () => q(".cp-habit-form-error");
	const name = () => q<HTMLInputElement>(`input[type="text"]:not(.cp-habit-target):not(.cp-habit-unit-input)`);
	return { container, f, q, group, buttons, pressed, pick, type, submit, target, unit, period, error, name, onSubmit, onCancel, pickIcon };
}

const lastInput = (t: ReturnType<typeof form>) => t.onSubmit.mock.calls.at(-1)![0];

describe("the form", () => {
	it("has the mockup's fields: name with icon and color, how to track, goal, when, time of day, reminder, buttons", () => {
		const t = form({ defaultColor: "red" });
		expect(t.q("label").textContent).toBe("Name");
		expect(t.q("button.cp-habit-icon-button").getAttribute("aria-label")).toBe("Choose icon");
		expect(t.pressed("How do you track it?")).toEqual(["Done or not"]);
		expect(t.buttons("How do you track it?").map((b) => text(b))).toEqual(["Done or notMeditate, take vitamins", "Count8 glasses, 50 push-ups", "Amount30 min, 5 km, 20 pages"]);
		expect(t.pressed("When")).toEqual(["Every day"]);
		expect(t.buttons("When").map((b) => text(b.querySelector("b")))).toEqual(["Every day", "Some days", "Times a week"]);
		expect(t.pressed("Time of day")).toEqual(["Anytime"]);
		expect(t.buttons("Time of day").map(text)).toEqual(["Morning", "Afternoon", "Evening", "Anytime"]);
		// The color row is the New list one: Default and eight colors; the default swatch starts selected.
		const swatches = [...t.container.querySelectorAll<HTMLButtonElement>(".cp-color-choice")];
		expect(swatches.map((b) => b.getAttribute("aria-label"))).toEqual(["Default", "Red", "Orange", "Yellow", "Green", "Cyan", "Blue", "Purple", "Pink"]);
		expect(swatches.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", ...Array<string>(7).fill("false")]);
		expect(text(t.q(".cp-habit-hint"))).toBe("Changing a goal later applies from that day on. Past days keep the goal they had.");
		expect(text(t.container.querySelector("button[type=submit]"))).toBe("Create habit");
		expect(text([...t.container.querySelectorAll("button")].find((b) => b.textContent === "Cancel"))).toBe("Cancel");
	});

	it("names every group by a visible label, never by an aria-label", () => {
		const t = form();
		const groups = t.container.querySelectorAll('[role="group"]');
		expect(groups.length).toBeGreaterThanOrEqual(6);
		for (const g of groups) {
			expect(g.hasAttribute("aria-label")).toBe(false);
			expect(text(t.container.querySelector(`#${g.getAttribute("aria-labelledby")}`))).not.toBe("");
		}
		for (const b of t.container.querySelectorAll<HTMLButtonElement>("button")) expect(b.type).toBe(b.classList.contains("mod-cta") ? "submit" : "button");
	});

	it("the reminder is a switch with a time input that is disabled while it is off, and the hints", () => {
		const t = form();
		const sw = t.q("button.cp-habit-switch");
		expect(sw.getAttribute("role")).toBe("switch");
		expect(sw.getAttribute("aria-checked")).toBe("false");
		expect(sw.getAttribute("aria-label")).toBe("Remind me");
		const time = t.q<HTMLInputElement>('input[type="time"]');
		expect(time.getAttribute("aria-label")).toBe("Reminder time");
		expect(time.disabled).toBe(true);
		sw.click();
		expect(sw.getAttribute("aria-checked")).toBe("true");
		expect(time.disabled).toBe(false);
		expect(text(t.container)).toContain("Reminders appear while Obsidian is open on this device: a notice, and a system notification on desktop.");
		expect(text(t.container)).toContain("if not done yet");
	});
});

describe("weekday label, reminder default and goal digits (F6, F10, D7)", () => {
	it("F6: the weekday chips have their own Weekdays label, not the When segment's", () => {
		const t = form();
		const chips = t.q(".cp-habit-chips");
		const when = [...t.container.querySelectorAll<HTMLElement>("[id]")].find((e) => text(e) === "When")!;
		expect(chips.getAttribute("aria-labelledby")).not.toBe(when.id);
		expect(text(t.container.querySelector(`#${chips.getAttribute("aria-labelledby")}`))).toBe("Weekdays");
		expect(t.container.querySelector(`#${chips.getAttribute("aria-labelledby")}`)!.classList.contains("cp-sr-only")).toBe(true);
		const segment = t.q(`.cp-habit-seg[aria-labelledby="${when.id}"]`);
		expect(segment).not.toBe(chips);
		const ids = [...t.container.querySelectorAll("[id]")].map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("F10: a new habit's reminder time starts at 20:00", () => {
		const t = form();
		expect(t.q<HTMLInputElement>('input[type="time"]').value).toBe("20:00");
	});

	it("D7: the goal target takes digits with a point or a decimal comma only", async () => {
		const t = form();
		t.type(t.name(), "Read");
		t.pick("How do you track it?", "Amount");
		t.type(t.unit(), "km");
		for (const [typed, expected] of [["1,5", 1.5], ["1.5", 1.5], ["12", 12], ["0,25", 0.25]] as const) {
			t.type(t.target(), typed);
			await t.submit();
			expect(lastInput(t).goal.target, typed).toBe(expected);
		}
	});
});

describe("D4: the period follows the schedule", () => {
	it("Times a week sets the period to week; Every day and Some days set it to day", async () => {
		const t = form();
		t.pick("How do you track it?", "Count");
		t.pick("When", "Times a week");
		expect(t.period().value).toBe("week");
		expect(t.pressed("When")).toEqual(["Times a week"]);
		t.pick("When", "Some days");
		expect(t.period().value).toBe("day");
		t.pick("When", "Times a week");
		t.pick("When", "Every day");
		expect(t.period().value).toBe("day");
		t.pick("When", "Times a week");
		t.type(t.name(), "Run");
		t.unit().value = "km";
		await t.submit();
		expect(lastInput(t).goal.period).toBe("week");
		expect(lastInput(t).schedule).toEqual({ kind: "weekly" });
	});

	it("picking week in the dropdown selects Times a week, and day selects Every day", () => {
		const t = form();
		t.pick("How do you track it?", "Amount");
		t.period().value = "week";
		t.period().dispatchEvent(new Event("change"));
		expect(t.pressed("When")).toEqual(["Times a week"]);
		t.period().value = "day";
		t.period().dispatchEvent(new Event("change"));
		expect(t.pressed("When")).toEqual(["Every day"]);
	});

	it("shows the weekday chips only for Some days, and submits the chosen days in week order", async () => {
		const t = form();
		const chips = t.group("When");
		expect(chips.parentElement!.querySelector<HTMLElement>(".cp-habit-chips")!.hidden).toBe(true);
		t.pick("When", "Some days");
		const row = t.q(".cp-habit-chips");
		expect(row.hidden).toBe(false);
		const chipButtons = [...row.querySelectorAll<HTMLButtonElement>("button")];
		expect(chipButtons.map((b) => b.getAttribute("aria-label"))).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
		expect(chipButtons.map((b) => text(b))).toEqual(["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]);
		// Starts with Monday to Friday; Sunday and Wednesday on, Monday off.
		expect(chipButtons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "true", "true", "true", "true", "false", "false"]);
		chipButtons[0]!.click();
		chipButtons[6]!.click();
		expect(chipButtons[0]!.getAttribute("aria-pressed")).toBe("false");
		t.type(t.name(), "Walk");
		await t.submit();
		expect(lastInput(t).schedule).toEqual({ kind: "weekdays", days: ["TU", "WE", "TH", "FR", "SU"] });
		expect(lastInput(t).goal.period).toBe("day");
	});
});

describe("the Goal line", () => {
	it("Done or not has no goal line, except as 'n times per week' under Times a week", async () => {
		const t = form();
		const goal = t.target().closest<HTMLElement>(".cp-habit-field")!;
		expect(goal.hidden).toBe(true);
		t.type(t.name(), "Gym");
		await t.submit();
		expect(lastInput(t).goal).toEqual({ type: "binary", target: 1, unit: null, period: "day" });
		t.pick("When", "Times a week");
		expect(goal.hidden).toBe(false);
		expect(t.target().value).toBe("3");
		expect(text(t.q(".cp-habit-goal-text:not([hidden])"))).toBe("times per week");
		expect(t.unit().hidden).toBe(true);
		expect(t.period().closest<HTMLElement>(".cp-habit-select")!.hidden).toBe(true);
		expect(t.target().getAttribute("aria-label")).toBe("Times per week");
		t.type(t.target(), "4");
		await t.submit();
		expect(lastInput(t)).toMatchObject({ goal: { type: "binary", target: 4, unit: null, period: "week" }, schedule: { kind: "weekly" } });
		// Back to Every day: the target is 1 again and the line is hidden.
		t.pick("When", "Every day");
		expect(goal.hidden).toBe(true);
		await t.submit();
		expect(lastInput(t).goal).toEqual({ type: "binary", target: 1, unit: null, period: "day" });
	});

	it("Count: a whole target and an optional unit; Amount: a unit is required", async () => {
		const t = form();
		t.type(t.name(), "Water");
		t.pick("How do you track it?", "Count");
		expect(t.target().value).toBe("8");
		expect(t.unit().placeholder).toBe("glasses (optional)");
		await t.submit();
		expect(lastInput(t).goal).toEqual({ type: "count", target: 8, unit: null, period: "day" });
		t.type(t.unit(), " glasses ");
		await t.submit();
		expect(lastInput(t).goal).toEqual({ type: "count", target: 8, unit: "glasses", period: "day" });
		t.pick("How do you track it?", "Amount");
		expect(t.target().value).toBe("30");
		expect(t.unit().getAttribute("aria-label")).toBe("Unit");
		expect(t.unit().placeholder).toBe("min");
	});

	it("starts a type with its usual target until the user types one", () => {
		const t = form();
		t.pick("How do you track it?", "Amount");
		expect(t.target().value).toBe("30");
		t.pick("How do you track it?", "Count");
		expect(t.target().value).toBe("8");
		t.type(t.target(), "12");
		t.pick("How do you track it?", "Amount");
		expect(t.target().value).toBe("12");
	});
});

describe("D20 validation, inline", () => {
	const cases: [string, (t: ReturnType<typeof form>) => void, string, string][] = [
		["a name", (t) => t.type(t.name(), "  "), "Enter a name.", "name"],
		[
			"an Amount unit",
			(t) => {
				t.type(t.name(), "Run");
				t.pick("How do you track it?", "Amount");
			},
			"Enter a unit, like min or km.",
			"unit",
		],
		[
			"a unit that is too long",
			(t) => {
				t.type(t.name(), "Run");
				t.pick("How do you track it?", "Amount");
				t.type(t.unit(), "kilometres per hour");
			},
			"Keep the unit to 12 characters or fewer.",
			"unit",
		],
		[
			"a target of 0",
			(t) => {
				t.type(t.name(), "Run");
				t.pick("How do you track it?", "Count");
				t.type(t.target(), "0");
			},
			"The goal must be a number above 0.",
			"target",
		],
		[
			"a target that is not a number",
			(t) => {
				t.type(t.name(), "Run");
				t.pick("How do you track it?", "Count");
				t.type(t.target(), "many");
			},
			"The goal must be a number above 0.",
			"target",
		],
		...["10,000", "10.000", "1e3", "0x10", "1,000", ""].map(
			(bad): [string, (t: ReturnType<typeof form>) => void, string, string] => [
				`a target of "${bad}" (ambiguous, an exponent, a prefix or empty)`,
				(t) => {
					t.type(t.name(), "Run");
					t.pick("How do you track it?", "Amount");
					t.type(t.unit(), "km");
					t.type(t.target(), bad);
				},
				"The goal must be a number above 0.",
				"target",
			],
		),
		[
			"a count that is not whole",
			(t) => {
				t.type(t.name(), "Run");
				t.pick("How do you track it?", "Count");
				t.type(t.target(), "2.5");
			},
			"A count goal must be a whole number.",
			"target",
		],
		[
			"no weekday",
			(t) => {
				t.type(t.name(), "Run");
				t.pick("When", "Some days");
				for (const b of t.container.querySelectorAll<HTMLButtonElement>(".cp-habit-chips button")) if (b.getAttribute("aria-pressed") === "true") b.click();
			},
			"Pick at least one day.",
			"",
		],
		[
			"a reminder time",
			(t) => {
				t.type(t.name(), "Run");
				t.q("button.cp-habit-switch").click();
				t.type(t.q<HTMLInputElement>('input[type="time"]'), "");
			},
			"Enter the reminder time as HH:MM.",
			"",
		],
		[
			"a done-or-not times-a-week target that is not whole",
			(t) => {
				t.type(t.name(), "Gym");
				t.pick("When", "Times a week");
				t.type(t.target(), "2.5");
			},
			"The number of times must be a whole number.",
			"target",
		],
	];
	for (const [what, arrange, message, focus] of cases) {
		it(`shows "${message}" for ${what} and does not submit`, async () => {
			const t = form();
			arrange(t);
			await t.submit();
			expect(t.onSubmit).not.toHaveBeenCalled();
			expect(t.error().hidden).toBe(false);
			expect(t.error().getAttribute("role")).toBe("alert");
			expect(text(t.error())).toBe(message);
			if (focus === "name") expect(document.activeElement).toBe(t.name());
			if (focus === "unit") expect(document.activeElement).toBe(t.unit());
			if (focus === "target") expect(document.activeElement).toBe(t.target());
			// Typing again clears the message.
			t.type(t.name(), "Another");
			expect(t.error().hidden).toBe(true);
		});
	}

	it("shows exactly the message validateHabitInput gives, also for rules added later (a week has at most 7 days)", async () => {
		const t = form();
		t.type(t.name(), "Gym");
		t.pick("When", "Times a week");
		t.type(t.target(), "8");
		const expected = validateHabitInput({ ...empty, name: "Gym", goal: { type: "binary", target: 8, unit: null, period: "week" }, schedule: { kind: "weekly" } });
		expect(expected).not.toBeNull();
		await t.submit();
		expect(text(t.error())).toBe(expected);
	});
});

describe("saving", () => {
	it("submits the name trimmed, the icon, the color, the time of day and the reminder", async () => {
		const t = form({ defaultColor: "red", pick: "dumbbell" });
		t.type(t.name(), "  Gym  ");
		t.q("button.cp-habit-icon-button").click();
		await new Promise((r) => setTimeout(r, 0));
		expect(t.pickIcon).toHaveBeenCalledWith(null);
		expect(t.q("button.cp-habit-icon-button .cp-habit-icon-slot").getAttribute("data-icon")).toBe("dumbbell");
		[...t.container.querySelectorAll<HTMLButtonElement>(".cp-color-choice")][7]!.click();
		t.pick("Time of day", "Afternoon");
		t.q("button.cp-habit-switch").click();
		t.type(t.q<HTMLInputElement>('input[type="time"]'), "17:30");
		await t.submit();
		expect(lastInput(t)).toEqual({
			name: "Gym",
			icon: "dumbbell",
			color: "purple",
			timeOfDay: "afternoon",
			reminder: { time: "17:30" },
			goal: { type: "binary", target: 1, unit: null, period: "day" },
			schedule: { kind: "daily" },
		});
	});

	it("the icon button shows the flame until an icon is picked; a dismissed picker keeps the icon, None clears it", async () => {
		const t = form({ initial: { ...empty, icon: "book-open" }, pick: undefined });
		const slot = () => t.q(".cp-habit-icon-slot").getAttribute("data-icon");
		expect(slot()).toBe("book-open");
		t.q("button.cp-habit-icon-button").click();
		await new Promise((r) => setTimeout(r, 0));
		expect(slot()).toBe("book-open");
		const none = form({ initial: { ...empty, icon: "book-open" }, pick: null });
		none.q("button.cp-habit-icon-button").click();
		await new Promise((r) => setTimeout(r, 0));
		expect(none.q(".cp-habit-icon-slot").getAttribute("data-icon")).toBe("flame");
		await none.submit();
		expect(lastInput(none).icon).toBeNull();
	});

	it("colors the icon button with the picked swatch (the accent for Default)", () => {
		const t = form({ defaultColor: null });
		const btn = t.q("button.cp-habit-icon-button");
		expect(btn.className).toContain("cp-hue-none");
		[...t.container.querySelectorAll<HTMLButtonElement>(".cp-color-choice")][6]!.click();
		expect(btn.className).toContain("cp-hue-blue");
	});

	it("keeps the form as it is and shows the message when saving says no; a second click while saving does nothing", async () => {
		const t = form({ result: "That name is taken." });
		t.type(t.name(), "Read");
		await t.submit();
		expect(text(t.error())).toBe("That name is taken.");
		expect(t.name().value).toBe("Read");
		let release: (v: string | null) => void = () => undefined;
		t.onSubmit.mockImplementation(() => new Promise((r) => (release = r)));
		t.q("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		t.q("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		expect(t.onSubmit).toHaveBeenCalledTimes(2); // the first call above plus one while busy
		expect(t.q<HTMLButtonElement>("button[type=submit]").disabled).toBe(true);
		release(null);
		await new Promise((r) => setTimeout(r, 0));
		expect(t.q<HTMLButtonElement>("button[type=submit]").disabled).toBe(false);
	});

	it("Cancel calls onCancel and submits nothing", () => {
		const t = form();
		[...t.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Cancel")!.click();
		expect(t.onCancel).toHaveBeenCalledTimes(1);
		expect(t.onSubmit).not.toHaveBeenCalled();
	});

	it("calls onSubmit before any await, so the click that saves is still the user gesture", () => {
		const t = form();
		t.type(t.name(), "Read");
		t.q("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		expect(t.onSubmit).toHaveBeenCalledTimes(1);
	});
});

describe("Edit: prefilled", () => {
	const initial: HabitInput = {
		name: "Read",
		icon: "book-open",
		color: "purple",
		timeOfDay: "evening",
		reminder: { time: "20:00" },
		goal: { type: "quantity", target: 30, unit: "min", period: "day" },
		schedule: { kind: "weekdays", days: ["MO", "WE", "FR"] },
	};

	it("shows every value of the habit", () => {
		const t = form({ initial });
		expect(t.name().value).toBe("Read");
		expect(t.q(".cp-habit-icon-slot").getAttribute("data-icon")).toBe("book-open");
		expect(t.pressed("How do you track it?")).toEqual(["Amount"]);
		expect(t.target().value).toBe("30");
		expect(t.unit().value).toBe("min");
		expect(t.period().value).toBe("day");
		expect(t.pressed("When")).toEqual(["Some days"]);
		expect([...t.container.querySelectorAll<HTMLButtonElement>(".cp-habit-chips button")].map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "true", "false", "true", "false", "false"]);
		expect(t.pressed("Time of day")).toEqual(["Evening"]);
		expect(t.q("button.cp-habit-switch").getAttribute("aria-checked")).toBe("true");
		expect(t.q<HTMLInputElement>('input[type="time"]').value).toBe("20:00");
		expect([...t.container.querySelectorAll<HTMLButtonElement>(".cp-color-choice")].find((b) => b.getAttribute("aria-pressed") === "true")!.getAttribute("aria-label")).toBe("Purple");
	});

	it("saves what was shown when nothing is touched", async () => {
		const t = form({ initial });
		await t.submit();
		expect(lastInput(t)).toEqual(initial);
	});

	it("shows a weekly done-or-not habit under Times a week with its count", async () => {
		const gym: HabitInput = { ...empty, name: "Gym", goal: { type: "binary", target: 3, unit: null, period: "week" }, schedule: { kind: "weekly" } };
		const t = form({ initial: gym });
		expect(t.pressed("When")).toEqual(["Times a week"]);
		expect(t.target().value).toBe("3");
		await t.submit();
		expect(lastInput(t)).toEqual(gym);
	});
});

describe("the Modal", () => {
	const superClose = vi.fn();
	beforeAll(() => {
		(Modal as unknown as { prototype: { close: () => void } }).prototype.close = superClose;
	});
	afterEach(() => superClose.mockClear());

	function open(options: Partial<HabitDialogOptions> = {}, accent = "") {
		const full: HabitDialogOptions = {
			title: "New habit",
			submit: "Create habit",
			initial: null,
			defaultColor: "red",
			save: vi.fn(async () => null),
			...options,
		};
		let resolved = 0;
		const modal = new HabitModal({} as never, full, () => void resolved++, accent);
		const m = modal as unknown as { modalEl: ObsidianElement; contentEl: ObsidianElement; setTitle: (t: string) => void };
		const titles: string[] = [];
		m.modalEl = obsidianElement();
		m.contentEl = obsidianElement();
		m.modalEl.appendChild(m.contentEl);
		document.body.appendChild(m.modalEl);
		m.setTitle = (t) => void titles.push(t);
		modal.onOpen();
		return { modal, modalEl: m.modalEl, contentEl: m.contentEl, titles, resolved: () => resolved, options: full };
	}

	it("sets the title, the token and scope classes and the accent class on the modal element", () => {
		const { modalEl, titles, contentEl } = open({ title: "Edit habit", submit: "Save" }, "cp-accent-purple");
		expect(titles).toEqual(["Edit habit"]);
		expect(modalEl.classList.contains("checkpoint-icon-picker")).toBe(true);
		expect(modalEl.classList.contains("checkpoint-habit-dialog")).toBe(true);
		expect(modalEl.classList.contains("cp-accent-purple")).toBe(true);
		expect(text(contentEl.querySelector("button[type=submit]"))).toBe("Save");
	});

	it("closes after a successful save, stays open with the message otherwise", async () => {
		const save = vi.fn<HabitDialogOptions["save"]>(async () => "Nope.");
		const { modal, contentEl } = open({ save });
		(contentEl.querySelector<HTMLInputElement>('input[type="text"]:not(.cp-habit-target):not(.cp-habit-unit-input)')!).value = "Read";
		contentEl.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		await new Promise((r) => setTimeout(r, 0));
		expect(save).toHaveBeenCalledTimes(1);
		expect(superClose).not.toHaveBeenCalled();
		expect(text(contentEl.querySelector(".cp-habit-form-error"))).toBe("Nope.");
		save.mockResolvedValue(null);
		contentEl.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		await new Promise((r) => setTimeout(r, 0));
		expect(superClose).toHaveBeenCalledTimes(1);
		expect(modal).toBeDefined();
	});

	it("Cancel closes; closing (Escape goes through close()) empties the content and resolves the promise once", () => {
		const { modal, contentEl, resolved } = open();
		[...contentEl.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Cancel")!.click();
		expect(superClose).toHaveBeenCalledTimes(1);
		modal.onClose();
		expect(contentEl.childElementCount).toBe(0);
		expect(resolved()).toBe(1);
	});

	it("keeps Obsidian's own fields apart: the class adds only cp-prefixed members and overrides onOpen and onClose", () => {
		const own = Object.getOwnPropertyNames(HabitModal.prototype).filter((n) => n !== "constructor").sort();
		expect(own).toEqual(["onClose", "onOpen"]);
		const { modal } = open();
		const fields = Object.keys(modal).filter((k) => !["modalEl", "contentEl", "setTitle"].includes(k));
		expect(fields.length).toBeGreaterThan(0);
		for (const k of fields) expect(k.startsWith("cp"), k).toBe(true);
	});
});

describe("habitDialogOptions (what the page hands the dialog)", () => {
	async function host() {
		const h = await appHarness();
		const u = new U1Host(h);
		const notices = recordNotices(u);
		let gestures = 0;
		u.reminderGesture = () => void gestures++;
		return { h, u, notices, gestures: () => gestures };
	}

	it("a new habit: empty form, the next palette color, Create habit; saving creates it with a notice", async () => {
		const { h, u, notices } = await host();
		const o = habitDialogOptions(u, {});
		expect(o).toMatchObject({ title: "New habit", submit: "Create habit", initial: null, defaultColor: "red" });
		expect(await o.save({ ...empty, name: "Stretch" })).toBeNull();
		expect(h.app.habits.list().map((x) => x.name)).toEqual(["Stretch"]);
		expect(notices).toEqual([{ message: "Created Stretch.", label: "New habit" }]);
		expect(habitDialogOptions(u, {}).defaultColor).toBe("orange");
	});

	it("an example chip starts from its values", async () => {
		const { u } = await host();
		expect(habitDialogOptions(u, { initial: empty }).initial).toEqual(empty);
	});

	it("Edit: prefilled from the habit's current rule, titled Edit habit with Save; saving updates it", async () => {
		const { h, u, notices } = await host();
		const habit = await h.app.habits.create({ ...empty, name: "Read", icon: "book-open", color: "purple", reminder: { time: "20:00" }, goal: { type: "quantity", target: 30, unit: "min", period: "day" } });
		const o = habitDialogOptions(u, { habit });
		expect(o).toMatchObject({ title: "Edit habit", submit: "Save" });
		expect(o.initial).toEqual({ name: "Read", icon: "book-open", color: "purple", timeOfDay: "anytime", reminder: { time: "20:00" }, goal: { type: "quantity", target: 30, unit: "min", period: "day" }, schedule: { kind: "daily" } });
		const saved: string[] = [];
		const o2 = habitDialogOptions(u, { habit, onSaved: (id) => void saved.push(id) });
		expect(await o2.save({ ...o.initial!, name: "Read daily" })).toBeNull();
		expect(h.app.habits.list()[0]!.name).toBe("Read daily");
		expect(notices).toEqual([{ message: "Saved Read daily.", label: "Edit habit" }]);
		expect(saved).toEqual([habit.id]);
		// Unchanged: no notice.
		expect(await o2.save({ ...o.initial!, name: "Read daily" })).toBeNull();
		expect(notices).toHaveLength(1);
	});

	it("asks for the notification permission in the saving call when the reminder is on, before anything is awaited", async () => {
		const { u, gestures } = await host();
		const o = habitDialogOptions(u, {});
		const pending = o.save({ ...empty, reminder: { time: "20:00" } });
		expect(gestures()).toBe(1);
		await pending;
		await o.save({ ...empty, name: "Quiet" });
		expect(gestures()).toBe(1);
	});

	it("returns the service's message instead of throwing, so the dialog stays open", async () => {
		const { h, u } = await host();
		const o = habitDialogOptions(u, {});
		expect(await o.save({ ...empty, name: "   " })).toBe("Enter a name.");
		expect(h.app.habits.list()).toHaveLength(0);
	});
});
