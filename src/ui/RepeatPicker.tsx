import { useEffect, useRef, useState } from "preact/hooks";
import type { LocalDate, RepeatFreq, Weekday, WeekStart } from "../domain/types";
import { SrOnly } from "./common";
import { capitalize } from "./format";
import { useUniqueId } from "./hooks";
import { popoverKeyDown } from "./popoverKeys";
import { QaIcon, type SetIcon } from "./quickadd/QaIcon";
import {
	NTH_OPTIONS,
	PRESET_IDS,
	PRESET_LABEL,
	type MonthKind,
	type NthValue,
	type PresetId,
	type RepeatChoice,
	type RepeatDraft,
	WEEKDAY_LONG,
	WEEKDAY_TWO_LETTER,
	afterCompletionBlock,
	afterCompletionHint,
	choiceOfDraft,
	draftOf,
	draftProblem,
	presetChoice,
	presetHint,
	presetOf,
	repeatLine,
	weekdaysFrom,
} from "./repeat";

// The repeat picker. Two faces: the presets (a listbox) and
// the custom editor (an aligned grid). `RepeatPresets` and `RepeatCustom` are the faces; `RepeatPicker` is the
// two together for the places that open it on its own (the details pane and Quick Add's "All fields"), and the
// add bar's date popover uses the faces inside its own dialog. Containers are named with aria-labelledby, never
// aria-label: Obsidian shows a tooltip for any element that has one.

interface PickerEnv {
	/** The date the rule starts from: it names the weekday and the day of month of the presets. */
	anchor: LocalDate;
	today: LocalDate;
	weekStart: WeekStart;
	setIcon?: SetIcon;
	/** The Weekly and Monthly presets name the anchor's weekday and day in the rule (the details pane). */
	explicitPresets?: boolean;
}

// -- Presets ----------------------------------------------------------------------------

/**
 * The preset listbox. Arrow keys, Home and End move focus; Enter or a click picks. A pick other than
 * "Custom…" applies at once (`onPick`, null = Never); "Custom…" opens the editor (`onCustom`).
 */
export function RepeatPresets(props: {
	value: RepeatChoice | null;
	anchor: LocalDate;
	/** Names the listbox (an element id). */
	labelledBy: string;
	onPick: (choice: RepeatChoice | null) => void;
	onCustom: () => void;
	/** Weekly and Monthly store the weekday and day of this date instead of "the anchor's". */
	explicitFor?: LocalDate;
	/** Focus an option when the list appears: the selected one (true) or a given preset (coming back from Custom…). */
	autoFocus?: boolean | PresetId;
}) {
	const { value, anchor } = props;
	const current = presetOf(value, anchor);
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const want = props.autoFocus;
		if (want === undefined || want === false) return;
		listRef.current?.querySelector<HTMLElement>(want === true ? '[aria-selected="true"]' : `[data-preset="${want}"]`)?.focus();
	}, []);

	const choose = (id: PresetId) => {
		if (id === "custom") props.onCustom();
		// The preset the value already is stays as stored (a series made "every Friday" with no explicit weekday is not rewritten).
		else if (id === current) props.onPick(value);
		else props.onPick(presetChoice(id, value, props.explicitFor));
	};
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.isComposing) return;
		const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
		const at = items.indexOf(listRef.current?.ownerDocument.activeElement as HTMLElement);
		let next = -1;
		if (e.key === "ArrowDown") next = Math.min(items.length - 1, at + 1);
		else if (e.key === "ArrowUp") next = Math.max(0, at - 1);
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = items.length - 1;
		if (next < 0) return;
		e.preventDefault();
		e.stopPropagation();
		items[next]?.focus();
	};
	return (
		<div ref={listRef} class="cp-repeat-opts" role="listbox" aria-labelledby={props.labelledBy} onKeyDown={onKeyDown}>
			{PRESET_IDS.map((id) => {
				const on = id === current;
				const hint = presetHint(id, anchor);
				return (
					<button
						key={id}
						type="button"
						role="option"
						class={`cp-repeat-opt${on ? " is-on" : ""}`}
						data-preset={id}
						aria-selected={on}
						tabIndex={on ? 0 : -1}
						onClick={() => choose(id)}
					>
						<span class="cp-repeat-opt-label">{PRESET_LABEL[id]}</span>
						{hint !== null && <small class="cp-repeat-opt-hint">{hint}</small>}
					</button>
				);
			})}
		</div>
	);
}

// -- Custom -----------------------------------------------------------------------------

