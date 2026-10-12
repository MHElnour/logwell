import type { CheckpointApp } from "../../app/App";
import { DST_WARNING_TEXT } from "../../app/TaskService";
import { tagLabel, tagLeaf } from "../../domain/tags";
import { DURATION_RANGE_MESSAGE, isDurationMinutes } from "../../domain/tasks";
import { type DateSpec, type ID, INBOX_ID, type LocalDate, type Priority, type RepeatRule, type Tag, type Task, isPriority } from "../../domain/types";
import {
	type Chip,
	type DateLocale,
	type ParsedField,
	type ParseResult,
	type SpanDecision,
	parseQuickAdd,
	rebaseDecisions,
} from "../../parsing";
import { specFromInputs, specInputs } from "../format";
import { NEVER_END, type RepeatChoice } from "../repeat";
import { DEADLINE_CLEARED_TEXT } from "../repeatActions";
import type { QuickAddPreset } from "../host";

// The Quick Add controller: input text, decisions about spans, manual
// fields and the parse result, shared by the modal form and the inline add bar.
// Plain TypeScript: the Preact components only render it and forward events.
// Every task is saved through `app.tasks.create`, so the command queue and
// undo stay in the app layer.

export interface QuickAddEnv {
	app: CheckpointApp;
	/** The defaults of the place Quick Add was opened from. They are not manual values. */
	preset: QuickAddPreset;
	locale(): DateLocale;
	/** What "tonight" means ("HH:mm"); the parser default when absent. */
	eveningTime?(): string;
	resolveNote(linktext: string): string[];
	/** Called once per saved task. `warnings` has no duplicates. */
	onSaved(title: string, warnings: string[]): void;
	onError(err: unknown): void;
	/** Whether to stay open and reset after a save. */
	keepOpen(): boolean;
	onClose(): void;
}

const TITLE_FALLBACK_TEXT = "Title was empty after removing recognized items; kept the full text";
const SUBTASK_CATEGORY_NOTICE = "A subtask stays in its parent's list";
const SUBTASK_REPEAT_NOTICE = "A subtask cannot repeat.";

/** Where focus should go after the next render. */
export type FocusTarget = { kind: "input" } | { kind: "panel" } | { kind: "chip"; id: string } | { kind: "tool"; tool: PopoverKind };

/** The add bar's two popovers. At most one is open. */
export type PopoverKind = "date" | "more";

export type PanelKind = "alternatives" | "categories" | "candidates" | "edit";

export type SubmitOutcome = "saved" | "blocked" | "invalid" | "busy" | "error";

export type ManualFieldName = Extract<ParsedField, "scheduled" | "deadline" | "duration" | "category" | "note" | "priority" | "recurrence">;

const MANUAL_FIELDS: ReadonlySet<string> = new Set<ManualFieldName>(["scheduled", "deadline", "duration", "category", "note", "priority", "recurrence"]);
/** A chip of these kinds stands for the manual field of the same name. */
const isManualField = (kind: Chip["kind"]): kind is ManualFieldName => MANUAL_FIELDS.has(kind);

export class QuickAddModel {
	input = "";
	decisions: SpanDecision[] = [];
	result: ParseResult;
	/** Fields the user set by hand. The parser only suggests them. */
	readonly manual = new Set<ParsedField>();
	/** The manual values; only the fields in `manual` are used. */
	vals = {
		date: "",
		time: "",
		deadline: "",
		duration: "",
		categoryId: null as ID | null,
		notePath: null as string | null,
		priority: 0 as Priority,
		/** The repeat picked by hand; null (with "recurrence" in `manual`) is an explicit "Never". */
		repeat: null as RepeatChoice | null,
	};
	/** Manually chosen tags; null means "the preset's tags". */
	tagKeys: string[] | null = null;
	/** The tags the picked tags' pills were last drawn with, to name a tag that is gone as its pill did. */
	private shownTags: ReadonlyMap<string, Tag> | null = null;
	/** The "Pick it again" message while it shows, so picking tags clears it and nothing else. */
	private goneTagsMessage: string | null = null;
	urgent = false;
	important = false;
	message: string | null = null;
	saving = false;
	/** The chip whose picker or editor is open, and whether choosing should also save. */
	openChipId: string | null = null;
	saveAfterPick = false;
	/** The open popover of the add bar (date popover or more menu), or null. */
	popover: PopoverKind | null = null;
	focus: FocusTarget | null = null;
	focusTick = 0;
	/** Set by the input component: true while the suggester owns Enter, arrows and Escape. */
	suggesterBusy: () => boolean = () => false;
	private justBound = false;

