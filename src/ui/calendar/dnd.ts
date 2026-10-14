import { useRef, useState } from "preact/hooks";
import { EDIT_TASK_LABEL, type TaskPatch } from "../../app/TaskService";
import {
	type CalendarContext,
	DEFAULT_DURATION_MIN,
	type TimedSegment,
	moveSameMoment,
	moveTimed,
	moveToDate,
	resizedDuration,
	slotRange,
	slotSpec,
} from "../../domain/calendar";
import { DAY_MIN, daysBetween, fmtMin, wallDateOf, wallMinutesOf } from "../../domain/time";
import type { DateSpec, ID, LocalDate, Task } from "../../domain/types";
import { writeTask } from "../actions";
import { type DragPoint, beginPointerDrag, createAutoScroller, hitTest, overElement } from "../drag";
import { useDragController } from "../useDragController";
import type { UiHost } from "../host";
import { HOUR_PX } from "./geometry";

// Calendar drag and drop. The pointer is turned into a target (a day column, an
// all-day cell or a month cell) by hit testing the rendered elements; the value to store comes from
// the pure helpers in src/domain/calendar.ts. One drop is one TaskService.update call.



type DragSource =
	/** A timed block (either half of a split one): moves the whole task. */
	| { kind: "timed"; task: Task; seg: TimedSegment }
	/** The bottom-edge handle of a timed block. */
	| { kind: "resize"; task: Task; seg: TimedSegment }
	/** A date-only entry of the week's all-day row. */
	| { kind: "allday"; task: Task }
	/** Any non-deadline entry of the month grid; it keeps its time of day. */
	| { kind: "month"; task: Task }
	/** A row of the unscheduled drawer. */
	| { kind: "drawer"; task: Task };

/** What the views draw while a drag is active. */
export type Ghost =
	| { kind: "slot"; taskId: ID; colDate: LocalDate; date: LocalDate; startMin: number; lenMin: number; label: string; resize: boolean }
	| { kind: "cell"; taskId: ID; date: LocalDate; area: "allday" | "month" }
	| { kind: "refused"; taskId: ID; date: LocalDate; area: "grid" | "allday" };

interface Resolved {
	ghost: Ghost | null;
	patch: TaskPatch | null;
	message: string;
}

const NONE: Resolved = { ghost: null, patch: null, message: "" };

export interface CalDnd {
	ghost: Ghost | null;
	/** The task being dragged, for the dimmed original. */
	draggingId: ID | null;
	start: (e: PointerEvent, el: HTMLElement, src: DragSource) => void;
}

/** The floating panels (the Unscheduled drawer and the details pane, below 1200 px) cover the grid: dropping on one is refused. */
const OVERLAY_SELECTOR = ".cp-cal-unscheduled, .cp-details-pane";

const scrollerOf = (root: HTMLElement) => root.querySelector<HTMLElement>(".cp-cal-scroller");

/** What scrolls under a drag: the week grid, or the month grid when its rows outgrow the view. */
const scrollables = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".cp-cal-scroller, .cp-cal-month-grid")];

const dateOf = (el: Element): LocalDate => el.getAttribute("data-date") ?? "";

function colAtX(cols: HTMLElement[], x: number): HTMLElement | null {
	for (const c of cols) {
		const r = c.getBoundingClientRect();
		if (x >= r.left && x < r.right) return c;
	}
	return null;
}