const UNIT_LABEL: Readonly<Record<RepeatFreq, string>> = { daily: "days", weekly: "weeks", monthly: "months" };
const FREQS: readonly RepeatFreq[] = ["daily", "weekly", "monthly"];
const MONTH_KINDS: readonly MonthKind[] = ["day", "nth", "lastDay"];
const ENDS: readonly { kind: "never" | "date" | "count"; label: string }[] = [
	{ kind: "never", label: "Never" },
	{ kind: "date", label: "On date" },
	{ kind: "count", label: "After" },
];

/** The custom editor: Every N unit, On (weekdays or the monthly form), Count from completion, Ends, summary, Back and Done. */
export function RepeatCustom(props: PickerEnv & { value: RepeatChoice | null; onBack: () => void; onDone: (choice: RepeatChoice) => void }) {
	const { anchor, today } = props;
	const [draft, setDraft] = useState<RepeatDraft>(() => draftOf(props.value, anchor));
	const base = useUniqueId("cp-repeat");
	const [titleId, everyId, onId, endsId, radioName] = ["title", "every", "on", "ends", "radio"].map((k) => `${base}-${k}`) as [string, string, string, string, string];
	const rootRef = useRef<HTMLDivElement>(null);
	const set = (patch: Partial<RepeatDraft>) => setDraft((d) => ({ ...d, ...patch }));
	useEffect(() => {
		rootRef.current?.querySelector<HTMLElement>(".cp-repeat-num")?.focus();
	}, []);

	const problem = draftProblem(draft, anchor);
	const block = afterCompletionBlock(draft);
	const summary = problem ?? capitalize(repeatLine(choiceOfDraft(draft), anchor, today, true));

	const toggleDay = (d: Weekday) => set({ days: draft.days.includes(d) ? draft.days.filter((x) => x !== d) : [...draft.days, d] });

	const onRadioKey = (e: KeyboardEvent) => {
		const target = e.target as HTMLElement;
		if (e.isComposing || target.tagName !== "INPUT" || (target as HTMLInputElement).type !== "radio") return;
		const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
		if (step === 0) return;
		e.preventDefault();
		e.stopPropagation();
		const at = MONTH_KINDS.indexOf(draft.monthKind);
		const next = MONTH_KINDS[(at + step + MONTH_KINDS.length) % MONTH_KINDS.length]!;
		set({ monthKind: next });
		// Focus follows the selection once the radios have re-rendered.
		window.setTimeout(() => rootRef.current?.querySelector<HTMLElement>(`input[data-kind="${next}"]`)?.focus(), 0);
	};

	return (
		<div ref={rootRef} class="cp-repeat-custom" role="group" aria-labelledby={titleId}>
			<h4 id={titleId} class="cp-repeat-title">
				Custom repeat
			</h4>
			<div class="cp-repeat-grid">
				<span class="cp-repeat-lbl" id={everyId}>
					Every
				</span>
				<div class="cp-repeat-r" role="group" aria-labelledby={everyId}>
					<input
						class="cp-repeat-num"
						type="number"
						min={1}
						step={1}
						value={draft.interval}
						aria-label="Interval"
						onInput={(e) => set({ interval: e.currentTarget.value })}
					/>
					<select class="dropdown" aria-label="Unit" value={draft.freq} onChange={(e) => set({ freq: e.currentTarget.value as RepeatFreq })}>
						{FREQS.map((f) => (
							<option key={f} value={f} selected={draft.freq === f}>
								{UNIT_LABEL[f]}
							</option>
						))}
					</select>
				</div>

				{draft.freq === "weekly" && (
					<>
						<span class="cp-repeat-lbl" id={onId}>
							On
						</span>
						<div class="cp-repeat-r">
							<div class="cp-repeat-days" role="group" aria-labelledby={onId}>
								{weekdaysFrom(props.weekStart).map((d) => (
									<button
										key={d}
										type="button"
										class="cp-repeat-day"
										data-day={d}
										aria-label={WEEKDAY_LONG[d]}
										aria-pressed={draft.days.includes(d)}
										onClick={() => toggleDay(d)}
									>
										{WEEKDAY_TWO_LETTER[d]}
									</button>
								))}
							</div>
						</div>
					</>
				)}

				{draft.freq === "monthly" && (
					<>
						<span class="cp-repeat-lbl" id={onId}>
							On
						</span>
						<div class="cp-repeat-radio" role="radiogroup" aria-labelledby={onId} onKeyDown={onRadioKey}>
							<label class="cp-repeat-radio-row">
								<input
									type="radio"
									name={radioName}
									data-kind="day"
									checked={draft.monthKind === "day"}
									tabIndex={draft.monthKind === "day" ? 0 : -1}
									onChange={() => set({ monthKind: "day" })}
								/>
								<span>
									{`Day ${draft.monthDay}`}
									{draft.monthDay >= 29 && <small class="cp-repeat-note">{" (else the month’s last day)"}</small>}
								</span>
							</label>
							<div class="cp-repeat-radio-row">
								<label class="cp-repeat-radio-label">
									<input
										type="radio"
										name={radioName}
										data-kind="nth"
										checked={draft.monthKind === "nth"}
										tabIndex={draft.monthKind === "nth" ? 0 : -1}
										onChange={() => set({ monthKind: "nth" })}
									/>
									<span>The</span>
								</label>
								<select
									class="dropdown"
									aria-label="Which one"
									value={String(draft.nthN)}
									onChange={(e) => set({ monthKind: "nth", nthN: Number(e.currentTarget.value) as NthValue })}
								>
									{NTH_OPTIONS.map((o) => (
										<option key={o.n} value={String(o.n)} selected={draft.nthN === o.n}>
											{o.label}
										</option>
									))}
								</select>
								<select
									class="dropdown"
									aria-label="Weekday"
									value={draft.nthWeekday}
									onChange={(e) => set({ monthKind: "nth", nthWeekday: e.currentTarget.value as Weekday })}
								>
									{weekdaysFrom(props.weekStart).map((d) => (
										<option key={d} value={d} selected={draft.nthWeekday === d}>
											{WEEKDAY_LONG[d]}
										</option>
									))}
								</select>
							</div>
							<label class="cp-repeat-radio-row">
								<input
									type="radio"
									name={radioName}
									data-kind="lastDay"
									checked={draft.monthKind === "lastDay"}
									tabIndex={draft.monthKind === "lastDay" ? 0 : -1}
									onChange={() => set({ monthKind: "lastDay" })}
								/>
								<span>The last day of the month</span>
							</label>
						</div>
					</>
				)}

				<label class={`cp-repeat-check cp-repeat-ctl${block === null ? "" : " is-off"}`}>
					<input
						type="checkbox"
						checked={draft.after && block === null}
						disabled={block !== null}
						onChange={(e) => set({ after: e.currentTarget.checked })}
					/>
					<span class="cp-repeat-check-text">
						{"Count from when I complete it"}
						<small>{afterCompletionHint(draft, today)}</small>
					</span>
				</label>

				<span class="cp-repeat-lbl" id={endsId}>
					Ends
				</span>
				<div class="cp-repeat-r">
					<div class="cp-repeat-seg" role="group" aria-labelledby={endsId}>
						{ENDS.map((o) => (
							<button key={o.kind} type="button" data-end={o.kind} aria-pressed={draft.endKind === o.kind} onClick={() => set({ endKind: o.kind })}>
								{o.label}
							</button>
						))}
					</div>
					{draft.endKind === "date" && (
						<input
							class="cp-repeat-date"
							type="date"
							aria-label="End date"
							value={draft.endDate}
							onInput={(e) => set({ endDate: e.currentTarget.value })}
						/>
					)}
					{draft.endKind === "count" && (
						<>
							<input
								class="cp-repeat-num"
								type="number"
								min={1}
								step={1}
								aria-label="Times"
								value={draft.endCount}
								onInput={(e) => set({ endCount: e.currentTarget.value })}
							/>
							<span>times</span>
						</>
					)}
				</div>

				<div class={`cp-repeat-summary cp-repeat-full${problem === null ? "" : " is-problem"}`} aria-live="polite">
					{summary}
				</div>
			</div>
			<div class="cp-pbtns cp-repeat-btns">
				<button type="button" class="cp-pop-clear cp-repeat-back" onClick={props.onBack}>
					Back
				</button>
				<button type="button" class="cp-pop-ok cp-repeat-done" disabled={problem !== null} onClick={() => problem === null && props.onDone(choiceOfDraft(draft))}>
					Done
				</button>
			</div>
		</div>
	);
}