	private disposed = false;

	constructor(
		public env: QuickAddEnv,
		private readonly notify: () => void,
	) {
		this.resetManual();
		this.result = this.parse();
	}

	dispose(): void {
		this.disposed = true;
	}

	/** The parent of a subtask being added, read live so a category change of the parent is seen. */
	get parent(): Task | undefined {
		const id = this.env.preset.parentId;
		return id === undefined ? undefined : this.env.app.store.state.tasks.get(id);
	}

	// -- Parsing ------------------------------------------------------------------

	private zone(): string {
		return this.env.app.settings.zone();
	}

	/** The time "Tonight" means, "HH:mm" (settings, default 20:00). */
	eveningTime(): string {
		return this.env.eveningTime?.() ?? "20:00";
	}

	private today(): LocalDate {
		return this.env.app.queryContext().today;
	}

	private parse(): ParseResult {
		const app = this.env.app;
		return parseQuickAdd(this.input, {
			now: app.clock.now(),
			zone: this.zone(),
			locale: this.env.locale(),
			...(this.env.eveningTime ? { eveningTime: this.env.eveningTime() } : {}),
			categories: app.categories.list().map((c) => ({ id: c.id, name: c.name })),
			tags: app.tags.list().map((t) => ({ key: t.key, displayName: t.displayName, createdAt: t.createdAt })),
			resolveNote: (t) => this.env.resolveNote(t),
			decisions: this.decisions,
			manual: this.manual,
			// A typed repeat end counts from the date picked by hand, else the preset's (else today).
			...(this.startDate() === null ? {} : { startDate: this.startDate()! }),
			weekStart: app.queryContext().weekStart,
		});
	}

	private startDate(): LocalDate | null {
		return this.manual.has("scheduled") && this.vals.date !== "" ? this.vals.date : this.presetDate();
	}

	/** Reparses after any change and tells the view. */
	private update(): void {
		if (this.disposed) return;
		this.result = this.parse();
		if (this.openChipId !== null && !this.result.chips.some((c) => c.id === this.openChipId)) {
			this.openChipId = null;
			this.saveAfterPick = false;
		}
		this.notify();
	}

	/** Re-reads categories, tags and notes (they changed elsewhere). */
	refresh(): void {
		// A picked tag renamed or deleted elsewhere leaves the pills, and the message says to pick it again.
		const tags = this.env.app.store.state.tags;
		if (this.tagKeys !== null) {
			const gone = this.tagKeys.filter((k) => !tags.has(k));
			if (gone.length > 0) {
				this.tagKeys = this.tagKeys.filter((k) => tags.has(k));
				// Named as the pill showed it, from the tags it was drawn with.
				const shown = this.shownTags ?? tags;
				const names = gone.map((k) => `"${shown.has(k) ? tagLabel(shown, k) : tagLeaf(k)}"`).join(", ");
				this.message = gone.length === 1 ? `The tag ${names} was renamed or deleted. Pick it again.` : `The tags ${names} were renamed or deleted. Pick them again.`;
				this.goneTagsMessage = this.message;
			}
		}
		this.shownTags = tags;
		this.update();
	}

