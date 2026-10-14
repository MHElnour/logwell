import { useRef, useState } from "preact/hooks";
import type { ViewGroup } from "../app/views";
import type { ListEntry } from "../domain/queries";
import { DST_WARNING_TEXT, EDIT_TASK_LABEL, MOVE_TASK_LABEL } from "../app/TaskService";
import type { ID } from "../domain/types";
import { writeTaskResult } from "./actions";
import { notifyReanchored } from "./repeatActions";
import { type DragController, type DragPoint, beginPointerDrag, createAutoScroller } from "./drag";
import { groupPatch, groupTitle } from "./groupDrop";
import { pressedItem, useDragController } from "./useDragController";
import type { UiHost } from "./host";
import { virtualHandle } from "./virtual";

// Dragging a list row up or down to reorder it. The gesture is the shared src/ui/drag.ts; this
// file finds the sibling blocks (from the data; in a windowed list a row that is not drawn is
// placed by its offset), draws the drop line and, on release, makes one
// TaskService.place call with the new order of the row's siblings in its group. Under a sort other than
// Default a row only changes group, through `update`; a same-group drop does nothing.

interface ListReorder {
	/** The pointerdown handler for the list (event delegation: one per list). */
	onPointerDown: (e: PointerEvent) => void;
	/** The row being dragged. State, so a re-render keeps its dimmed class. */
	draggingId: ID | null;
}

/** One sibling and the rows that move with it: a top-level row takes its nested subtasks along. */
interface Block {
	id: ID;
	rowIds: ID[];
}

/** The blocks of one group with the given parent and depth, in order. */
function blocksIn(g: ViewGroup, parentId: ID | null, depth: number): Block[] {
	const blocks: Block[] = [];
	g.entries.forEach((e, i) => {
		if (e.task.parentId !== parentId || e.depth !== depth) return;
		const rowIds = [e.task.id];
		// Only a top-level row owns the subtasks nested right after it.
		if (e.task.parentId === null) {
			for (let j = i + 1; j < g.entries.length && g.entries[j]!.depth === 1; j++) rowIds.push(g.entries[j]!.task.id);
		}
		blocks.push({ id: e.task.id, rowIds });
	});
	return blocks;
}

/** The siblings of `id` in its group, in order: same parent, same depth. Null when `id` is not in a group. */
function siblingBlocks(groups: readonly ViewGroup[], id: ID): { entry: ListEntry; blocks: Block[]; group: ViewGroup } | null {
	for (const g of groups) {
		const at = g.entries.find((e) => e.task.id === id);
		if (at === undefined) continue;
		return { entry: at, blocks: blocksIn(g, at.task.parentId, at.depth), group: g };
	}
	return null;
}

interface Drop {
	/** The siblings' ids after the drop (in the target section). */
	order: ID[];
	/** Where to draw the line, relative to the viewport. */
	line: { top: number; left: number; width: number };
	/** Set when the row lands in another group (a section, list, priority or date); this is the target. */
	moved?: ViewGroup;
}

