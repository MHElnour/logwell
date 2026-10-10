import { categoryText } from "./icons";
import type { TargetedKeyboardEvent } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { CheckpointApp } from "../app/App";
import type { WeekStart } from "../app/settings";
import { normalizeTagKey } from "../domain/tags";
import { MAX_DURATION_MIN } from "../domain/tasks";
import type { DateLocale } from "../parsing";
import type { QuickAddPreset, UiHost } from "./host";
import type { SetIcon } from "./quickadd/QaIcon";
import { QuickAddEditor } from "./quickadd/QuickAddEditor";
import { RepeatField } from "./RepeatPicker";
import { useQuickAdd } from "./quickadd/useQuickAdd";
import { TagInput } from "./TagInput";

// Quick Add: one input that is parsed on every keystroke, chips
// for what was recognized, and the manual fields below. Enter saves;
// there is no confirmation dialog. The controller is in quickadd/QuickAddModel.

export function QuickAddForm(props: {
	app: CheckpointApp;
	preset: QuickAddPreset;
	locale: () => DateLocale;
	/** What "tonight" means, "HH:mm" (settings). */
	eveningTime?: () => string;
	/** The date popover's first weekday (settings). */
	weekStart: () => WeekStart;
	setIcon: SetIcon;
	keepOpen: () => boolean;
	pickNote: () => Promise<string | null>;
	resolveNote: (linktext: string) => string[];
	attachTokenSuggest: UiHost["attachTokenSuggest"];
	onSaved: (title: string, warnings: string[]) => void;
	onError: (err: unknown) => void;
	onClose: () => void;
	/** Lets the modal's Escape handler close an open popover or chip picker before it closes the modal. */
	registerEscape?: (closePicker: () => boolean) => void;
}) {
	const { app } = props;
	const model = useQuickAdd({
		app,
		preset: props.preset,
		locale: props.locale,
		...(props.eveningTime ? { eveningTime: props.eveningTime } : {}),
		resolveNote: props.resolveNote,
		onSaved: props.onSaved,
		onError: props.onError,
		keepOpen: props.keepOpen,
		onClose: props.onClose,
	});
	// The Repeat field of "All fields" opens its picker in place; Escape closes it before the modal.
	const [repeatOpen, setRepeatOpen] = useState(false);
	const repeatOpenRef = useRef(false);
	repeatOpenRef.current = repeatOpen;
	useEffect(() => {
		// A popover goes first, then a chip picker, then the repeat picker; either way the modal stays open.
		props.registerEscape?.(() => {
			if (model.closePopover(true) || model.closePanel()) return true;
			if (!repeatOpenRef.current) return false;
			setRepeatOpen(false);
			return true;
		});
	}, [model]);

	const parent = model.parent;
	const dates = model.dateInputs();
	const categories = app.categories.list();
	const notePath = model.notePathValue();

	const onKeyDown = (e: TargetedKeyboardEvent<HTMLFormElement>) => {
		if (e.key === "Enter" && !e.isComposing && !e.defaultPrevented) {
			const target = e.target as HTMLElement;
			if (target.tagName === "BUTTON" || target.tagName === "SELECT") return;
			e.preventDefault();
			void model.requestSave();
		}
	};

	return (
		<form
			class="cp-quick-add"
			onSubmit={(e) => {
				e.preventDefault();
				void model.requestSave();
			}}
			onKeyDown={onKeyDown}
		>
			<QuickAddEditor
				model={model}
				attachTokenSuggest={props.attachTokenSuggest}
				ariaLabel="Task title"
				placeholder={parent === undefined ? "Try “Read chapter 3 tomorrow 7pm #Study !1”" : `Subtask of ${parent.title}`}
				inputClass="cp-quick-add-title"
				autoFocus
				weekStart={props.weekStart()}
				setIcon={props.setIcon}
				pickNote={props.pickNote}
			/>
			<details class="cp-quick-add-all">
				<summary>All fields</summary>
			<div class="cp-quick-add-fields">
				<label class="cp-field">
					<span>Date</span>
					<input type="date" value={dates.date} onInput={(e) => model.setDate(e.currentTarget.value)} />
				</label>
				<label class="cp-field">
					<span>Time</span>
					<input
						type="time"
						value={dates.time}
						disabled={dates.date === ""}
						onInput={(e) => model.setTime(e.currentTarget.value)}
					/>
				</label>
				<label class="cp-field">
					<span>Deadline</span>
					<input type="date" value={model.deadlineInput()} onInput={(e) => model.setDeadline(e.currentTarget.value)} />
				</label>
				{/* The same picker as the date popover's Repeat row, in place under its button. A subtask does not repeat. */}
				<RepeatField
					value={model.repeatValue()}
					anchor={model.repeatAnchor()}
					today={app.queryContext().today}
					weekStart={props.weekStart()}
					setIcon={props.setIcon}
					onChange={(choice) => model.setRepeat(choice)}
					open={repeatOpen}
					onOpenChange={setRepeatOpen}
					disabled={parent !== undefined}
					title={parent !== undefined ? "A subtask cannot repeat" : undefined}
				/>
				<label class="cp-field">
					<span>Duration (min)</span>
					<input
						type="number"
						min={1}
						max={MAX_DURATION_MIN}
						step={1}
						value={model.durationInput()}
						onInput={(e) => model.setDuration(e.currentTarget.value)}
					/>
				</label>
				<label class="cp-field">
					<span>List</span>
					<select
						class="dropdown"
						value={model.categoryValue()}
						disabled={parent !== undefined}
						onChange={(e) => model.setCategory(e.currentTarget.value)}
					>
						{categories.map((c) => (
							<option key={c.id} value={c.id}>
								{categoryText(c)}
							</option>
						))}
					</select>
				</label>
				<div class="cp-field cp-flags">
					<label>
						<input
							type="checkbox"
							checked={model.urgent}
							onChange={(e) => model.setFlag("urgent", e.currentTarget.checked)}
						/>{" "}
						Urgent
					</label>
					<label>
						<input
							type="checkbox"
							checked={model.important}
							onChange={(e) => model.setFlag("important", e.currentTarget.checked)}
						/>{" "}
						Important
					</label>
				</div>
			</div>
			<TagInput
				app={app}
				value={model.tagKeysValue()}
				onChange={(keys) => model.setTags(keys)}
				onError={props.onError}
				normalize={normalizeTagKey}
			/>
			<div class="cp-quick-add-note">
				{notePath === null ? (
					<button
						type="button"
						onClick={() => {
							void props.pickNote().then((p) => p !== null && model.setNote(p));
						}}
					>
						Link existing note
					</button>
				) : (
					<span class="cp-chip">
						{notePath}
						{model.manual.has("note") ? (
							<button type="button" class="cp-chip-remove" aria-label="Remove note link" onClick={() => model.setNote(null)}>
								×
							</button>
						) : (
							<span class="cp-hint"> (from the text)</span>
						)}
					</span>
				)}
			</div>
			</details>
			<div class="cp-quick-add-footer">
				<button type="submit" class="mod-cta" disabled={model.saving}>
					Add task ⏎
				</button>
			</div>
		</form>
	);
}
