import type { ComponentChildren } from "preact";
import type { AllDayEntry, TimedSegment } from "../../domain/calendar";
import { dateSpecDisplayLocal } from "../../domain/time";
import type { ID, TagColor, Task } from "../../domain/types";
import { Icon, hueClass } from "../common";
import type { UiHost } from "../host";
import { fmtDay, fmtMin } from "./format";

// One calendar entry: a real <button>. Its accessible name is visually hidden text, so the
// button needs no aria-label (and Obsidian shows no tooltip); the visible text is aria-hidden.

type CalendarEntry = AllDayEntry | TimedSegment;

/** Entries are told apart by `kind`; a timed segment has none. */
export function isAllDay(e: CalendarEntry): e is AllDayEntry {
	return "kind" in e;
}

interface EntryView {
	key: string;
	task: Task;
	/** "title, Thu Oct 8, 19:00–19:45, overdue" */
	name: string;
	/** Start time for timed entries ("19:00"). */
	time: string | null;
	/** "19:00–19:45", the visible second line of a block. */
	range: string | null;
	classes: string[];
	noDuration: boolean;
	deadline: boolean;
	/** An occurrence of a repeating task (drawn with the repeat icon, never draggable). */
	repeat: boolean;
	/** Which occurrence this is; null for a task that does not repeat. */
	occurrence: Occurrence;
}

/** Which occurrence of a repeating task an entry is; null for a task that does not repeat. */
type Occurrence = AllDayEntry["occurrence"];

const done = (task: Task, occurrence: Occurrence) => (occurrence === null ? task.status === "completed" : occurrence === "done");

function stateClasses(task: Task, occurrence: Occurrence, past: boolean, missed: boolean): string[] {
	const out: string[] = [];
	// Current solid, future faded with a dashed edge, done struck through like a completed task.
	// A missed occurrence (an overdue series' later past date) is faded and dashed like a future one, with the overdue tint.
	if (occurrence === "future" || occurrence === "missed") out.push("is-future");
	if (occurrence === "missed") out.push("is-past");
	if (occurrence === "skipped") out.push("is-skipped");
	if (occurrence !== null) out.push("is-repeat");
	if (done(task, occurrence)) out.push("is-completed");
	else if (occurrence !== "future" && occurrence !== "skipped" && occurrence !== "missed") {
		if (past) out.push("is-past");
		if (missed) out.push("is-missed");
	}
	return out;
}

/** The words an occurrence adds to an entry's accessible name. */
function occurrenceWords(occurrence: Occurrence): string[] {
	if (occurrence === null) return [];
	return ["repeats", ...(occurrence === "future" ? ["future occurrence"] : occurrence === "missed" ? ["missed occurrence"] : occurrence === "skipped" ? ["skipped"] : [])];
}
export function describeAllDay(e: AllDayEntry, zone: string): EntryView {
	const { task } = e;
	const occurrence = e.occurrence;
	const parts = [task.title, fmtDay(e.date)];
	let past = false;
	let missed = false;
	if (e.kind === "date") {
		past = e.past;
		parts.push("all day");
		if (past && !done(task, occurrence) && occurrence !== "future" && occurrence !== "missed") parts.push("overdue");
	} else {
		missed = e.missed;
		const local = task.deadline === null ? null : dateSpecDisplayLocal(task.deadline, zone);
		parts.push(local === null ? "deadline" : `deadline ${local.slice(11)}`);
		if (missed && !done(task, occurrence)) parts.push("missed deadline");
	}
	parts.push(...occurrenceWords(occurrence));
	if (done(task, occurrence)) parts.push("completed");
	return {
		key: `${e.kind}-${task.id}-${e.date}`,
		task,
		name: parts.join(", "),
		time: null,
		range: null,
		classes: [e.kind === "date" ? "is-allday" : "is-deadline", ...stateClasses(task, occurrence, past, missed)],
		noDuration: false,
		deadline: e.kind === "deadline",
		repeat: occurrence !== null,
		occurrence,
	};
}