export function useListReorder(deps: {
	enabled: boolean;
	/** The Default sort: a row can be placed among its siblings. Otherwise it can only change group. */
	manual: boolean;
	host: UiHost;
	/** The current groups; read at pointerdown, so a render in between is fine. */
	groups: () => readonly ViewGroup[];
	list: () => HTMLElement | null;
}): ListReorder {
	const depsRef = useRef(deps);
	depsRef.current = deps;
	const controller = useDragController();
	const [draggingId, setDraggingId] = useState<ID | null>(null);

	const onPointerDown = (e: PointerEvent) => {
		const { enabled, manual, host, groups, list } = depsRef.current;
		const row = pressedItem(e, ".cp-task-row");
		const listEl = list();
		if (!enabled || row === null || listEl === null) return;
		const id = row.dataset.taskId;
		// A Completed history row shares its series task's id: it is not the task's own row, so it never drags.
		if (id === undefined || row.dataset.occurrence !== undefined || controller.current?.active) return;
		const found = siblingBlocks(groups(), id);
		if (found === null || found.entry.task.status !== "open") return;
		// A top-level row can also go to another group that takes drops (a section, list, priority or
		// date); a subtask stays in its parent's group, so it only reorders.
		const snapshot = groups();
		const originGroup = found.group;
		const crossable = found.entry.task.parentId === null && snapshot.some((g) => g.drop !== undefined && g !== originGroup);
		// Alone in its group with nowhere else to go, or not in an open group (the Completed group): a press stays a click.
		if ((found.blocks.length < 2 || !manual) && !crossable) return;
		const { blocks } = found;
		const title = found.entry.task.title;
		const before = blocks.map((b) => b.id);

		type Box = { top: number; bottom: number; left: number; width: number };
		/**
		 * The vertical extent of each block of a group on screen. A drawn row reports its own box; in a windowed
		 * list a row that is not drawn gets its box from its offset in the listbox. Null for a block
		 * that has no rows on screen at all (a collapsed section). Read once per pointer position.
		 */
		const extents = (g: ViewGroup, bs: readonly Block[]): Map<ID, Box | null> => {
			const groupEl = [...listEl.querySelectorAll<HTMLElement>("[data-group-key]")].find((el) => el.dataset.groupKey === g.key);
			const drawn = new Map<ID, DOMRect>();
			// Only the group's own rows. A Completed history row shares its series task's id; in a windowed
			// list the open row may not be drawn, and the history row's box must not stand in for it.
			for (const r of (groupEl ?? listEl).querySelectorAll<HTMLElement>(".cp-task-row")) {
				const rid = r.dataset.taskId;
				if (rid !== undefined && r.dataset.occurrence === undefined && !drawn.has(rid)) drawn.set(rid, r.getBoundingClientRect());
			}
			const geometry = virtualHandle(groupEl?.querySelector(":scope > .cp-task-rows"))?.geometry();
			const rowBox = (rid: ID): Box | null => drawn.get(rid) ?? geometry?.rectOf(rid) ?? null;
			const out = new Map<ID, Box | null>();
			for (const b of bs) {
				const first = rowBox(b.rowIds[0]!);
				const last = rowBox(b.rowIds[b.rowIds.length - 1]!);
				out.set(b.id, first === null || last === null ? null : { top: first.top, bottom: last.bottom, left: first.left, width: first.width });
			}
			return out;
		};

		let line: HTMLElement | null = null;
		let mine: DragController | null = null;
		let last: DragPoint | null = null;
		const main = listEl.closest<HTMLElement>(".cp-main");
		const scroller = createAutoScroller(() => (main === null ? [] : [main]));

		const locate = (p: DragPoint): Drop | null => {
			const box = listEl.getBoundingClientRect();
			// Off the list sideways (the sidebar, the details pane): not a place to drop.
			if (p.x < box.left || p.x >= box.right) return null;
			// The group under the pointer. Off every group, a row that cannot cross stays in its own.
			let target = originGroup;
			const targetEl =
				[...listEl.querySelectorAll<HTMLElement>("[data-group-key]")].find((el) => {
					const r = el.getBoundingClientRect();
					return p.y >= r.top && p.y < r.bottom;
				}) ?? null;
			const hit = snapshot.find((g) => g.key === targetEl?.dataset.groupKey);
			if (hit === undefined) {
				if (crossable) return null;
			} else if (hit !== originGroup) {
				// Another group: only one that takes drops, and only for a row that can cross (a tag group never does).
				if (!crossable || hit.drop === undefined) return null;
				target = hit;
			}
			const isMove = target !== originGroup;
			// Not the Default sort: a same-group drop has no place to go and draws no line.
			if (!isMove && !manual) return null;
			const targetBlocks = isMove ? blocksIn(target, null, 0) : blocks;
			const others = targetBlocks.filter((b) => b.id !== id);
			const boxes = extents(target, others);
			const extent = (b: Block) => boxes.get(b.id) ?? null;
			let index = 0;
			for (const b of others) {
				const ext = extent(b);
				// A collapsed section draws no rows: the row goes to its end.
				if (ext === null || p.y > (ext.top + ext.bottom) / 2) index++;
			}
			const order = others.map((b) => b.id);
			order.splice(index, 0, id);
			const next = others[index];
			const prev = others[index - 1];
			let at = next !== undefined ? extent(next) : prev !== undefined ? extent(prev) : null;
			let top = next !== undefined ? at?.top : at?.bottom;
			if (at === null || top === undefined) {
				// An empty or collapsed section: the line goes under its heading.
				const head = targetEl?.querySelector<HTMLElement>(".cp-group-heading")?.getBoundingClientRect();
				if (head === undefined) return null;
				at = { top: head.bottom, bottom: head.bottom, left: head.left, width: head.width };
				top = head.bottom;
			}
			return { order, line: { top, left: at.left, width: at.width }, ...(isMove ? { moved: target } : {}) };
		};
		const draw = (drop: Drop | null) => {
			if (line === null) return;
			if (drop === null) {
				line.hidden = true;
				return;
			}
			const box = listEl.getBoundingClientRect();
			line.hidden = false;
			line.style.top = `${drop.line.top - box.top}px`;
			line.style.left = `${drop.line.left - box.left}px`;
			line.style.width = `${drop.line.width}px`;
		};
		const onScroll = () => {
			if (last !== null) draw(locate(last));
		};
		const clear = () => {
			scroller.stop();
			main?.removeEventListener("scroll", onScroll);
			line?.remove();
			line = null;
			listEl.classList.remove("is-reordering");
			if (controller.current === mine) controller.current = null;
			setDraggingId(null);
		};

		mine = beginPointerDrag(e, row, {
			onStart() {
				line = listEl.createDiv({ cls: "cp-reorder-line" });
				line.setAttribute("aria-hidden", "true");
				listEl.classList.add("is-reordering");
				main?.addEventListener("scroll", onScroll);
				setDraggingId(id);
			},
			onMove(p) {
				last = p;
				draw(locate(p));
				scroller.update(p);
			},
			onDrop(p) {
				const drop = locate(p);
				clear();
				if (drop === null || (drop.moved === undefined && drop.order.every((x, i) => x === before[i]))) return;
				const target = drop.moved;
				const task = host.app.store.state.tasks.get(id);
				if (task === undefined) return;
				const ctx = host.app.queryContext();
				// A series moves by its current occurrence (it has no `scheduled`), keeping the time.
				const schedule = task.recurrence === null ? undefined : host.app.effectiveSchedule(task);
				const mark = host.app.store.undoMark();
				if (!manual) {
					// Only a group change gets here (`locate` refuses the rest): one `update` with the group's patch.
					const change = target?.drop === undefined ? {} : groupPatch(task, target.drop, ctx, schedule);
					if (target === undefined || Object.keys(change).length === 0) return;
					void writeTaskResult(host, task, change).then((r) => {
						if (r.outcome !== "changed") return;
						// `update` runs as "Edit task"; a series' date change re-anchors it and says so instead.
						if (r.reanchored !== null) notifyReanchored(host, task, r.reanchored, EDIT_TASK_LABEL, mark);
						else host.notifyUndo(`Moved "${title}" to ${groupTitle(target, ctx)}.`, EDIT_TASK_LABEL, mark);
					});
					return;
				}
				// A move between groups is one write: the group's change (section, list, priority or date) and the
				// position together. A drop that changes nothing is left alone.
				const patch = target?.drop === undefined ? {} : groupPatch(task, target.drop, ctx, schedule);
				void host.app.tasks
					.place(id, drop.order, patch)
					.then(({ changed, warnings, reanchored }) => {
						for (const w of warnings) host.notify(DST_WARNING_TEXT[w]);
						if (changed !== true) return;
						if (reanchored !== undefined) notifyReanchored(host, task, reanchored, MOVE_TASK_LABEL, mark);
						else host.notifyUndo(target === undefined ? `Moved "${title}".` : `Moved "${title}" to ${groupTitle(target, ctx)}.`, MOVE_TASK_LABEL, mark);
					})
					.catch((err) => host.error(err));
			},
			onCancel: clear,
		});
		if (mine !== null) controller.current = mine;
	};

	return { onPointerDown, draggingId };
}
