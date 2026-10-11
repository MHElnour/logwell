import { categoryText } from "../icons";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { WeekStart } from "../../app/settings";
import type { Chip } from "../../parsing";
import { SrOnly } from "../common";
import { specFromInputs, specInputs } from "../format";
import { useUniqueId } from "../hooks";
import type { UiHost } from "../host";
import { chipActionHint, chipHint, chipLabel } from "./chipLabels";
import { DatePopover, MorePopover } from "./AddBarPopovers";
import { manualPills } from "./manualPills";
import { QaIcon, type SetIcon } from "./QaIcon";
import type { QuickAddModel } from "./QuickAddModel";

// The shared Quick Add editor: an input with highlighted spans, the chip
// row and the inline picker of the chip being chosen. The modal form
// and the inline add bar both render it, so there is one set of keyboard rules.

export function QuickAddEditor(props: {
	model: QuickAddModel;
	attachTokenSuggest: UiHost["attachTokenSuggest"];
	ariaLabel: string;
	placeholder: string;
	inputClass?: string;
	autoFocus?: boolean;
	compact?: boolean;
	/** The date popover's week start, the icon renderer and the note picker of the more menu. */
	weekStart: WeekStart;
	setIcon: SetIcon;
	pickNote: () => Promise<string | null>;
}) {
	const { model } = props;
	const chipsLabelId = useUniqueId("cp-qa-chips-label");
	const rootRef = useRef<HTMLDivElement>(null);
	const wrapRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const mirrorRef = useRef<HTMLDivElement>(null);
	const [roving, setRoving] = useState<string | null>(null);
	const chips = model.result.chips;
	const pills = manualPills(model);

	// The suggester: attached once; it owns Enter, arrows and Escape while it is open.
	useEffect(() => {
		const input = inputRef.current;
		if (input === null) return;
		const suggest = props.attachTokenSuggest(input, (d) => model.bind(d));
		model.suggesterBusy = () => suggest.isOpen();
		return () => {
			model.suggesterBusy = () => false;
			suggest.dispose();
		};
	}, [model]);

	useEffect(() => {
		if (props.autoFocus === true) inputRef.current?.focus();
	}, []);

	// Focus requests from the controller (after a dismiss, a pick or a blocked save).
	useEffect(() => {
		const target = model.focus;
		if (target === null) return;
		model.focus = null;
		const root = rootRef.current;
		if (root === null) return;
		if (target.kind === "panel") {
			root.querySelector<HTMLElement>(".cp-qa-panel select, .cp-qa-panel input")?.focus();
		} else if (target.kind === "tool") {
			root.querySelector<HTMLElement>(`.cp-qa-tool[data-tool="${target.tool}"]`)?.focus();
		} else if (target.kind === "chip") {
			const main = root.querySelector<HTMLElement>(`[data-chip-id="${target.id}"] .cp-qa-chip-main`);
			(main ?? inputRef.current)?.focus();
		} else {
			inputRef.current?.focus();
		}
	}, [model, model.focusTick]);

	// A press outside the bar and its popover closes the popover (no focus change: the press went elsewhere).
	const popover = model.popover;
	useEffect(() => {
		const wrap = wrapRef.current;
		if (popover === null || wrap === null) return;
		const doc = wrap.ownerDocument;
		const onPress = (e: MouseEvent) => {
			if (e.target instanceof Node && wrap.contains(e.target)) return;
			model.closePopover(false);
		};
		doc.addEventListener("mousedown", onPress, true);
		return () => doc.removeEventListener("mousedown", onPress, true);
	}, [model, popover]);

	// Keep the highlight layer aligned when a long input scrolls (onScroll) and when its own content changes
	// (new text or chips can change how far the layer can scroll). Reading `scrollLeft` forces a layout of
	// everything the commit touched, so it must not run on every commit: a save re-renders the whole app, and
	// at 50,000 tasks that forced layout cost 350-475 ms. The chips are compared by what is drawn, not by
	// identity: the controller reparses on every store change and hands out a new result each time.
	const mirrorKey = chips.map((c) => `${c.id}:${c.status}`).join("|");
	useLayoutEffect(() => {
		if (mirrorRef.current !== null && inputRef.current !== null) mirrorRef.current.scrollLeft = inputRef.current.scrollLeft;
	}, [model, model.input, mirrorKey]);

	const open = model.openChipId === null ? undefined : model.chip(model.openChipId);
	const active = chips.some((c) => c.id === roving) ? roving : (chips[0]?.id ?? null);

	const moveFocus = (from: number, to: number) => {
		const target = chips[Math.max(0, Math.min(chips.length - 1, to))];
		if (target === undefined || to === from) return;
		rootRef.current?.querySelector<HTMLElement>(`[data-chip-id="${target.id}"] .cp-qa-chip-main`)?.focus();
	};

	const onChipKey = (e: KeyboardEvent, chip: Chip, index: number) => {
		if (e.isComposing) return;
		if (e.key === "ArrowRight") moveFocus(index, index + 1);
		else if (e.key === "ArrowLeft") moveFocus(index, index - 1);
		else if (e.key === "Home") moveFocus(index, 0);
		else if (e.key === "End") moveFocus(index, chips.length - 1);
		else if (e.key === "Delete" || e.key === "Backspace") model.dismiss(chip);
		else if (e.key === "Enter") model.activate(chip);
		else return;
		e.preventDefault();
		e.stopPropagation();
	};

	const labelEnv = {
		zone: model.env.app.settings.zone(),
		today: model.env.app.queryContext().today,
		categories: model.env.app.categories.list(),
		tags: model.env.app.store.state.tags,
		anchor: model.repeatAnchor(),
	};

	return (
		<div ref={rootRef} class={`cp-qa${props.compact === true ? " is-compact" : ""}`}>
			<div ref={wrapRef} class="cp-qa-barwrap">
				<div class="cp-qa-bar">
					<QaIcon setIcon={props.setIcon} name="plus" cls="cp-qa-lead" />
					<div class="cp-qa-input-wrap">
						<div ref={mirrorRef} class="cp-qa-mirror" aria-hidden="true">
							{/* One inline wrapper: as direct flex items, the spaces between highlights were
							    dropped and every highlight after them drifted left (found in manual testing). */}
							<span class="cp-qa-mirror-text">{mirrorSegments(model.input, chips)}</span>
						</div>
						<input
							ref={inputRef}
							class={`cp-qa-input ${props.inputClass ?? ""}`}
							type="text"
							placeholder={props.placeholder}
							aria-label={props.ariaLabel}
							autocomplete="off"
							spellcheck={false}
							value={model.input}
							onInput={(e) => model.setInput(e.currentTarget.value)}
							onScroll={() => {
								if (mirrorRef.current !== null && inputRef.current !== null) mirrorRef.current.scrollLeft = inputRef.current.scrollLeft;
							}}
							onKeyDown={(e) => {
								if (e.isComposing || e.defaultPrevented) return;
								if (e.key === "Escape") {
									// Escape closes only an open popover; otherwise the host's own handling applies.
									if (model.closePopover(false)) {
										e.preventDefault();
										e.stopPropagation();
									}
									return;
								}
								if (e.key !== "Enter") return;
								e.preventDefault();
								void model.requestSave();
							}}
						/>
					</div>
					<button
						type="button"
						class={`cp-qa-tool${popover === "date" ? " is-on" : ""}`}
						data-tool="date"
						aria-label="Date"
						aria-haspopup="dialog"
						aria-expanded={popover === "date"}
						onClick={() => model.togglePopover("date")}
					>
						<QaIcon setIcon={props.setIcon} name="calendar" />
					</button>
					<button
						type="button"
						class={`cp-qa-tool${popover === "more" ? " is-on" : ""}`}
						data-tool="more"
						aria-label="Priority, list, tags and note"
						aria-haspopup="dialog"
						aria-expanded={popover === "more"}
						onClick={() => model.togglePopover("more")}
					>
						<QaIcon setIcon={props.setIcon} name="chevron-down" />
					</button>
				</div>
				{popover === "date" && <DatePopover model={model} setIcon={props.setIcon} weekStart={props.weekStart} />}
				{popover === "more" && <MorePopover model={model} setIcon={props.setIcon} pickNote={props.pickNote} />}
			</div>
			{model.message !== null && (
				<div class="cp-form-message" role="alert">
					{model.message}
				</div>
			)}
			{(chips.length > 0 || pills.length > 0) && (
				<>
					{/* A sibling, not a child: a list owns only list items. */}
					<SrOnly id={chipsLabelId}>Recognized items</SrOnly>
					<div class="cp-qa-chips" role="list" aria-labelledby={chipsLabelId}>
						{chips.map((chip, index) => {
							const notice = model.noticeFor(chip);
							const hint = chipHint(chip, notice);
							const fixed = model.isFixedCategory(chip);
							const label = chipLabel(chip, labelEnv);
							const name = `${chipActionHint(chip, model.panelKind(chip) !== null, fixed)}${label}${hint === null ? "" : `. ${hint}`}. Press Delete to keep as text`;
							return (
								<div
									key={chip.id}
									role="listitem"
									class={`cp-qa-chip cp-qa-chip-${chip.status}${chip.warning !== undefined ? " has-warning" : ""}`}
									data-chip-id={chip.id}
									data-status={chip.status}
									data-kind={chip.kind}
									data-priority={chip.kind === "priority" ? chip.priority : undefined}
								>
									<QaIcon setIcon={props.setIcon} name={CHIP_ICON[chip.kind]} cls="cp-qa-chip-icon" />
									<button
										type="button"
										class="cp-qa-chip-main"
										aria-label={name}
										tabIndex={chip.id === active ? 0 : -1}
										onFocus={() => setRoving(chip.id)}
										onKeyDown={(e) => onChipKey(e, chip, index)}
										onClick={() => model.activate(chip)}
									>
										<span class="cp-qa-chip-label">{label}</span>
										{hint !== null && <span class="cp-qa-chip-hint">{hint}</span>}
									</button>
									<button
										type="button"
										class="cp-qa-chip-remove"
										tabIndex={-1}
										aria-label={`Keep "${chip.text}" as text`}
										onClick={() => model.dismiss(chip)}
									>
										×
									</button>
								</div>
							);
						})}
						{pills.map((pill) => (
							<div
								key={pill.key}
								role="listitem"
								class="cp-qa-manual"
								data-kind={pill.kind}
								data-priority={pill.priority}
							>
								<QaIcon setIcon={props.setIcon} name={pill.icon} cls="cp-qa-chip-icon" />
								<span class="cp-qa-manual-label">{pill.label}</span>
								<button type="button" class="cp-qa-manual-remove" aria-label={`Remove ${pill.label}`} onClick={() => pill.remove()}>
									×
								</button>
							</div>
						))}
					</div>
				</>
			)}
			{open !== undefined && <ChipPanel key={open.id} model={model} chip={open} />}
		</div>
	);
}