	setInput(next: string): void {
		if (next === this.input) return;
		this.decisions = rebaseDecisions(this.input, next, this.decisions);
		this.input = next;
		this.message = null;
		this.update();
	}

	chip(id: string): Chip | undefined {
		return this.result.chips.find((c) => c.id === id);
	}

	// -- Decisions ----------------------------------------------------------------

	private decide(d: SpanDecision): void {
		this.decisions = [...this.decisions.filter((x) => x.span.start !== d.span.start || x.span.end !== d.span.end), d];
	}

	private requestFocus(target: FocusTarget): void {
		this.focus = target;
		this.focusTick++;
	}

	private clearManual(field: ManualFieldName): void {
		if (field === "category" && this.parent !== undefined) return; // fixed by the parent task
		this.manual.delete(field);
		if (field === "scheduled") {
			this.vals.date = "";
			this.vals.time = "";
		} else if (field === "deadline") this.vals.deadline = "";
		else if (field === "duration") this.vals.duration = "";
		else if (field === "category") this.vals.categoryId = null;
		else if (field === "priority") this.vals.priority = 0;
		else if (field === "recurrence") this.vals.repeat = null;
		else this.vals.notePath = null;
	}

	/**
	 * A choice from the suggester: a bound category, tag or note. The suggester dispatches `input` first.
	 * `win` is the input's window, so the timer runs in a pop-out window too.
	 */
	bind(d: SpanDecision, win: Pick<Window, "setTimeout"> = window): void {
		this.decide(d);
		if (d.kind === "category") this.clearManual("category");
		else if (d.kind === "note") this.clearManual("note");
		this.justBound = true;
		win.setTimeout(() => {
			this.justBound = false;
		}, 0);
		this.update();
	}

	/** True while Enter belongs to the suggester (it may have closed in this same key press). */
	inSuggester(): boolean {
		return this.justBound || this.suggesterBusy();
	}

	/** Keeps the chip's text as plain title text. */
	dismiss(chip: Chip): void {
		const index = this.result.chips.findIndex((c) => c.id === chip.id);
		const rest = this.result.chips.filter((c) => c.id !== chip.id);
		const next = rest[Math.min(index, rest.length - 1)];
		this.decide({ span: chip.span, text: chip.text, kind: "literal" });
		this.closePanel();
		this.requestFocus(next === undefined ? { kind: "input" } : { kind: "chip", id: next.id });
		this.update();
	}

	/**
	 * The date popover's Clear: removes the manual date, time, deadline, duration and repeat, and keeps
	 * the text of any applied typed date, deadline, duration or repeat chip literal (like x on the chip).
	 * Focus stays where it is.
	 */
	clearDateFields(): void {
		for (const chip of this.result.chips) {
			if (chip.status !== "applied") continue;
			if (chip.kind === "scheduled" || chip.kind === "deadline" || chip.kind === "duration" || chip.kind === "recurrence" || chip.kind === "repeatEnd") {
				this.decide({ span: chip.span, text: chip.text, kind: "literal" });
			}
		}
		for (const field of ["scheduled", "deadline", "duration", "recurrence"] as const) this.clearManual(field);
		this.update();
	}

	/** Applies a suggestion, replacing a manual value. */
	accept(chip: Chip): void {
		if (this.isFixedCategory(chip)) return;
		this.decide({ span: chip.span, text: chip.text, kind: "accept" });
		// A typed repeat end belongs to the repeat: using it replaces a repeat picked by hand.
		const field = chip.kind === "repeatEnd" ? "recurrence" : chip.kind;
		if (isManualField(field)) this.clearManual(field);
		this.requestFocus({ kind: "chip", id: chip.id });
		this.update();
	}

	/** A chosen alternative or an edited date or time for a date chip. */
	setChipDate(chip: Chip, value: DateSpec): void {
		this.decide({ span: chip.span, text: chip.text, kind: "date", value });
		if (isManualField(chip.kind)) this.clearManual(chip.kind);
		this.closePanel();
		this.requestFocus({ kind: "chip", id: chip.id });
		this.update();
	}

