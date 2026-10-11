import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ViewGroup } from "../app/views";
import type { ListEntry, QueryContext, TaskSort } from "../domain/queries";
import type { SubtaskCount } from "../domain/tasks";
import type { ID } from "../domain/types";
import type { DbData } from "../persistence/schema";
import { CompletedGroup } from "./CompletedGroup";
import { AddSectionField } from "./AddSectionField";
import { EmptyState, Icon, IconButton, SrOnly } from "./common";
import { entryKey, formatDate } from "./format";
import { useSubtaskCounts, useUniqueId } from "./hooks";
import type { UiHost } from "./host";
import { ICON } from "./icons";
import { sectionMenu } from "./sectionActions";
import { type BlockRowOps, taskRowFor } from "./TaskRow";
import { useListReorder } from "./useListReorder";
import { VIRTUAL_THRESHOLD } from "./virtual";
import { onWindowedListKeyDown } from "./virtualKeys";
import { VirtualRows } from "./VirtualRows";

// Task list with keyboard navigation: arrow keys
// move between rows, Enter opens details, Cmd/Ctrl+Enter toggles completion,
// the context-menu key or Shift+F10 opens the row menu. The row is TaskRow.

export { TOGGLE_COMPLETE_EVENT } from "./rowItem";

/** A row's height before one was measured (styles.css `--cp-row-h`). */
const ROW_ESTIMATE_PX = 52;
const NO_PINS: readonly string[] = [];

/** The key a section's collapsed state is kept under: the list and the section ("none" = No section). */
export function sectionKey(categoryId: ID, sectionId: ID | null): string {
	return `section:${categoryId}:${sectionId ?? "none"}`;
}

/**
 * A list that mixes open and completed tasks (search) keeps the completed ones
 * in a collapsed group at the end. A list of only completed tasks stays plain.
 */
function splitCompleted(groups: ViewGroup[]): { groups: ViewGroup[]; completed: ListEntry[] } {
	const all = groups.flatMap((g) => g.entries);
	if (!all.some((e) => e.task.status === "open") || !all.some((e) => e.task.status === "completed")) {
		return { groups, completed: [] };
	}
	return {
		groups: groups.map((g) => ({ ...g, entries: g.entries.filter((e) => e.task.status !== "completed") })).filter((g) => g.entries.length > 0),
		completed: all.filter((e) => e.task.status === "completed"),
	};
}