export function describeTimed(seg: TimedSegment): EntryView {
	const { task } = seg;
	const occurrence = seg.occurrence;
	const start = fmtMin(seg.startMin);
	// endLocal is the real end of the whole block in the display zone (elapsed time, so a DST day is
	// right); wall-clock arithmetic on startMin would be an hour off across a transition.
	const range = seg.noDuration ? null : `${start}–${seg.endLocal}`;
	const parts = [task.title, fmtDay(seg.date), range ?? start];
	if (seg.noDuration) parts.push("no duration");
	if (seg.continued) parts.push("continued");
	if (seg.past && !done(task, occurrence) && occurrence !== "future" && occurrence !== "missed") parts.push("overdue");
	parts.push(...occurrenceWords(occurrence));
	if (done(task, occurrence)) parts.push("completed");
	return {
		key: `timed-${task.id}-${seg.date}-${seg.startMin}`,
		task,
		name: parts.join(", "),
		time: start,
		range,
		classes: ["is-block", ...(seg.noDuration ? ["is-noduration"] : []), ...stateClasses(task, occurrence, seg.past, false)],
		noDuration: seg.noDuration,
		deadline: false,
		repeat: occurrence !== null,
		occurrence,
	};
}

export function describeEntry(e: CalendarEntry, zone: string): EntryView {
	return isAllDay(e) ? describeAllDay(e, zone) : describeTimed(e);
}

type Vars = Record<`--${string}`, string>;

export function EntryButton(props: {
	view: EntryView;
	listColor: TagColor | null | undefined;
	selected: boolean;
	extraClass?: string;
	style?: Vars;
	onSelect: (id: ID) => void;
	/** Mouse and pen press on the entry: starts a move. Deadline flags pass nothing. */
	onDragStart?: (e: PointerEvent, el: HTMLElement) => void;
	/** The bottom-edge resize handle; decorative, not focusable. */
	onResizeStart?: (e: PointerEvent, el: HTMLElement) => void;
	/** This task is being dragged: the original is dimmed. */
	dragging?: boolean;
	children: ComponentChildren;
}) {
	const { view } = props;
	const open = () => props.onSelect(view.task.id);
	return (
		<button
			type="button"
			class={`cp-cal-entry ${hueClass(props.listColor)} ${view.classes.join(" ")}${props.selected ? " is-selected" : ""}${props.dragging === true ? " is-dragging" : ""}${props.extraClass === undefined ? "" : ` ${props.extraClass}`}`}
			data-task-id={view.task.id}
			style={props.style}
			onClick={open}
			onPointerDown={
				props.onDragStart === undefined
					? undefined
					: (e) => props.onDragStart?.(e, e.currentTarget)
			}
			onKeyDown={(e) => {
				// Enter and Space open the details even where the browser would not click (and
				// before Obsidian's own handlers can swallow the key).
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					open();
				}
			}}
		>
			<span class="cp-sr-only">{view.name}</span>
			<span class="cp-cal-entry-body" aria-hidden="true">
				{props.children}
			</span>
			{props.onResizeStart !== undefined && (
				<span
					class="cp-cal-resize"
					aria-hidden="true"
					onPointerDown={(e) => {
						// The handle resizes; the block must not also start a move.
						e.stopPropagation();
						props.onResizeStart?.(e, e.currentTarget);
					}}
				/>
			)}
		</button>
	);
}

/**
 * The selected task's entry: of a series only the current occurrence (the later and earlier dates are the same task
 * but not what the details pane is about, and highlighting them all would mark a whole column of the week).
 */
export function isSelectedEntry(view: EntryView, selectedId: ID | null): boolean {
	return view.task.id === selectedId && (view.occurrence === null || view.occurrence === "current");
}

/** The repeat icon before the title of an occurrence; nothing for a task that does not repeat. */
export function RepeatMark({ host, view }: { host: UiHost; view: EntryView }) {
	return view.repeat ? <Icon host={host} icon="repeat" cls="cp-cal-repeat" /> : null;
}