// -- The picker on its own ------------------------------------------------------------------

/**
 * Presets, then Custom: the details pane's Repeat field and Quick Add's "All fields" open it in place under
 * their button. `onDone` gets the new value (null = Never); `onClose` closes it without a change (Escape).
 * Escape closes only the picker: the key stops here, so no dialog or view around it also acts.
 */
export function RepeatPicker(props: PickerEnv & { value: RepeatChoice | null; onDone: (choice: RepeatChoice | null) => void; onClose: () => void }) {
	const [face, setFace] = useState<"presets" | "custom">("presets");
	const base = useUniqueId("cp-repeat-pop");
	const [dialogId, lineId] = ["dialog", "line"].map((k) => `${base}-${k}`) as [string, string];
	const rootRef = useRef<HTMLDivElement>(null);
	// Back from the editor puts focus on "Custom…", where the user was; a first open focuses the selected preset.
	const [cameBack, setCameBack] = useState(false);
	const back = () => {
		setCameBack(true);
		setFace("presets");
	};
	return (
		<div
			ref={rootRef}
			class="cp-pop cp-repeat-pop is-inline"
			role="dialog"
			aria-labelledby={dialogId}
			onKeyDown={(e) => popoverKeyDown(e, rootRef.current, props.onClose)}
		>
			<SrOnly id={dialogId}>{face === "presets" ? "Repeat" : "Custom repeat"}</SrOnly>
			{face === "presets" ? (
				<div class="cp-repeat-presets">
					<div class="cp-repeat-line">
						{props.setIcon !== undefined && <QaIcon setIcon={props.setIcon} name="repeat" cls="cp-pop-row-icon" />}
						<span class="cp-repeat-line-k" id={lineId}>
							Repeat
						</span>
						<span class="cp-repeat-line-v">{repeatLine(props.value, props.anchor, props.today)}</span>
					</div>
					<RepeatPresets value={props.value} anchor={props.anchor} labelledBy={lineId} autoFocus={cameBack ? "custom" : true} explicitFor={props.explicitPresets === true ? props.anchor : undefined} onPick={props.onDone} onCustom={() => setFace("custom")} />
				</div>
			) : (
				<RepeatCustom {...props} onBack={back} onDone={props.onDone} />
			)}
		</div>
	);
}