	/** The chosen reading of a typed repeat's bare hour ("09:00" or "21:00"): like a chosen date, it replaces a manual repeat. */
	setChipRule(chip: Chip, rule: RepeatRule): void {
		this.decide({ span: chip.span, text: chip.text, kind: "rule", rule });
		this.clearManual("recurrence");
		this.closePanel();
		this.requestFocus({ kind: "chip", id: chip.id });
		this.update();
	}

	/** The picker of an unresolved category chip. */
	pickCategory(chip: Chip, categoryId: ID): void {
		this.decide({ span: chip.span, text: chip.text, kind: "category", categoryId });
		this.clearManual("category");
		this.afterPick(chip);
	}

	/** The picker of a collision chip. */
	pickNote(chip: Chip, path: string): void {
		this.decide({ span: chip.span, text: chip.text, kind: "note", path });
		this.clearManual("note");
		this.afterPick(chip);
	}

	private afterPick(chip: Chip): void {
		const save = this.saveAfterPick;
		this.openChipId = null;
		this.saveAfterPick = false;
		this.requestFocus({ kind: "chip", id: chip.id });
		this.update();
		// The second Enter applies the choice and saves.
		if (save) void this.submit();
	}

	/** The category an unresolved chip's picker starts on: the manual category, else Inbox. */
	pickerCategory(): ID {
		return this.manual.has("category") && this.vals.categoryId !== null ? this.vals.categoryId : INBOX_ID;
	}

	/** Subtasks always stay in the parent's category. */
	isFixedCategory(chip: Chip): boolean {
		return chip.kind === "category" && this.parent !== undefined;
	}

	/** The notice shown with a chip (the parser's, adjusted for a subtask's fixed category). */
	noticeFor(chip: Chip): string | undefined {
		if (this.isFixedCategory(chip) && (chip.status === "suggestion" || chip.status === "unresolved")) return SUBTASK_CATEGORY_NOTICE;
		return chip.notice;
	}

	// -- Pickers ------------------------------------------------------------------

	panelKind(chip: Chip): PanelKind | null {
		if (chip.status === "choice") return "alternatives";
		if (chip.status === "unresolved") return this.isFixedCategory(chip) ? null : "categories";
		if (chip.status === "collision") return "candidates";
		if (chip.status === "applied" && (chip.kind === "scheduled" || chip.kind === "deadline")) return "edit";
		return null;
	}

	/** Enter or click on a chip: accept, open its picker or editor, or do nothing. */
	activate(chip: Chip): void {
		if (this.panelKind(chip) !== null) {
			this.openChipId = chip.id;
			this.saveAfterPick = false;
			this.requestFocus({ kind: "panel" });
			this.notify();
		} else if (chip.status === "suggestion") {
			this.accept(chip);
		}
	}

	/** Closes an open picker. Returns whether there was one (so Escape does not also close the form). */
	closePanel(): boolean {
		if (this.openChipId === null) return false;
		const id = this.openChipId;
		this.openChipId = null;
		this.saveAfterPick = false;
		if (!this.disposed) {
			this.requestFocus({ kind: "chip", id });
			this.notify();
		}
		return true;
	}

	// -- Popovers ------------------------------------------------------------------

	/** The bar's tool buttons: opens that popover, or closes it when it is the open one. */
	togglePopover(kind: PopoverKind): void {
		if (this.popover === kind) {
			this.closePopover(true);
			return;
		}
		this.popover = kind;
		this.openChipId = null;
		this.saveAfterPick = false;
		this.notify();
	}

	/**
	 * Closes the open popover. Returns whether there was one, so Escape in the modal or the view
	 * closes only the popover. `refocus` puts focus back on its tool button.
	 */
	closePopover(refocus: boolean): boolean {
		if (this.popover === null) return false;
		const tool = this.popover;
		this.popover = null;
		if (!this.disposed) {
			if (refocus) this.requestFocus({ kind: "tool", tool });
			this.notify();
		}
		return true;
	}