export function useCalDnd(host: UiHost, ctx: CalendarContext, getRoot: () => HTMLElement | null): CalDnd {
	const [ghost, setGhost] = useState<Ghost | null>(null);
	const [draggingId, setDraggingId] = useState<ID | null>(null);
	const ctrl = useDragController();
	const lastKey = useRef("null");
	const live = useRef({ host, ctx, getRoot });
	live.current = { host, ctx, getRoot };

	const clear = () => {
		ctrl.current = null;
		lastKey.current = "null";
		setGhost(null);
		setDraggingId(null);
	};

	const resolve = (src: DragSource, p: DragPoint, origin: DragPoint, scrollTop0: number): Resolved => {
		const { ctx: c, getRoot: root } = live.current;
		const el = root();
		if (el === null) return NONE;
		// The grid may scroll during the drag; the block moves with the content, not the pointer alone.
		const scrollDelta = (scrollerOf(el)?.scrollTop ?? 0) - scrollTop0;
		return resolveDrop(src, p, origin, el, c.zone, scrollDelta);
	};

	const start = (e: PointerEvent, el: HTMLElement, src: DragSource) => {
		if (ctrl.current?.active) return;
		// No single-occurrence move, and a series does not move or resize as a block either.
		if (src.task.recurrence !== null) return;
		const id = src.task.id;
		let scrollTop0 = 0;
		let last: { p: DragPoint; origin: DragPoint } | null = null;
		let scroller: ReturnType<typeof createAutoScroller> | null = null;
		let scrollRoot: HTMLElement | null = null;
		// The grid scrolled under a still pointer: the ghost and the drop target move with the content.
		const onScroll = () => {
			if (last !== null) move(last.p, last.origin);
		};
		const endScroll = () => {
			scroller?.stop();
			scroller = null;
			scrollRoot?.removeEventListener("scroll", onScroll, true);
			scrollRoot = null;
		};
		const move = (p: DragPoint, origin: DragPoint) => {
			last = { p, origin };
			scroller?.update(p);
			const r = resolve(src, p, origin, scrollTop0);
			const key = JSON.stringify(r.ghost);
			if (key === lastKey.current) return;
			lastKey.current = key;
			setGhost(r.ghost);
		};
		ctrl.current = beginPointerDrag(e, el, {
			onStart: () => {
				const root = live.current.getRoot();
				scrollTop0 = root === null ? 0 : (scrollerOf(root)?.scrollTop ?? 0);
				if (root !== null) {
					scrollRoot = root;
					scroller = createAutoScroller(() => {
						const r = live.current.getRoot();
						return r === null ? [] : scrollables(r);
					});
					// Scroll does not bubble, so listen in the capture phase.
					root.addEventListener("scroll", onScroll, true);
				}
				setDraggingId(id);
			},
			onMove: move,
			onDrop: (p, origin) => {
				const { host: h } = live.current;
				// The task as it is now (a sync or another device may have changed it during the drag). One deleted, or
				// one that started repeating, does not move: a series never drags.
				const task = h.app.store.state.tasks.get(id);
				const r = task === undefined || task.recurrence !== null ? NONE : resolve({ ...src, task }, p, origin, scrollTop0);
				endScroll();
				clear();
				if (task === undefined || r.patch === null) return;
				// Only a real change gets an Undo notice: for a drop that resolves to the current value
				// (a DST gap) nothing is written, and Undo would revert an unrelated earlier command.
				const mark = h.app.store.undoMark();
				void writeTask(h, task, r.patch).then((outcome) => {
					if (outcome === "changed") h.notifyUndo(r.message, EDIT_TASK_LABEL, mark);
				});
			},
			onCancel: () => {
				endScroll();
				clear();
			},
		});
	};

	return { ghost, draggingId, start };
}