// -- The Repeat field ------------------------------------------------------------------------

/**
 * A `cp-field` whose button shows the rule ("Never" when none) and opens the picker in place under it: the
 * details pane's Repeat field and the Repeat field of Quick Add's "All fields". Focus returns to the button
 * when the picker closes.
 */
export function RepeatField(props: PickerEnv & {
	value: RepeatChoice | null;
	onChange: (choice: RepeatChoice | null) => void;
	disabled?: boolean;
	title?: string;
	/** A number that grows each time something else asks for the picker to open ("Edit repeat…"). */
	openRequest?: number;
	/**
	 * Lets the owner know and decide whether the picker is open: the Quick Add modal closes it on Escape before it
	 * closes itself (Obsidian's Modal handles Escape before our own handlers do).
	 */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const [innerOpen, setInnerOpen] = useState(false);
	const open = props.open ?? innerOpen;
	const setOpen = (next: boolean) => {
		setInnerOpen(next);
		props.onOpenChange?.(next);
	};
	useEffect(() => {
		if (props.openRequest !== undefined && props.openRequest > 0) setOpen(true);
	}, [props.openRequest]);
	const id = useUniqueId("cp-repeat-field");
	const buttonRef = useRef<HTMLButtonElement>(null);
	const close = () => setOpen(false);
	// Whoever closes the picker (Done, Escape, the Quick Add modal's Escape), focus goes back to its button.
	const wasOpen = useRef(false);
	useEffect(() => {
		if (wasOpen.current && !open) buttonRef.current?.focus();
		wasOpen.current = open;
	}, [open]);
	return (
		<div class={`cp-field cp-repeat-field${open ? " is-open" : ""}`}>
			<span id={`${id}-label`}>Repeat</span>
			<button
				ref={buttonRef}
				id={`${id}-button`}
				type="button"
				class="cp-repeat-button"
				aria-labelledby={`${id}-label ${id}-button`}
				aria-haspopup="dialog"
				aria-expanded={open}
				disabled={props.disabled}
				title={props.title}
				onClick={() => setOpen(!open)}
			>
				{props.setIcon !== undefined && <QaIcon setIcon={props.setIcon} name="repeat" cls="cp-repeat-button-icon" />}
				<span class="cp-repeat-button-text">{repeatLine(props.value, props.anchor, props.today)}</span>
			</button>
			{open && (
				<RepeatPicker
					{...props}
					onDone={(choice) => {
						props.onChange(choice);
						close();
					}}
					onClose={close}
				/>
			)}
		</div>
	);
}
