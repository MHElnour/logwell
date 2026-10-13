import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { WeekStart } from "../../app/settings";
import { tagsByLabel } from "../../domain/tags";
import { MAX_DURATION_MIN } from "../../domain/tasks";
import { type YearMonth, addDays, shiftMonth, yearMonthOf } from "../../domain/time";
import { noteDisplayName } from "../../domain/notes";
import { INBOX_NAME, type LocalDate, type Priority } from "../../domain/types";
import { SrOnly } from "../common";
import { formatDateSpec } from "../format";
import { RepeatCustom, RepeatPresets } from "../RepeatPicker";
import { repeatLine } from "../repeat";
import { useUniqueId } from "../hooks";
import { priorityLabel } from "./chipLabels";
import { dayLabel, monthGrid, shiftDateByMonths } from "./calendar";
import { monthTitle } from "../calendar/format";
import { quadrantWords } from "../matrix/quadrants";
import { pad2, weekdayInitials } from "../format";
import { focusables, popoverKeyDown } from "../popoverKeys";
import { applyPopoverFit, attachPopover } from "./popoverFit";
import { QaIcon, type SetIcon } from "./QaIcon";
import type { QuickAddModel } from "./QuickAddModel";

// The add bar's two popovers: the date popover and the more menu.
// They render inside the plugin container (never on the body; popoverFit.ts lifts them into the
// top layer without moving them) and apply values through the QuickAddModel's manual-field API,
// so the rules for typed and manual values apply unchanged.
//
// Keys: Escape closes only the popover (and stops there, so neither the form, the view nor the
// modal also acts); Enter inside the popover activates the focused control and never saves;
// Tab cycles inside; the day grid and the priority flags use arrow keys.

interface PopoverProps {
	model: QuickAddModel;
	setIcon: SetIcon;
}

/**
 * Attaches the popover to its add bar while it is open (top layer, resize and scroll; see
 * popoverFit.ts) and fits it to the space it has after every render, because a tab or an edit row
 * changes the height. Fitting only touches the element's style, so it cannot cause another render.
 * A scroll that takes the bar out of the window closes the popover.
 */
function usePopoverFit(ref: { current: HTMLElement | null }, model: QuickAddModel): void {
	// Declared first: on open the popover must be in the top layer before it is measured.
	useLayoutEffect(() => {
		const el = ref.current;
		if (el === null) return;
		return attachPopover(el, () => model.closePopover(false));
	}, []);
	useLayoutEffect(() => {
		if (ref.current !== null) applyPopoverFit(ref.current);
	});
}

function Row(props: {
	setIcon: SetIcon;
	icon: string;
	label: string;
	row: string;
	value?: string;
	expanded?: boolean;
	disabled?: boolean;
	title?: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			class="cp-pop-row"
			data-row={props.row}
			aria-expanded={props.expanded}
			disabled={props.disabled}
			title={props.title}
			onClick={props.onClick}
		>
			<QaIcon setIcon={props.setIcon} name={props.icon} cls="cp-pop-row-icon" />
			<span class="cp-pop-grow">{props.label}</span>
			{props.value !== undefined && <span class="cp-pop-val">{props.value}</span>}
			<QaIcon setIcon={props.setIcon} name="chevron-right" cls="cp-pop-chevron" />
		</button>
	);
}

/** A native time or date input inside a popover row; it takes focus when it appears. */
function FieldEdit(props: { type: "time" | "date"; label: string; value: string; onValue: (v: string) => void; onDone: () => void }) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		ref.current?.focus();
	}, []);
	return (
		<div class="cp-pop-edit">
			<input
				ref={ref}
				type={props.type}
				aria-label={props.label}
				value={props.value}
				onInput={(e) => props.onValue(e.currentTarget.value)}
				onKeyDown={(e) => {
					if (e.key !== "Enter" || e.isComposing) return;
					e.preventDefault();
					e.stopPropagation();
					props.onDone();
				}}
			/>
		</div>
	);
}

// -- Date popover ---------------------------------------------------------------

const DURATION_PRESETS: { min: number; label: string }[] = [
	{ min: 15, label: "15m" },
	{ min: 30, label: "30m" },
	{ min: 45, label: "45m" },
	{ min: 60, label: "1h" },
	{ min: 90, label: "1h30" },
	{ min: 120, label: "2h" },
];