/** Where the pointer is, and what dropping there would store. Pure with respect to state; reads layout from the DOM. */
function resolveDrop(
	src: DragSource,
	p: DragPoint,
	origin: DragPoint,
	root: HTMLElement,
	zone: string,
	/** How far the grid scrolled since the drag began (px). */
	scrollDelta = 0,
): Resolved {
	if (overElement(root, p, OVERLAY_SELECTOR)) return NONE;
	const all = <T extends HTMLElement>(sel: string) => [...root.querySelectorAll<T>(sel)];
	const task = src.task;
	const title = task.title;

	/** The day column under the pointer, only where the grid is visible (not behind the sticky header, inside the scroller). */
	const gridCol = (): HTMLElement | null => {
		const scroller = root.querySelector<HTMLElement>(".cp-cal-scroller");
		const sticky = root.querySelector<HTMLElement>(".cp-cal-sticky");
		if (scroller === null) return null;
		const s = scroller.getBoundingClientRect();
		const top = sticky === null ? s.top : sticky.getBoundingClientRect().bottom;
		if (p.x < s.left || p.x >= s.right || p.y < top || p.y >= s.bottom) return null;
		return colAtX(all(".cp-cal-daycol"), p.x);
	};
	const alldayCell = () => hitTest(p, all(".cp-cal-allday-cell"));
	const monthCell = () => hitTest(p, all(".cp-cal-cell"));

	const cellResult = (date: LocalDate, area: "allday" | "month", next: DateSpec, message: string): Resolved => ({
		ghost: { kind: "cell", taskId: task.id, date, area },
		patch: moveSameMoment(task.scheduled, next, zone) ? null : { scheduled: next },
		message,
	});
	const refused = (date: LocalDate, area: "grid" | "allday"): Resolved => ({
		ghost: { kind: "refused", taskId: task.id, date, area },
		patch: null,
		message: "",
	});

	switch (src.kind) {
		case "timed": {
			const sched = task.scheduled;
			if (sched === null || sched.kind !== "datetime") return NONE;
			const ad = alldayCell();
			// A timed block cannot become an all-day entry.
			if (ad !== null) return refused(dateOf(ad), "allday");
			// Only where the grid is visible: not over the toolbar, the day headers or outside the scroller.
			const col = gridCol();
			if (col === null) return NONE;
			const dayDelta = daysBetween(src.seg.date, dateOf(col));
			const next = moveTimed(sched, zone, dayDelta, ((p.y - origin.y + scrollDelta) / HOUR_PX) * 60);
			if (next === null || next.kind !== "datetime") return NONE;
			const startMin = wallMinutesOf(next.local);
			// The continued half was grabbed, so the ghost shows the part that runs past
			// midnight, in the column under the pointer. The block's start is the day before.
			const spill = startMin + src.seg.durationMin - DAY_MIN;
			const onPointer = src.seg.continued && spill > 0;
			return {
				ghost: {
					kind: "slot",
					taskId: task.id,
					colDate: dateOf(col),
					date: onPointer ? dateOf(col) : wallDateOf(next.local),
					startMin: onPointer ? 0 : startMin,
					lenMin: onPointer ? Math.min(spill, DAY_MIN) : Math.min(src.seg.durationMin, DAY_MIN - startMin),
					label: slotRange(next.local, src.seg.noDuration ? null : src.seg.durationMin, zone),
					resize: false,
				},
				patch: moveSameMoment(sched, next, zone) ? null : { scheduled: next },
				message: `Moved "${title}".`,
			};
		}
		case "resize": {
			const sched = task.scheduled;
			if (sched === null || sched.kind !== "datetime") return NONE;
			const col = all(".cp-cal-daycol").find((c) => dateOf(c) === src.seg.date);
			if (col === undefined) return NONE;
			const rawEnd = ((p.y - col.getBoundingClientRect().top) / HOUR_PX) * 60;
			const duration = resizedDuration(src.seg.startMin, rawEnd);
			const local = `${src.seg.date}T${fmtMin(src.seg.startMin)}`;
			return {
				ghost: {
					kind: "slot",
					taskId: task.id,
					colDate: src.seg.date,
					date: src.seg.date,
					startMin: src.seg.startMin,
					lenMin: duration,
					label: slotRange(local, duration, zone),
					resize: true,
				},
				patch: duration === task.plannedDurationMin ? null : { plannedDurationMin: duration },
				message: `Changed the length of "${title}".`,
			};
		}
		case "allday": {
			const sched = task.scheduled;
			if (sched === null || sched.kind !== "date") return NONE;
			const ad = alldayCell();
			if (ad !== null) return cellResult(dateOf(ad), "allday", moveToDate(sched, dateOf(ad), zone), `Moved "${title}".`);
			const col = gridCol();
			return col === null ? NONE : refused(dateOf(col), "grid");
		}
		case "month": {
			const sched = task.scheduled;
			if (sched === null) return NONE;
			const c = monthCell();
			return c === null ? NONE : cellResult(dateOf(c), "month", moveToDate(sched, dateOf(c), zone), `Moved "${title}".`);
		}
		case "drawer": {
			const message = `Scheduled "${title}".`;
			const ad = alldayCell();
			if (ad !== null) return cellResult(dateOf(ad), "allday", { kind: "date", date: dateOf(ad) }, message);
			const mc = monthCell();
			if (mc !== null) return cellResult(dateOf(mc), "month", { kind: "date", date: dateOf(mc) }, message);
			const col = gridCol();
			if (col === null) return NONE;
			const next = slotSpec(dateOf(col), ((p.y - col.getBoundingClientRect().top) / HOUR_PX) * 60, zone);
			if (next.kind !== "datetime") return NONE;
			const startMin = wallMinutesOf(next.local);
			const duration = task.plannedDurationMin !== null && task.plannedDurationMin > 0 ? task.plannedDurationMin : null;
			return {
				ghost: {
					kind: "slot",
					taskId: task.id,
					colDate: dateOf(col),
					date: dateOf(col),
					startMin,
					lenMin: Math.min(duration ?? DEFAULT_DURATION_MIN, DAY_MIN - startMin),
					label: slotRange(next.local, duration, zone),
					resize: false,
				},
				patch: { scheduled: next },
				message,
			};
		}
	}
}