export function TaskList(props: {
	host: UiHost;
	state: DbData;
	groups: ViewGroup[];
	ctx: QueryContext;
	selectedId: ID | null;
	showCategory: boolean;
	emptyText: string;
	label: string;
	onSelect: (id: ID) => void;
	/**
	 * A task view's Completed group. Omit it where a list mixes open and completed tasks on
	 * its own (search), which keeps its own collapsed group at the end.
	 */
	completed?: { entries: ListEntry[]; open: boolean; onToggle: () => void; resetKey: string };
	/**
	 * The view's sort. Rows drag to another group under any sort, but reorder inside a group only
	 * while it is "manual" (Default). Omit it where there is no manual order (search, Completed): then no row drags.
	 */
	sort?: TaskSort;
	/** A read-only database (an older device) never reorders. */
	readOnly?: boolean;
	/**
	 * Set in Inbox and lists. The groups carry `section`; the headings show once the list has a section.
	 * `collapsed` and `onToggle` are keyed by `sectionKey`. `addRequest` opens the name field when it changes.
	 */
	sections?: { categoryId: ID; hasAny: boolean; collapsed: (key: string) => boolean; onToggle: (key: string) => void; addRequest: number };
	/**
	 * With more than VIRTUAL_THRESHOLD rows, draw only the rows near the viewport of `scroller`: the Tasks section, the
	 * task block and the calendar's Unscheduled drawer turn it on. Search leaves it off.
	 */
	virtualize?: boolean;
	/** The scrolling ancestor the windowed rows follow (`closest()` selector). Default: the Tasks section's `.cp-main`. */
	scroller?: string;
	/** Set in a dashboard block, whose rows have no menu and complete through this handler. */
	block?: BlockRowOps;
	/**
	 * The subtask counts of the rows' parents, for a block that knows its few parents. Without it the list counts
	 * the subtasks of every task in the database.
	 */
	subtaskCounts?: ReadonlyMap<ID, SubtaskCount>;
}) {
	const tasks = props.state.tasks;
	const listRef = useRef<HTMLDivElement>(null);
	const groupsRef = useRef(props.groups);
	groupsRef.current = props.groups;
	const reorder = useListReorder({
		enabled: props.sort !== undefined && props.readOnly !== true,
		manual: props.sort === "manual",
		host: props.host,
		groups: () => groupsRef.current,
		list: () => listRef.current,
	});
	// The "Add section" request: a change of the counter opens the field (not the value at mount). A layout
	// effect, so the field is in the DOM one render after the menu pick, not one frame later.
	// The field belongs to the list it was opened in, so it does not follow the user into another list and
	// no effect has to close it (an effect that ran late would undo an early open).
	const listId = props.sections?.categoryId ?? null;
	const [addingIn, setAddingIn] = useState<ID | null>(null);
	const adding = addingIn !== null && addingIn === listId;
	const seenRequest = useRef(props.sections?.addRequest ?? 0);
	const request = props.sections?.addRequest ?? 0;
	useLayoutEffect(() => {
		if (request !== seenRequest.current) {
			seenRequest.current = request;
			if (props.readOnly !== true) setAddingIn(listId);
		}
	}, [request]);
	const given = props.subtaskCounts;
	const ownCounts = useSubtaskCounts(props.host, tasks, given === undefined);
	const counts = given ?? ownCounts;
	const [showDone, setShowDone] = useState(false);
	const id = useUniqueId("cp-list");
	const labelId = `${id}-label`;
	const completedId = `${id}-completed`;
	// The Completed split reads every entry: redone only when the groups change, not on every render (selecting a row).
	const hasCompletedProp = props.completed !== undefined;
	const split = useMemo(() => (hasCompletedProp ? { groups: props.groups, completed: [] } : splitCompleted(props.groups)), [props.groups, hasCompletedProp]);
	const total = props.groups.reduce((n, g) => n + g.entries.length, 0);
	const explicit = props.completed !== undefined && props.completed.entries.length > 0 ? props.completed : null;
	// The section headings show under "Group by: Section" once the list has a section.
	const sectioned = props.sections !== undefined && props.sections.hasAny && props.groups.some((g) => g.section !== undefined);
	if (total === 0 && explicit === null && !sectioned && !adding) return <EmptyState host={props.host} icon={ICON.completed} text={props.emptyText} />;
	const { groups, completed } = split;
	const shownGroups = groups.filter((g) => g.entries.length > 0 || (sectioned && g.section !== undefined));
	const isCollapsed = (g: ViewGroup) => sectioned && g.section !== undefined && props.sections !== undefined && props.sections.collapsed(sectionKey(props.sections.categoryId, g.section.id));
	// The rows the listboxes would draw (the paged Completed group draws at most a page at a time).
	const drawable = shownGroups.reduce((n, g) => n + (isCollapsed(g) ? 0 : g.entries.length), 0) + (showDone ? completed.length : 0);
	const windowed = props.virtualize === true && drawable > VIRTUAL_THRESHOLD;
	const pinned = reorder.draggingId === null ? NO_PINS : [reorder.draggingId];
	/**
	 * A listbox of option rows only: headings and their buttons sit outside it (a listbox owns only options). Windowed,
	 * each row tells assistive technology the listbox's size and its position, since not every row is in the DOM.
	 */
	const rows = (entries: ListEntry[], labelledBy: string) =>
		entries.length > 0 && (
			<VirtualRows
				enabled={windowed}
				items={entries}
				keyOf={entryKey}
				renderItem={windowed ? (entry: ListEntry, i: number) => row(entry, { size: entries.length, pos: i + 1 }) : plainRow}
				box={{ class: "cp-task-rows", role: "listbox", "aria-labelledby": labelledBy }}
				scroller={props.scroller ?? ".cp-main"}
				estimate={ROW_ESTIMATE_PX}
				pinned={pinned}
			/>
		);
	const row = (entry: ListEntry, set?: { size: number; pos: number }) =>
		taskRowFor(props, counts, entry, props.showCategory, {
			dragging: reorder.draggingId === entry.task.id,
			setSize: set?.size,
			posInSet: set?.pos,
			block: props.block,
		});
	/** A row without a set position; also what `map` calls, so its index is never taken for one. */
	const plainRow = (entry: ListEntry) => row(entry);
	/** A section's heading: the Today-style heading with a collapse chevron, the count, "+" and ⋯. */
	const renderSection = (g: ViewGroup, headingId: string, sections: NonNullable<typeof props.sections>) => {
		const section = g.section!;
		const key = sectionKey(sections.categoryId, section.id);
		const collapsed = sections.collapsed(key);
		const stored = section.id === null ? undefined : props.state.sections.get(section.id);
		return (
			<div
				class={`cp-task-group cp-section-group${collapsed ? " is-collapsed" : ""}`}
				key={`s:${section.id ?? "none"}`}
				role="group"
				aria-labelledby={headingId}
				data-section-id={section.id ?? "none"}
				data-group-key={g.key}
			>
				<div class="cp-group-heading cp-section-heading">
					<button type="button" class="cp-section-toggle" aria-expanded={!collapsed} onClick={() => sections.onToggle(key)}>
						<Icon host={props.host} icon={collapsed ? "chevron-right" : "chevron-down"} />
						<span id={headingId}>{section.name}</span>
						<span class="cp-group-count">{g.entries.length}</span>
					</button>
					<IconButton
						host={props.host}
						icon="plus"
						label={`Add task to ${section.name}`}
						cls="cp-section-add"
						disabled={props.readOnly === true}
						onClick={() => props.host.quickAdd({ categoryId: sections.categoryId, sectionId: section.id })}
					/>
					{stored !== undefined && (
						<IconButton
							host={props.host}
							icon="more-horizontal"
							label={`Options for section ${section.name}`}
							cls="cp-section-menu"
							disabled={props.readOnly === true}
							onClick={(e) => {
								const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
								props.host.showMenu({ x: r.left, y: r.bottom }, sectionMenu(props.host, stored));
							}}
						/>
					)}
				</div>
				{!collapsed && rows(g.entries, headingId)}
			</div>
		);
	};
	return (
		<>
			{total === 0 && <EmptyState host={props.host} icon={ICON.completed} text={props.emptyText} />}
			<SrOnly id={labelId}>{props.label}</SrOnly>
			{/* The list is a group of groups; each group's rows are their own listbox. Arrow keys still walk every row. */}
			<div
				class="cp-task-list"
				role="group"
				aria-labelledby={labelId}
				ref={listRef}
				onPointerDown={reorder.onPointerDown}
				onKeyDownCapture={windowed ? (e) => onWindowedListKeyDown(e, e.currentTarget) : undefined}
			>
				{shownGroups.map((g, i) => {
					const headingId = `${id}-group-${i}`;
					if (sectioned && g.section !== undefined && props.sections !== undefined) {
						return renderSection(g, headingId, props.sections);
					}
					const headed = g.date !== null || g.label !== undefined;
					// A past date's own heading says "overdue" next to the date; the group is named by both.
					const pastDate = g.date !== null && g.tone === "overdue";
					const nameIds = pastDate ? `${headingId} ${headingId}-overdue` : headingId;
					return (
						<div class="cp-task-group" key={g.key} role="group" aria-labelledby={headed ? nameIds : labelId} data-group-key={g.key}>
							{headed && (
								<div class={`cp-group-heading${g.tone === undefined ? "" : ` is-${g.tone}`}`}>
									<span id={headingId}>{g.label ?? formatDate(g.date!, props.ctx.today)}</span>
									{pastDate && (
										<span class="cp-group-overdue" id={`${headingId}-overdue`}>
											overdue
										</span>
									)}
									<span class="cp-group-count">{g.entries.length}</span>
								</div>
							)}
							{rows(g.entries, headed ? nameIds : labelId)}
						</div>
					);
				})}
				{adding && props.sections !== undefined && (
					<AddSectionField host={props.host} categoryId={props.sections.categoryId} cls="is-list" onClose={() => setAddingIn(null)} />
				)}
				{explicit !== null && (
					<CompletedGroup
						resetKey={explicit.resetKey}
						host={props.host}
						idBase={id}
						entries={explicit.entries}
						open={explicit.open}
						onToggle={explicit.onToggle}
						renderRow={plainRow}
					/>
				)}
				{completed.length > 0 && (
					<div class="cp-task-group cp-completed-group" role="group" aria-labelledby={completedId}>
						<button type="button" class="cp-completed-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
							<Icon host={props.host} icon={showDone ? "chevron-down" : "chevron-right"} />
							<span id={completedId}>Completed</span>
							<span class="cp-completed-count">{completed.length}</span>
						</button>
						{showDone && rows(completed, completedId)}
					</div>
				)}
			</div>
		</>
	);
}
