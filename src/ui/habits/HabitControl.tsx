import { useRef, useState } from "preact/hooks";
import type { HabitIndex } from "../../domain/habits";
import { isScheduled, progressOn, versionAt } from "../../domain/habits";
import type { Habit, LocalDate } from "../../domain/types";
import { Icon } from "../common";
import type { UiHost } from "../host";
import { ICON } from "../icons";
import { checkedInText, runWrite } from "./actions";
import { amountFieldLabel, amountPlaceholder, amountText, notScheduledText, parseAmount, plusLabel, quickAmount } from "./format";

// The control of one habit on one day. One component for the page rows, the Today block
// ("row") and the Today column ("card"), so all three write the same way. A write on a past day carries
// that date.

interface HabitControlProps {
	host: UiHost;
	habit: Habit;
	index: HabitIndex;
	date: LocalDate;
	today: LocalDate;
	/** "card" is the Today column: a quantity habit shows one "+n" button instead of the number field. */
	variant?: "row" | "card";
}

export function HabitControl(props: HabitControlProps) {
	const { host, habit, index, date, today } = props;
	const version = versionAt(habit, date);
	// Before the habit's first day there is nothing to check in.
	if (version === null) return null;
	if (!isScheduled(habit, date)) return <span class="cp-habit-rest">{notScheduledText(date, today)}</span>;
	const progress = progressOn(habit, index, date);
	const value = progress?.value ?? 0;
	const target = progress?.target ?? version.goal.target;
	const met = progress?.met === true;
	const unit = version.goal.unit;
	switch (version.goal.type) {
		case "binary":
			return <CheckButton host={host} habit={habit} date={date} on={(index.byDate(habit.id).get(date)?.length ?? 0) > 0} />;
		case "count":
			return (
				<>
					<span class="cp-habit-count">
						{amountText(value)}
						<small>{` / ${amountText(target)}`}</small>
					</span>
					{met && <Met host={host} />}
					<AddButton host={host} habit={habit} date={date} amount={1} label={plusLabel(habit.name)} />
				</>
			);
		case "quantity": {
			const quick = props.variant === "card" ? quickAmount(habit, index, version) : 0;
			return props.variant === "card" ? (
				<>
					{met && <Met host={host} />}
					<AddButton host={host} habit={habit} date={date} amount={quick} label={`Add ${amountText(quick)} ${unit ?? ""}`.trim()} />
				</>
			) : (
				<>
					{met && <Met host={host} />}
					<AmountField host={host} habit={habit} date={date} unit={unit ?? ""} target={target} />
				</>
			);
		}
	}
}

/** The green check mark next to the count of a goal that is met. */
function Met(props: { host: UiHost }) {
	return (
		<span class="cp-habit-met">
			<span aria-hidden="true">
				<Icon host={props.host} icon={ICON.check} />
			</span>
			<span class="cp-sr-only">Goal met</span>
		</span>
	);
}

/**
 * Done or not: a round check button. A click says what it wants (the opposite of what the last click
 * wanted, else of what is stored), so two quick clicks never both check in: the second one removes.
 */
function CheckButton(props: { host: UiHost; habit: Habit; date: LocalDate; on: boolean }) {
	const { host, habit, date } = props;
	const stored = useRef(props.on);
	stored.current = props.on;
	const wanted = useRef<boolean | null>(null);
	const click = () => {
		const next = !(wanted.current ?? stored.current);
		wanted.current = next;
		void runWrite(host, () => host.app.habits.toggle(habit.id, date, next), next ? checkedInText(habit) : "Removed the check-in.").finally(() => {
			if (wanted.current === next) wanted.current = null;
		});
	};
	return (
		<button
			type="button"
			class={`cp-habit-check${props.on ? " is-on" : ""}`}
			aria-pressed={props.on}
			aria-label={`Mark ${habit.name} as done`}
			onClick={click}
		>
			<Icon host={host} icon={ICON.check} />
		</button>
	);
}

/** "+1" (a count) or "+n" (a quantity card): one tap, one check-in. */
function AddButton(props: { host: UiHost; habit: Habit; date: LocalDate; amount: number; label: string }) {
	const { host, habit, date, amount } = props;
	return (
		<button
			type="button"
			class="cp-habit-plus"
			aria-label={props.label}
			onClick={() => void runWrite(host, () => host.app.habits.add(habit.id, date, amount), checkedInText(habit))}
		>
			{`+${amountText(amount)}`}
		</button>
	);
}

/** An amount: a number field, the unit and Add. Enter or Add submits; a wrong amount is told, not written. */
function AmountField(props: { host: UiHost; habit: Habit; date: LocalDate; unit: string; target: number }) {
	const { host, habit, date } = props;
	const [text, setText] = useState("");
	const field = useRef<HTMLInputElement>(null);
	// A second Enter or click while the first write is pending is ignored (like CheckButton's wanted ref).
	const busy = useRef(false);
	const submit = () => {
		if (busy.current) return;
		// Read the field itself: a keystroke the page has not re-rendered for yet still counts.
		const amount = parseAmount(field.current?.value ?? "");
		if (amount === null) {
			host.notify("Enter an amount above 0.");
			return;
		}
		busy.current = true;
		void runWrite(host, () => host.app.habits.add(habit.id, date, amount), checkedInText(habit))
			.then((ok) => {
				if (ok) setText("");
			})
			.finally(() => {
				busy.current = false;
			});
	};
	return (
		<span class="cp-habit-amount">
			<input
				ref={field}
				type="text"
				inputmode="decimal"
				autocomplete="off"
				placeholder={amountPlaceholder(props.target)}
				aria-label={amountFieldLabel(props.unit === "" ? null : props.unit)}
				value={text}
				onInput={(e) => setText(e.currentTarget.value)}
				onKeyDown={(e) => {
					if (e.key !== "Enter") return;
					e.preventDefault();
					submit();
				}}
			/>
			<span class="cp-habit-unit">{props.unit}</span>
			<button type="button" class="cp-habit-add" aria-label={`Add to ${habit.name}`} onClick={submit}>
				Add
			</button>
		</span>
	);
}