	/** Drops a manual value, so the text or the preset applies again (the pills' remove button). */
	revertManual(field: ManualFieldName): void {
		this.clearManual(field);
		this.update();
	}

	// -- Manual fields -------------------------------------------------------------

	private presetDate(): LocalDate | null {
		return this.env.preset.date ?? null;
	}

	/** The date and time input values: the manual ones, else what the text or the preset gives. */
	dateInputs(): { date: string; time: string } {
		if (this.manual.has("scheduled")) return { date: this.vals.date, time: this.vals.time };
		const parsed = this.result.fields.scheduled;
		if (parsed !== undefined) return specInputs(parsed, this.zone());
		return { date: this.presetDate() ?? "", time: "" };
	}

	deadlineInput(): string {
		if (this.manual.has("deadline")) return this.vals.deadline;
		const parsed = this.result.fields.deadline;
		return parsed === undefined ? "" : specInputs(parsed, this.zone()).date;
	}

	durationInput(): string {
		if (this.manual.has("duration")) return this.vals.duration;
		const parsed = this.result.fields.plannedDurationMin;
		return parsed === undefined ? "" : String(parsed);
	}

	/**
	 * The repeat the task will get. A manual choice (the date popover, All fields; null is an explicit
	 * "Never") wins; otherwise the typed `every …` chip when it is applied; otherwise none. A typed chip has no
	 * end and no date of its own: the service makes the scheduled date, or today, the anchor.
	 */
	repeatValue(): RepeatChoice | null {
		const typedEnd = this.result.fields.recurrenceEnd;
		if (this.manual.has("recurrence")) {
			// A typed end (`until Dec 1`) ends a repeat picked by hand that has no end of its own.
			const picked = this.vals.repeat;
			return picked !== null && picked.end.kind === "never" && typedEnd !== undefined ? { rule: picked.rule, end: typedEnd } : picked;
		}
		const parsed = this.result.fields.recurrence;
		return parsed === undefined ? null : { rule: parsed, end: typedEnd ?? NEVER_END };
	}

	/** The date a rule starts from, for the picker's hints: the picked date, else today. */
	repeatAnchor(): LocalDate {
		const { date } = this.dateInputs();
		return date === "" ? this.today() : date;
	}

	categoryValue(): ID {
		if (this.parent !== undefined) return this.parent.categoryId;
		if (this.manual.has("category") && this.vals.categoryId !== null) return this.vals.categoryId;
		return this.result.fields.categoryId ?? this.env.preset.categoryId ?? INBOX_ID;
	}

	/** The preset section, or null when the task goes to another list or is a subtask (it follows its parent). */
	private presetSectionId(): ID | null {
		const { sectionId, categoryId } = this.env.preset;
		if (sectionId === undefined || sectionId === null || this.parent !== undefined) return null;
		return this.categoryValue() === categoryId ? sectionId : null;
	}

	notePathValue(): string | null {
		if (this.manual.has("note")) return this.vals.notePath;
		return this.result.fields.notePath ?? null;
	}

	/**
	 * The priority the task will get. A manual value (the more menu, including an explicit
	 * "none") wins; otherwise the last applied typed token; otherwise none. Same shape as
	 * `durationInput`/`categoryValue`.
	 */
	priorityValue(): Priority {
		if (this.manual.has("priority")) return this.vals.priority;
		return this.result.fields.priority ?? 0;
	}

	tagKeysValue(): string[] {
		const tags = this.env.app.store.state.tags;
		// A tag renamed or deleted while the form was open drops out, so the save does not refuse the task.
		return (this.tagKeys ?? this.env.preset.tagKeys ?? []).filter((k) => tags.has(k));
	}