const CHIP_ICON: Record<Chip["kind"], string> = {
	scheduled: "calendar",
	deadline: "flag",
	duration: "clock",
	category: "list",
	tag: "tag",
	note: "file-text",
	priority: "flag",
	recurrence: "repeat",
};

/** The highlight class of a span by kind: date blue, duration neutral, list accent, priority by level. */
function spanKindClass(chip: Chip): string {
	switch (chip.kind) {
		case "scheduled":
		case "deadline":
			return "cp-qa-tok-date";
		case "duration":
			return "cp-qa-tok-dur";
		case "category":
			return "cp-qa-tok-cat";
		case "priority":
			return `cp-qa-tok-pri cp-qa-tok-pri-${chip.priority ?? 0}`;
		case "tag":
			return "cp-qa-tok-tag";
		case "recurrence":
			return "cp-qa-tok-repeat";
		default:
			return "cp-qa-tok-other";
	}
}

/** The input text with every recognized span in a <mark>, for the layer behind the input. */
function mirrorSegments(input: string, chips: readonly Chip[]): ComponentChildren {
	const out: ComponentChildren[] = [];
	let at = 0;
	for (const chip of chips) {
		if (chip.span.start < at) continue;
		if (chip.span.start > at) out.push(input.slice(at, chip.span.start));
		out.push(
			<mark key={chip.id} class={`cp-qa-span cp-qa-span-${chip.status} ${spanKindClass(chip)}`}>
				{input.slice(chip.span.start, chip.span.end)}
			</mark>,
		);
		at = chip.span.end;
	}
	out.push(input.slice(at));
	return out;
}

