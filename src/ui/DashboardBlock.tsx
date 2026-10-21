import { useMemo, useRef } from "preact/hooks";
import type { ViewGroup } from "../app/views";
import type { ListEntry, QueryContext } from "../domain/queries";
import { plural } from "../domain/text";
import type { ID } from "../domain/types";
import type { DbData } from "../persistence/schema";
import { type IconHost, IconButton } from "./common";
import type { UiHost } from "./host";
import { ICON } from "./icons";
import { TaskList } from "./TaskList";
import type { BlockRowOps } from "./TaskRow";
import { useLingeringShown } from "./useLingering";

// The body of a `logwell` code block. A header (the filters as chips, the task count, an "Open in Logwell"
// button) over either a message or the app's own task list in block mode: the same rows, with no selection, no
// menu and no drag. The Obsidian layer (src/obsidian/dashboardBlock.ts) runs the query and draws this again after
// each change; rows are memoized, so only the rows whose task changed render.

export const NO_DATABASE_TEXT = "Open a Logwell database to see tasks.";
export const NO_TASKS_TEXT = "No tasks found.";

/** The scrolling box of the rows: a windowed list (above VIRTUAL_THRESHOLD rows) draws only the rows near its viewport. */
const BODY_SCROLLER = ".cp-block-body";

/** No Completed group: a row held after it was completed stays among the open rows instead of moving into one. */
const NO_COMPLETED = { entries: [], open: false, onToggle: () => undefined, resetKey: "block" };

interface BlockMessageBody {
	kind: "message";
	/** `error` draws in the error style (a filter problem); `info` in the plain one (no database). */
	tone: "error" | "info";
	/** One line per problem. */
	lines: string[];
}

interface BlockTasksBody {
	kind: "tasks";
	host: UiHost;
	state: DbData;
	ctx: QueryContext;
	/** The matcher's rows, in list order; may be empty ("No tasks found."). */
	entries: ListEntry[];
	/** Show each row's list name; false when the block is already filtered to one list. */
	showList: boolean;
	/** Opens a task in the app. One function for the life of the block, so memoized rows stay equal. */
	onOpenTask: (id: ID) => void;
	/** The rows' completion handler. One object for the life of the block. */
	row: BlockRowOps;
	/** The window of the block's element, whose timers hold a completed row for its check animation. Default: this window. */
	win?: Window;
}

export type BlockBody = BlockMessageBody | BlockTasksBody;

interface DashboardBlockProps {
	/** Draws the header icon; available without a database session. */
	icons: IconHost;
	/** The filters as text (`describeBlockFilters`). */
	chips: string[];
	body: BlockBody;
	onOpenApp: () => void;
}

/** The count in the header: the matcher's rows, a subtask under its parent counting as part of it. */
function countText(body: BlockBody): string {
	if (body.kind !== "tasks") return "";
	const n = body.entries.filter((e) => e.depth === 0).length;
	return plural(n, "task");
}

export function DashboardBlock(props: DashboardBlockProps) {
	const { body } = props;
	return (
		<>
			<div class="cp-block-head">
				<span class="cp-block-filters">
					{props.chips.map((chip) => (
						<span class="cp-block-chip" key={chip}>
							{chip}
						</span>
					))}
				</span>
				<span class="cp-block-count">{countText(body)}</span>
				<IconButton host={props.icons} icon={ICON.openNote} label="Open in Logwell" cls="cp-block-open" onClick={props.onOpenApp} />
			</div>
			{body.kind === "message" ? <Message tone={body.tone} lines={body.lines} /> : <TasksBody {...body} />}
		</>
	);
}

function Message(props: { tone: "error" | "info"; lines: string[] }) {
	return (
		<div class={`cp-block-msg${props.tone === "error" ? " is-error" : ""}`}>
			{props.lines.map((line, i) => (
				<div class="cp-block-msg-line" key={`${i}:${line}`}>
					{line}
				</div>
			))}
		</div>
	);
}

/**
 * The rows the block shows: the matcher's, plus the task rows whose status changed a moment ago (completed in an open
 * block, reopened in a completed one), held where they were so the check animation plays (the app's lists do the
 * same). They leave when the hold ends. `held` never holds a task that `entries` lists (`useLingeringShown` releases
 * it), so a held row is never drawn twice. A row of a done occurrence is never held: it leaves at once.
 */
function withHeld(entries: ListEntry[], last: readonly ListEntry[], held: ReadonlySet<ID>, tasks: DbData["tasks"]): ListEntry[] {
	if (held.size === 0) return entries;
	const out = entries.slice();
	last.forEach((entry, i) => {
		if (entry.occurrence !== null || !held.has(entry.task.id)) return;
		const task = tasks.get(entry.task.id) ?? entry.task;
		out.splice(Math.min(i, out.length), 0, task === entry.task ? entry : { ...entry, task });
	});
	return out;
}

function TasksBody(props: BlockTasksBody) {
	const held = useLingeringShown(props.entries, props.state.tasks, props.win);
	const shown = useRef<ListEntry[]>([]);
	const entries = withHeld(props.entries, shown.current, held, props.state.tasks);
	shown.current = entries;
	const groups = useMemo<ViewGroup[]>(() => [{ key: "block", date: null, entries }], [entries]);
	if (entries.length === 0) return <Message tone="info" lines={[NO_TASKS_TEXT]} />;
	return (
		<div class="cp-block-body">
			<TaskList
				host={props.host}
				state={props.state}
				groups={groups}
				ctx={props.ctx}
				selectedId={null}
				showCategory={props.showList}
				emptyText={NO_TASKS_TEXT}
				label="Tasks"
				onSelect={props.onOpenTask}
				virtualize
				scroller={BODY_SCROLLER}
				completed={NO_COMPLETED}
				block={props.row}
			/>
		</div>
	);
}
