import type { ComponentChildren, TargetedEvent } from "preact";
import { useRef, useState } from "preact/hooks";
import type { DateSpec, Priority, TagColor } from "../domain/types";
import { specFromInputs, specInputs } from "./format";
import type { UiHost } from "./host";
import { useIcon, useUniqueId } from "./hooks";

/** What an icon needs from the host. A dashboard block draws its header before it has a database session. */
export type IconHost = Pick<UiHost, "setIcon">;

export function Icon({ host, icon, cls, fallback }: { host: IconHost; icon: string; cls?: string; fallback?: string }) {
	const ref = useIcon(host, icon, fallback);
	return <span ref={ref} class={`cp-icon ${cls ?? ""}`} aria-hidden="true" />;
}

/** An empty list: a large faint icon and one short friendly line. */
export function EmptyState(props: { host: UiHost; icon: string; text: string }) {
	return (
		<div class="cp-empty-state">
			<Icon host={props.host} icon={props.icon} cls="cp-empty-icon" />
			<p class="cp-empty-text">{props.text}</p>
		</div>
	);
}

/**
 * A visually hidden label for a container, referenced with aria-labelledby.
 * Containers must not use aria-label: Obsidian shows a hover tooltip for any element that has
 * one. aria-label stays on controls (buttons, inputs) where the tooltip is wanted.
 */
export function SrOnly(props: { id: string; children: ComponentChildren }) {
	return (
		<span id={props.id} class="cp-sr-only">
			{props.children}
		</span>
	);
}

/** Icon buttons always carry an ARIA label (accessibility rule). */
export function IconButton(props: {
	host: IconHost;
	icon: string;
	label: string;
	onClick: (evt: MouseEvent) => void;
	pressed?: boolean;
	cls?: string;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			class={`cp-icon-button clickable-icon ${props.cls ?? ""}`}
			aria-label={props.label}
			aria-pressed={props.pressed}
			disabled={props.disabled}
			onClick={(e) => props.onClick(e)}
		>
			<Icon host={props.host} icon={props.icon} />
		</button>
	);
}

/**
 * A checkbox for task completion, keyboard reachable with a state-specific label.
 *
 * The click cancels the native toggle, so the box shows only the stored status. A browser undoes a
 * canceled toggle after the event is dispatched, and a store update that re-renders in a microtask
 * can run before that. Preact then finds the DOM already equal to the prop and writes nothing, and
 * the undo leaves the box stale. So the box is set from the latest prop once the event
 * is over.
 */
export function TaskCheckbox(props: { done: boolean; title: string; onToggle: () => void; tabIndex?: number; priority?: Priority }) {
	const ref = useRef<HTMLInputElement>(null);
	const doneRef = useRef(props.done);
	doneRef.current = props.done;
	return (
		<input
			ref={ref}
			type="checkbox"
			class={`cp-task-checkbox task-list-item-checkbox${props.priority ? ` cp-pri-${props.priority}` : ""}`}
			checked={props.done}
			tabIndex={props.tabIndex}
			aria-label={props.done ? `Reopen "${props.title}"` : `Complete "${props.title}"`}
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				props.onToggle();
				window.setTimeout(() => {
					if (ref.current !== null) ref.current.checked = doneRef.current;
				}, 0);
			}}
			onKeyDown={(e) => e.stopPropagation()}
		/>
	);
}

/** Date + optional time inputs for a DateSpec in the display zone. */
export function DateSpecField(props: {
	host: UiHost;
	label: string;
	value: DateSpec | null;
	zone: string;
	onChange: (spec: DateSpec | null) => void;
	/** False hides the clear button (a repeating task's date cannot be cleared). */
	clearable?: boolean;
}) {
	const initial = specInputs(props.value, props.zone);
	const key = `${initial.date}|${initial.time}`;
	return <DateSpecInputs key={key} {...props} initialDate={initial.date} initialTime={initial.time} />;
}

function DateSpecInputs(props: {
	host: UiHost;
	label: string;
	zone: string;
	initialDate: string;
	initialTime: string;
	onChange: (spec: DateSpec | null) => void;
	clearable?: boolean;
}) {
	const [date, setDate] = useState(props.initialDate);
	const [time, setTime] = useState(props.initialTime);
	const commit = (d: string, t: string) => {
		if (d === props.initialDate && t === props.initialTime) return;
		props.onChange(specFromInputs(d, t, props.zone));
	};
	const id = useUniqueId(`cp-${props.label.toLowerCase().replace(/\s+/g, "-")}-date`);
	return (
		<div class="cp-field cp-date-field">
			<label for={id}>{props.label}</label>
			<div class="cp-date-inputs">
				<input
					id={id}
					type="date"
					value={date}
					aria-label={`${props.label} date`}
					onChange={(e: TargetedEvent<HTMLInputElement>) => {
						const d = e.currentTarget.value;
						setDate(d);
						const t = d === "" ? "" : time;
						setTime(t);
						commit(d, t);
					}}
				/>
				<input
					type="time"
					value={time}
					disabled={date === ""}
					aria-label={`${props.label} time`}
					onChange={(e: TargetedEvent<HTMLInputElement>) => {
						const t = e.currentTarget.value;
						setTime(t);
						commit(date, t);
					}}
				/>
				{date !== "" && props.clearable !== false && (
					<IconButton
						host={props.host}
						icon="x"
						label={`Clear ${props.label.toLowerCase()}`}
						onClick={() => {
							setDate("");
							setTime("");
							commit("", "");
						}}
					/>
				)}
			</div>
		</div>
	);
}

/** The hue class of a tag or list color (styles.css `.cp-hue-*`); null is the neutral hue. */
export function hueClass(color: TagColor | null | undefined): string {
	return `cp-hue-${color ?? "none"}`;
}