	setDate(date: string): void {
		const before = this.dateInputs();
		this.manual.add("scheduled");
		this.vals.date = date;
		this.vals.time = date === "" ? "" : before.time;
		if (date === "" && this.presetDate() === null) this.manual.delete("scheduled");
		this.update();
	}

	setTime(time: string): void {
		const before = this.dateInputs();
		this.manual.add("scheduled");
		this.vals.date = before.date;
		this.vals.time = time;
		this.update();
	}

	setDeadline(date: string): void {
		this.vals.deadline = date;
		if (date === "") this.manual.delete("deadline");
		else this.manual.add("deadline");
		this.update();
	}

	/**
	 * The picker's choice (null = Never). It behaves like a manual date: a typed `every …` becomes a
	 * "Replace repeat?" suggestion instead of overriding it. Never with nothing typed to override is not a
	 * choice at all, so a later typed `every …` still applies.
	 */
	setRepeat(choice: RepeatChoice | null): void {
		if (choice === null && !this.result.chips.some((c) => c.kind === "recurrence")) {
			this.manual.delete("recurrence");
			this.vals.repeat = null;
		} else {
			this.manual.add("recurrence");
			this.vals.repeat = choice;
		}
		this.update();
	}

	setDuration(raw: string): void {
		this.vals.duration = raw;
		if (raw === "") this.manual.delete("duration");
		else this.manual.add("duration");
		this.update();
	}

	setCategory(id: ID): void {
		if (this.parent !== undefined) return;
		this.manual.add("category");
		this.vals.categoryId = id;
		this.update();
	}

	setNote(path: string | null): void {
		this.vals.notePath = path;
		if (path === null) this.manual.delete("note");
		else this.manual.add("note");
		this.update();
	}

	/**
	 * The more menu's priority pick. It behaves like a manual date: the value is manual, so a
	 * typed `!n` becomes a "Replace priority?" suggestion instead of overriding it, and accepting
	 * that chip clears the manual value. Choosing none is also a manual choice. The manual value
	 * lasts until the form is reset, a typed token is accepted, or the next setPriority.
	 */
	setPriority(priority: Priority): void {
		if (!isPriority(priority)) throw new RangeError("Priority must be 0, 1, 2 or 3");
		this.manual.add("priority");
		this.vals.priority = priority;
		this.update();
	}

	setTags(keys: string[]): void {
		this.tagKeys = keys;
		this.shownTags = this.env.app.store.state.tags;
		// Picking tags again answers "Pick it again"; any other message stays.
		if (this.goneTagsMessage !== null && this.message === this.goneTagsMessage) this.message = null;
		this.goneTagsMessage = null;
		this.notify();
	}

	setFlag(flag: "urgent" | "important", value: boolean): void {
		this[flag] = value;
		this.notify();
	}

	private resetManual(): void {
		this.manual.clear();
		this.vals = { date: "", time: "", deadline: "", duration: "", categoryId: null, notePath: null, priority: 0, repeat: null };
		this.tagKeys = null;
		this.goneTagsMessage = null;
		this.urgent = this.env.preset.urgent ?? false;
		this.important = this.env.preset.important ?? false;
		if (this.parent !== undefined) {
			this.manual.add("category");
			this.vals.categoryId = this.parent.categoryId;
		}
	}

	/** After a save with "keep open": back to an empty form, keeping only the preset. */
	reset(): void {
		this.input = "";
		this.decisions = [];
		this.message = null;
		this.openChipId = null;
		this.saveAfterPick = false;
		this.popover = null;
		this.resetManual();
		this.requestFocus({ kind: "input" });
		this.update();
	}

	// -- Saving -------------------------------------------------------------------

	/**
	 * Enter in the input or a field. With an unresolved category it does not save: it opens
	 * that chip's picker with Inbox preselected, and choosing there saves.
	 */
	requestSave(): Promise<SubmitOutcome> {
		if (this.inSuggester()) return Promise.resolve("busy");
		return this.submit();
	}