export function DatePopover(props: PopoverProps & { weekStart: WeekStart }) {
	const { model, setIcon } = props;
	// Containers are named with aria-labelledby: Obsidian tooltips any element with an aria-label.
	const id = useUniqueId("cp-date-pop");
	const [dialogLabelId, tabsLabelId, calTitleId, durLabelId] = ["dialog", "tabs", "cal-title", "dur"].map((k) => `${id}-${k}`) as [string, string, string, string];
	const rootRef = useRef<HTMLDivElement>(null);
	const app = model.env.app;
	const today = app.queryContext().today;
	const zone = app.settings.zone();
	const { date: picked, time } = model.dateInputs();
	const deadline = model.deadlineInput();
	const [tab, setTab] = useState<"date" | "duration">("date");
	const [focusDate, setFocusDate] = useState<LocalDate>(picked !== "" ? picked : today);
	// The roving day, updated at once: a second arrow key can arrive before the re-render moves
	// focus, so keys are based on this, not on the day that received the event (found by e2e).
	const focusDateRef = useRef<LocalDate>(focusDate);
	const [ym, setYm] = useState<YearMonth>(() => yearMonthOf(picked !== "" ? picked : today));
	const [editing, setEditing] = useState<"time" | "deadline" | null>(null);
	// The Repeat row opens the presets in place; "Custom…" swaps the whole popover for the custom editor.
	const [repeatOpen, setRepeatOpen] = useState(false);
	const [face, setFace] = useState<"date" | "custom">("date");
	const repeat = model.repeatValue();
	const repeatAnchor = model.repeatAnchor();
	const repeatLineId = `${id}-repeat`;
	const doneEditing = (row: "time" | "deadline" | "repeat") => {
		setEditing(null);
		// The field unmounts; put focus back on its row so keyboard users keep their place.
		const root = rootRef.current;
		root?.ownerDocument.defaultView?.setTimeout(() => root.querySelector<HTMLElement>(`.cp-pop-row[data-row="${row}"]`)?.focus(), 0);
	};
	// True when the next render should put focus on the roving day (on open and after arrow keys).
	const moveFocus = useRef(true);

	useEffect(() => {
		if (!moveFocus.current || tab !== "date") return;
		moveFocus.current = false;
		rootRef.current?.querySelector<HTMLElement>(`.cp-cal-day[data-date="${focusDateRef.current}"]`)?.focus();
	});

	usePopoverFit(rootRef, model);
	const close = (refocus: boolean) => model.closePopover(refocus);
	const show = (date: LocalDate, focus: boolean) => {
		moveFocus.current = focus;
		focusDateRef.current = date;
		setFocusDate(date);
		setYm(yearMonthOf(date));
	};
	const pick = (date: LocalDate) => {
		model.setDate(date);
		show(date, false);
	};
	const goMonth = (delta: number) => {
		setYm(shiftMonth(ym, delta));
		focusDateRef.current = shiftDateByMonths(focusDateRef.current, delta);
		setFocusDate(focusDateRef.current);
	};

	const onDayKey = (e: KeyboardEvent, eventDate: LocalDate) => {
		if (e.isComposing) return;
		const date = e.key === "Enter" || e.key === " " ? eventDate : focusDateRef.current;
		let next: LocalDate | null = null;
		if (e.key === "ArrowLeft") next = addDays(date, -1);
		else if (e.key === "ArrowRight") next = addDays(date, 1);
		else if (e.key === "ArrowUp") next = addDays(date, -7);
		else if (e.key === "ArrowDown") next = addDays(date, 7);
		else if (e.key === "PageUp") next = shiftDateByMonths(date, -1);
		else if (e.key === "PageDown") next = shiftDateByMonths(date, 1);
		else if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			e.stopPropagation();
			pick(date);
			return;
		}
		if (next === null) return;
		e.preventDefault();
		e.stopPropagation();
		show(next, true);
	};

	const quick: { label: string; icon: string; run: () => void }[] = [
		{ label: "Today", icon: "sun", run: () => pick(today) },
		{ label: "Tomorrow", icon: "sunrise", run: () => pick(addDays(today, 1)) },
		{ label: "Next week", icon: "calendar-plus", run: () => pick(addDays(today, 7)) },
		// Today at the evening time setting, the same as the typed word "tonight".
		{
			label: "Tonight",
			icon: "moon",
			run: () => {
				pick(today);
				model.setTime(model.eveningTime());
			},
		},
	];

	const setTimeValue = (v: string) => {
		if (v !== "" && picked === "") pick(today);
		model.setTime(v);
	};
	const deadlineText = deadline === "" ? "None" : formatDateSpec({ kind: "date", date: deadline }, zone, today);
	const cells = monthGrid(ym, props.weekStart);
	// A subtask does not repeat, so its bar has no Repeat row.
	const canRepeat = model.parent === undefined;
	const pickRepeat = (choice: Parameters<QuickAddModel["setRepeat"]>[0]) => {
		model.setRepeat(choice);
		setRepeatOpen(false);
		setFace("date");
		doneEditing("repeat");
	};

	if (face === "custom") {
		return (
			<div
				ref={rootRef}
				class="cp-pop cp-date-pop is-repeat"
				role="dialog"
				aria-labelledby={dialogLabelId}
				onKeyDown={(e) => popoverKeyDown(e, rootRef.current, () => close(true))}
			>
				<SrOnly id={dialogLabelId}>Custom repeat</SrOnly>
				<div class="cp-pop-body">
					<RepeatCustom
						value={repeat}
						anchor={repeatAnchor}
						today={today}
						weekStart={props.weekStart}
						onBack={() => {
							setFace("date");
							doneEditing("repeat");
						}}
						onDone={pickRepeat}
					/>
				</div>
			</div>
		);
	}

	return (
		<div
			ref={rootRef}
			class="cp-pop cp-date-pop"
			role="dialog"
			aria-labelledby={dialogLabelId}
			onKeyDown={(e) => popoverKeyDown(e, rootRef.current, () => close(true))}
		>
			<SrOnly id={dialogLabelId}>Date and duration</SrOnly>
			<div class="cp-pop-body">
				{/* A sibling, not a child: a tablist owns only tabs. */}
				<SrOnly id={tabsLabelId}>Date or duration</SrOnly>
				<div class="cp-seg" role="tablist" aria-labelledby={tabsLabelId}>
					{(["date", "duration"] as const).map((t) => (
						<button
							key={t}
							type="button"
							role="tab"
							class={`cp-seg-tab${tab === t ? " is-on" : ""}`}
							aria-selected={tab === t}
							onClick={() => setTab(t)}
						>
							{t === "date" ? "Date" : "Duration"}
						</button>
					))}
				</div>
				{tab === "date" ? (
					<>
						<div class="cp-quick">
							{quick.map((q) => (
								<button key={q.label} type="button" class="cp-quick-btn" onClick={q.run}>
									<QaIcon setIcon={setIcon} name={q.icon} cls="cp-quick-icon" />
									{q.label}
								</button>
							))}
						</div>
						<div class="cp-cal-head">
							<span id={calTitleId} class="cp-cal-title" aria-live="polite">
								{monthTitle(`${String(ym.year).padStart(4, "0")}-${pad2(ym.month)}`)}
							</span>
							<span class="cp-cal-nav">
								<button type="button" aria-label="Previous month" onClick={() => goMonth(-1)}>
									<QaIcon setIcon={setIcon} name="chevron-left" />
								</button>
								<button type="button" aria-label="Next month" onClick={() => goMonth(1)}>
									<QaIcon setIcon={setIcon} name="chevron-right" />
								</button>
							</span>
						</div>
						<div class="cp-cal" role="group" aria-labelledby={calTitleId}>
							{weekdayInitials(props.weekStart).map((w, i) => (
								<span key={`wd${i}`} class="cp-cal-wd" aria-hidden="true">
									{w}
								</span>
							))}
							{cells.map((c) => (
								<button
									key={c.date}
									type="button"
									class={`cp-cal-day${c.inMonth ? "" : " is-muted"}${c.date === today ? " is-today" : ""}${c.date === picked ? " is-picked" : ""}`}
									data-date={c.date}
									aria-label={dayLabel(c.date)}
									aria-pressed={c.date === picked}
									tabIndex={c.date === focusDate ? 0 : -1}
									onFocus={() => {
										focusDateRef.current = c.date;
										setFocusDate(c.date);
									}}
									onClick={() => pick(c.date)}
									onKeyDown={(e) => onDayKey(e, c.date)}
								>
									{Number(c.date.slice(8, 10))}
								</button>
							))}
						</div>
						<div class="cp-pop-rows">
							<Row
								setIcon={setIcon}
								icon="clock"
								label="Time"
								row="time"
								value={time === "" ? "None" : time}
								expanded={editing === "time"}
								onClick={() => setEditing(editing === "time" ? null : "time")}
							/>
							{editing === "time" && <FieldEdit type="time" label="Time" value={time} onValue={setTimeValue} onDone={() => doneEditing("time")} />}
							<Row
								setIcon={setIcon}
								icon="flag"
								label="Deadline"
								row="deadline"
								value={deadlineText}
								expanded={editing === "deadline"}
								onClick={() => setEditing(editing === "deadline" ? null : "deadline")}
							/>
							{editing === "deadline" && (
								<FieldEdit type="date" label="Deadline" value={deadline} onValue={(v) => model.setDeadline(v)} onDone={() => doneEditing("deadline")} />
							)}
							{canRepeat && (
								<>
									<Row
										setIcon={setIcon}
										icon="repeat"
										label="Repeat"
										row="repeat"
										value={repeatLine(repeat, repeatAnchor, today)}
										expanded={repeatOpen}
										onClick={() => setRepeatOpen(!repeatOpen)}
									/>
									{repeatOpen && (
										<div class="cp-repeat-inline">
											<SrOnly id={repeatLineId}>Repeat</SrOnly>
											<RepeatPresets value={repeat} anchor={repeatAnchor} labelledBy={repeatLineId} autoFocus onPick={pickRepeat} onCustom={() => setFace("custom")} />
										</div>
									)}
									{repeat !== null && deadline !== "" && <p class="cp-pop-empty">A repeating task has no deadline.</p>}
								</>
							)}
						</div>
					</>
				) : (
					<div class="cp-dur">
						<SrOnly id={durLabelId}>Duration</SrOnly>
						<div class="cp-dur-presets" role="group" aria-labelledby={durLabelId}>
							{DURATION_PRESETS.map((p) => (
								<button
									key={p.min}
									type="button"
									class={`cp-dur-btn${model.durationInput() === String(p.min) ? " is-on" : ""}`}
									aria-pressed={model.durationInput() === String(p.min)}
									onClick={() => model.setDuration(model.durationInput() === String(p.min) ? "" : String(p.min))}
								>
									{p.label}
								</button>
							))}
						</div>
						<label class="cp-dur-custom">
							<span>Custom (minutes)</span>
							<input
								type="number"
								min={1}
								max={MAX_DURATION_MIN}
								step={1}
								value={model.durationInput()}
								onInput={(e) => model.setDuration(e.currentTarget.value)}
							/>
						</label>
					</div>
				)}
			</div>
			<div class="cp-pbtns">
				<button
					type="button"
					class="cp-pop-clear"
					onClick={() => {
						model.clearDateFields();
						setEditing(null);
					}}
				>
					Clear
				</button>
				<button type="button" class="cp-pop-ok" onClick={() => close(true)}>
					OK
				</button>
			</div>
		</div>
	);
}