/** The picker or editor of one chip. It is part of the same form, never a second dialog. */
function ChipPanel({ model, chip }: { model: QuickAddModel; chip: Chip }) {
	const titleId = useUniqueId("cp-qa-panel-title");
	const kind = model.panelKind(chip);
	const selectRef = useRef<HTMLSelectElement>(null);
	const dateRef = useRef<HTMLInputElement>(null);
	const timeRef = useRef<HTMLInputElement>(null);
	if (kind === null) return null;

	const apply = () => {
		if (kind === "edit") {
			const spec = specFromInputs(dateRef.current?.value ?? "", chip.kind === "deadline" ? "" : (timeRef.current?.value ?? ""), model.env.app.settings.zone());
			if (spec === null) return;
			model.setChipDate(chip, spec);
			return;
		}
		const value = selectRef.current?.value ?? "";
		if (kind === "alternatives") {
			const alt = chip.alternatives?.[Number(value)];
			if (alt?.rule !== undefined) model.setChipRule(chip, alt.rule);
			else if (alt?.value !== undefined) model.setChipDate(chip, alt.value);
		} else if (kind === "categories") model.pickCategory(chip, value);
		else model.pickNote(chip, value);
	};

	const onKey = (e: KeyboardEvent) => {
		if (e.isComposing) return;
		if (e.key === "Enter") {
			e.preventDefault();
			e.stopPropagation();
			apply();
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			model.closePanel();
		}
	};

	const title =
		kind === "alternatives"
			? `Choose a value for "${chip.text}"`
			: kind === "categories"
				? `List for "${chip.text}"`
				: kind === "candidates"
					? `Note for "${chip.text}"`
					: `Edit "${chip.text}"`;

	let body: ComponentChildren;
	if (kind === "edit") {
		const initial = chip.date === undefined ? { date: "", time: "" } : specInputs(chip.date, model.env.app.settings.zone());
		body = (
			<>
				<label class="cp-field">
					<span>Date</span>
					<input ref={dateRef} type="date" value={initial.date} onKeyDown={onKey} />
				</label>
				{chip.kind === "scheduled" && (
					<label class="cp-field">
						<span>Time</span>
						<input ref={timeRef} type="time" value={initial.time} onKeyDown={onKey} />
					</label>
				)}
			</>
		);
	} else {
		let options: { value: string; label: string }[];
		let initial: string;
		if (kind === "alternatives") {
			options = (chip.alternatives ?? []).map((a, i) => ({ value: String(i), label: a.label }));
			initial = "0";
		} else if (kind === "categories") {
			options = model.env.app.categories.list().map((c) => ({ value: c.id, label: categoryText(c) }));
			initial = model.pickerCategory();
		} else {
			options = (chip.candidates ?? []).map((p) => ({ value: p, label: p }));
			initial = options[0]?.value ?? "";
		}
		body = (
			<label class="cp-field">
				<span>{kind === "categories" ? "List" : kind === "candidates" ? "Note" : "Value"}</span>
				<select ref={selectRef} class="dropdown" onKeyDown={onKey}>
					{options.map((o) => (
						<option key={o.value} value={o.value} selected={o.value === initial}>
							{o.label}
						</option>
					))}
				</select>
			</label>
		);
	}

	return (
		<div class="cp-qa-panel" role="group" aria-labelledby={titleId}>
			<span id={titleId} class="cp-qa-panel-title">
				{title}
			</span>
			{body}
			<button type="button" class="cp-qa-apply mod-cta" onClick={apply}>
				Apply
			</button>
			<button type="button" class="cp-qa-cancel" onClick={() => model.closePanel()}>
				Cancel
			</button>
		</div>
	);
}