	async submit(): Promise<SubmitOutcome> {
		if (this.saving) return "busy";
		if (this.input.trim() === "") {
			this.message = "A task needs a title.";
			this.requestFocus({ kind: "input" });
			this.notify();
			return "invalid";
		}
		// A subtask's category is fixed by its parent, so an unknown category stays literal text and never blocks.
		const blocking = this.result.chips.find((c) => this.result.blocking.includes(c.id) && !this.isFixedCategory(c));
		if (blocking?.kind === "repeatEnd") {
			// An invalid repeat end: its notice says why, and saving waits until it is fixed or dismissed.
			this.message = blocking.notice ?? null;
			this.requestFocus({ kind: "chip", id: blocking.id });
			this.notify();
			return "invalid";
		}
		if (blocking !== undefined) {
			this.openChipId = blocking.id;
			this.saveAfterPick = true;
			this.requestFocus({ kind: "panel" });
			this.notify();
			return "blocked";
		}
		const minutes = this.manual.has("duration") ? this.manualDuration() : (this.result.fields.plannedDurationMin ?? null);
		if (minutes === "invalid") {
			this.message = DURATION_RANGE_MESSAGE;
			this.notify();
			return "invalid";
		}
		const zone = this.zone();
		const f = this.result.fields;
		const scheduled = this.manual.has("scheduled")
			? specFromInputs(this.vals.date, this.vals.time, zone)
			: (f.scheduled ?? (this.presetDate() === null ? null : { kind: "date" as const, date: this.presetDate()! }));
		const typedDeadline = this.manual.has("deadline") ? specFromInputs(this.vals.deadline, "", zone) : (f.deadline ?? null);
		const repeat = this.repeatValue();
		// A subtask does not repeat: say so here, before the write.
		if (repeat !== null && this.parent !== undefined) {
			this.message = SUBTASK_REPEAT_NOTICE;
			this.notify();
			return "invalid";
		}
		// A repeating task has no deadline: the task saves as repeating without it, and the notice says so.
		const deadlineDropped = repeat !== null && typedDeadline !== null;
		const deadline = deadlineDropped ? null : typedDeadline;
		const manualTags = this.tagKeysValue();
		this.saving = true;
		this.notify();
		try {
			const { task, warnings } = await this.env.app.tasks.create({
				title: this.result.title,
				categoryId: this.categoryValue(),
				parentId: this.parent?.id ?? null,
				// The preset's section only holds while the task stays in the preset's list (a typed #list leaves it).
				sectionId: this.presetSectionId(),
				tagKeys: [...new Set([...manualTags, ...f.tagKeys])],
				newTags: f.newTags,
				scheduled,
				deadline,
				plannedDurationMin: minutes,
				urgent: this.urgent,
				important: this.important,
				priority: this.priorityValue(),
				notePath: this.notePathValue(),
				...(repeat === null ? {} : { repeat: { rule: repeat.rule, end: repeat.end } }),
			});
			// The parser already moved a time out of a DST gap; `create` sees a valid time.
			const chipWarnings = this.result.chips.flatMap((c) =>
				c.status === "applied" && c.warning !== undefined && !(deadlineDropped && c.kind === "deadline") ? [c.warning] : [],
			);
			const texts = [...chipWarnings, ...warnings].map((w) => DST_WARNING_TEXT[w]);
			if (deadlineDropped) texts.push(DEADLINE_CLEARED_TEXT);
			if (this.result.titleFallback) texts.push(TITLE_FALLBACK_TEXT);
			this.env.onSaved(task.title, [...new Set(texts)]);
			if (this.env.keepOpen()) this.reset();
			else this.env.onClose();
			return "saved";
		} catch (err) {
			this.env.onError(err);
			return "error";
		} finally {
			this.saving = false;
			this.notify();
		}
	}

	private manualDuration(): number | "invalid" {
		const n = Number(this.vals.duration);
		return isDurationMinutes(n) ? n : "invalid";
	}
}