// -- More menu ------------------------------------------------------------------

const PRIORITIES: Priority[] = [1, 2, 3, 0];

export function MorePopover(props: PopoverProps & { pickNote: () => Promise<string | null> }) {
	const { model, setIcon } = props;
	const id = useUniqueId("cp-more-pop");
	const [dialogLabelId, priorityLabelId, subTitleId] = ["dialog", "priority", "sub"].map((k) => `${id}-${k}`) as [string, string, string];
	const rootRef = useRef<HTMLDivElement>(null);
	const [sub, setSub] = useState<"list" | "tags" | "quadrant" | null>(null);
	const app = model.env.app;
	const categories = app.categories.list();
	const tags = tagsByLabel(app.store.state.tags);
	const current = model.priorityValue();
	const categoryName = categories.find((c) => c.id === model.categoryValue())?.name ?? INBOX_NAME;
	const tagKeys = model.tagKeysValue();
	const notePath = model.notePathValue();
	const close = (refocus: boolean) => model.closePopover(refocus);
	usePopoverFit(rootRef, model);

	// Focus goes to the current priority flag when the menu opens, and to the first control of a submenu.
	useEffect(() => {
		const root = rootRef.current;
		if (root === null) return;
		const target = sub === null ? root.querySelector<HTMLElement>(".cp-pri-flag.is-on") : root.querySelector<HTMLElement>(".cp-pop-back");
		target?.focus();
	}, [sub]);

	const onKeyDown = (e: KeyboardEvent) => {
		const root = rootRef.current;
		if (!e.isComposing && root !== null && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
			const list = focusables(root);
			const at = list.indexOf(root.ownerDocument.activeElement as HTMLElement);
			const next = list[(at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length];
			if (next !== undefined) {
				e.preventDefault();
				e.stopPropagation();
				next.focus();
				return;
			}
		}
		popoverKeyDown(e, root, () => close(true));
	};

	const onFlagKey = (e: KeyboardEvent, index: number) => {
		if (e.isComposing || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
		const flags = [...(rootRef.current?.querySelectorAll<HTMLElement>(".cp-pri-flag") ?? [])];
		const next = flags[(index + (e.key === "ArrowRight" ? 1 : -1) + flags.length) % flags.length];
		if (next === undefined) return;
		e.preventDefault();
		e.stopPropagation();
		next.focus();
	};

	const pickNote = () => {
		// The note picker is a modal of its own: close the popover first, then apply the choice.
		close(false);
		void props.pickNote().then((path) => {
			if (path !== null) model.setNote(path);
		});
	};

	let body: ComponentChildren;
	if (sub === null) {
		body = (
			<>
				<div class="cp-pop-label" id={priorityLabelId}>
					Priority
				</div>
				<div class="cp-pri-flags" role="group" aria-labelledby={priorityLabelId}>
					{PRIORITIES.map((p, i) => (
						<button
							key={p}
							type="button"
							class={`cp-pri-flag cp-flag-${p}${current === p ? " is-on" : ""}`}
							aria-label={priorityLabel(p)}
							aria-pressed={current === p}
							onClick={() => model.setPriority(p)}
							onKeyDown={(e) => onFlagKey(e, i)}
						>
							<QaIcon setIcon={setIcon} name="flag" />
						</button>
					))}
				</div>
				<div class="cp-pop-sep" role="separator" />
				<Row
					setIcon={setIcon}
					icon="inbox"
					label="List"
					row="list"
					value={categoryName}
					disabled={model.parent !== undefined}
					title={model.parent !== undefined ? "A subtask stays in its parent's list" : undefined}
					onClick={() => setSub("list")}
				/>
				<Row
					setIcon={setIcon}
					icon="tag"
					label="Tags"
					row="tags"
					value={tagKeys.length === 0 ? "None" : `${tagKeys.length}`}
					onClick={() => setSub("tags")}
				/>
				<Row
					setIcon={setIcon}
					icon="file-text"
					label="Description note"
					row="note"
					value={notePath === null ? "None" : noteDisplayName(notePath)}
					onClick={pickNote}
				/>
				<Row
					setIcon={setIcon}
					icon="layout-grid"
					label="Matrix quadrant"
					row="quadrant"
					value={model.urgent || model.important ? quadrantWords(model.urgent, model.important) : "Not set"}
					onClick={() => setSub("quadrant")}
				/>
			</>
		);
	} else {
		const title = sub === "list" ? "List" : sub === "tags" ? "Tags" : "Matrix quadrant";
		body = (
			<>
				<button type="button" class="cp-pop-back" title="Back" onClick={() => setSub(null)}>
					<span aria-hidden="true">
						<QaIcon setIcon={setIcon} name="chevron-left" />
					</span>
					<span id={subTitleId}>{title}</span>
				</button>
				<div class="cp-pop-sep" role="separator" />
				<div class="cp-pop-choices" role="group" aria-labelledby={subTitleId}>
					{sub === "list" &&
						categories.map((c) => (
							<button
								key={c.id}
								type="button"
								class={`cp-pop-choice${c.id === model.categoryValue() ? " is-on" : ""}`}
								aria-pressed={c.id === model.categoryValue()}
								onClick={() => {
									model.setCategory(c.id);
									setSub(null);
								}}
							>
								{c.name}
							</button>
						))}
					{sub === "tags" &&
						(tags.length === 0 ? (
							<p class="cp-pop-empty">No tags yet. Type @name in the bar to create one.</p>
						) : (
							tags.map(({ tag: t, label }) => {
								const on = tagKeys.includes(t.key);
								return (
									<button
										key={t.key}
										type="button"
										class={`cp-pop-choice${on ? " is-on" : ""}`}
										aria-pressed={on}
										onClick={() => model.setTags(on ? tagKeys.filter((k) => k !== t.key) : [...tagKeys, t.key])}
									>
										{label}
									</button>
								);
							})
						))}
					{sub === "quadrant" &&
						(["urgent", "important"] as const).map((flag) => (
							<button
								key={flag}
								type="button"
								class={`cp-pop-choice${model[flag] ? " is-on" : ""}`}
								aria-pressed={model[flag]}
								onClick={() => model.setFlag(flag, !model[flag])}
							>
								{flag === "urgent" ? "Urgent" : "Important"}
							</button>
						))}
				</div>
			</>
		);
	}

	return (
		<div ref={rootRef} class="cp-pop cp-more-pop" role="dialog" aria-labelledby={dialogLabelId} onKeyDown={onKeyDown}>
			<SrOnly id={dialogLabelId}>Priority, list, tags and note</SrOnly>
			{body}
		</div>
	);
}
