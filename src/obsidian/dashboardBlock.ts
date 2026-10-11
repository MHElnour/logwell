import { MarkdownRenderChild, type MarkdownPostProcessorContext, type Plugin, setIcon } from "obsidian";
import { h, render } from "preact";
import type { CheckpointApp } from "../app/App";
import type { CheckpointSettings } from "../app/settings";
import { blockOpenView } from "../app/blockView";
import type { Change } from "../app/tx";
import type { TaskView } from "../app/views";
import { type BlockMatcher, compileBlockQuery, runBlockQuery } from "../domain/blockQuery";
import type { ListEntry } from "../domain/queries";
import { type SubtaskCount, subtaskCountsFor } from "../domain/tasks";
import type { ID, Task } from "../domain/types";
import { type BlockParse, describeBlockFilters, parseBlockQuery } from "../parsing/blockQuery";
import { accentClass } from "../ui/accent";
import { completeBlockTask } from "../ui/blockActions";
import { type BlockBody, DashboardBlock, NO_DATABASE_TEXT } from "../ui/DashboardBlock";
import type { UiHost } from "../ui/host";
import { sameEntry } from "../ui/rowMemo";
import type { BlockRowOps } from "../ui/TaskRow";

// The `logwell` code block. A block is a MarkdownRenderChild: Obsidian creates it for each block in a note
// (reading view, Live Preview, a callout, an embed, a hover preview) and unloads it when the block goes away. It
// parses its source once, draws with Preact, and redraws after the app's data changes:
//
//  - One subscription for all blocks (BlockHub): the store's change event, and the plugin's session event for a
//    database that opens, closes or is replaced. It is made when the first block loads and dropped with the last.
//  - One interval (TICK_MS) while a block is loaded, so a day that rolls over redraws "due: today" or "scheduled: today" with no change.
//    It only asks each block whether the day, the zone or the week changed; nothing else moves on a tick.
//  - A change that cannot alter a block is skipped: a habit; a task change that no filter of the block accepts, before
//    or after, and that is neither a shown task, nor its parent, nor its subtask. The rest redraw after REFRESH_MS,
//    one redraw per burst. A block's own checkbox redraws at once. A redraw that finds the same rows draws nothing.
//  - A block that is not shown (a collapsed callout, a background tab) does not draw: it is marked dirty and draws
//    when its IntersectionObserver reports it again. Without an observer, or outside the document for good (a print
//    or export render), nothing would ever report it, so it draws anyway.
//  - Everything uses the element's own window (`el.win`), so a block in a pop-out window works there.
//  - When the plugin unloads, every live block drops its tree and its subscriptions and says Logwell is not running.

export const BLOCK_LANGUAGE = "logwell";

/** How far outside the viewport a waiting block is drawn. */
const OBSERVER_MARGIN = "300px 0px";

/** How long a burst of changes is gathered before the block draws once. */
export const REFRESH_MS = 300;

/** How often the blocks check whether the day changed. */
export const TICK_MS = 60_000;

/** How long a block that is outside the document waits to be attached before it draws anyway (a print or export render). */
export const DETACHED_DRAW_MS = 500;

/** Shown in a block that outlived the plugin (disabled while the note was open). */
export const NOT_RUNNING_TEXT = "Logwell is not running.";

/** The collections a block reads besides the tasks: a change to one of them can alter any block. */
const READ_COLLECTIONS: ReadonlySet<Change["c"]> = new Set(["categories", "sections", "tags", "occurrenceRecords", "focusSessions"]);

/** The open database as a block sees it: the app, and the host its rows call (one per session). */
export interface BlockSession {
	readonly app: CheckpointApp;
	readonly host: UiHost;
}

/** What the plugin gives the blocks. */
export interface BlockEnv {
	/** The open database, or null. The same object for as long as the session lives. */
	session(): BlockSession | null;
	/** Hears every session that opens, closes or is replaced, and a settings change; returns the unsubscribe function. */
	onSession(listener: () => void): () => void;
	settings(): CheckpointSettings;
	/** Opens a task in the app (selected in its list). */
	openTask(id: ID): void;
	/** Opens the app on `view`, or just opens it for null. */
	openView(view: TaskView | null): void;
}

/** The part of the render context a block uses. */
type BlockContext = Pick<MarkdownPostProcessorContext, "sourcePath" | "addChild">;

/** What the shown rows of the last draw say about the changes that can alter them. */
interface SeenList {
	entries: ListEntry[];
	/** The subtask counts of the shown parents. */
	counts: ReadonlyMap<ID, SubtaskCount>;
	/** Every shown task. */
	ids: ReadonlySet<ID>;
	/** The parents of the shown subtasks (a subtask drawn alone names its parent). */
	parents: ReadonlySet<ID>;
}

/** What the last draw showed, to tell whether a later change could alter the result. */
interface Seen {
	className: string;
	/** A parse error: the filters are text, so no data can change the draw. */
	fixed: boolean;
	/** The session the draw read; null when it read none (no database, a parse error). */
	session: BlockSession | null;
	sourcePath: string;
	today: string;
	zone: string;
	weekStart: string;
	upcomingDays: number;
	/** The data the draw is known to match: the state at the draw, and after each skipped change. */
	state: CheckpointApp["store"]["state"] | null;
	/** The rows, or null for a message. */
	list: SeenList | null;
	/** For a message that read the data: whether a task change can alter it (a query that threw; a missing list cannot). */
	tasksMatter: boolean;
	/** The filters as a test for one task; built when a task change first needs it. */
	matcher: BlockMatcher | null;
}

type SeenState = NonNullable<Seen["state"]>;

/** Whether the collections a row reads besides its task (lists, sections, tags, occurrences, focus totals) are the same objects. */
function sameLists(a: SeenState, b: SeenState): boolean {
	return a.categories === b.categories && a.sections === b.sections && a.tags === b.tags && a.occurrenceRecords === b.occurrenceRecords && a.focusSessions === b.focusSessions;
}

/** Whether the collections a block reads (tasks and those of `sameLists`) are the same objects. */
function sameData(a: SeenState, b: SeenState): boolean {
	return a === b || (a.tasks === b.tasks && sameLists(a, b));
}

/** The same rows, with the same subtask counts. */
function sameRows(a: SeenList, b: SeenList): boolean {
	if (a.entries.length !== b.entries.length || a.counts.size !== b.counts.size) return false;
	for (let i = 0; i < a.entries.length; i++) if (!sameEntry(a.entries[i]!, b.entries[i]!)) return false;
	for (const [id, count] of a.counts) {
		const other = b.counts.get(id);
		if (other === undefined || other.total !== count.total || other.done !== count.done) return false;
	}
	return true;
}

/**
 * The one subscription of all the blocks. It listens to the store of the open session and to the plugin's session
 * event, and runs one interval, only while at least one block is loaded.
 */
class BlockHub {
	private readonly blocks = new Set<DashboardBlockChild>();
	private offSession: (() => void) | null = null;
	private offStore: (() => void) | null = null;
	private bound: BlockSession | null = null;
	/** The day check; it runs on the window of the block that started it. */
	private ticker: { owner: DashboardBlockChild; win: Window; handle: number } | null = null;

	constructor(private readonly env: BlockEnv) {}

	add(block: DashboardBlockChild): void {
		this.blocks.add(block);
		if (this.blocks.size === 1) {
			this.offSession = this.env.onSession(() => {
				this.bind();
				this.notify();
			});
			this.bind();
		}
		if (this.ticker === null) this.startTicker(block);
	}

	remove(block: DashboardBlockChild): void {
		this.blocks.delete(block);
		if (this.ticker?.owner === block) this.stopTicker();
		if (this.blocks.size > 0) {
			// The window that held the interval may be the one that closed: another block's window takes it over.
			if (this.ticker === null) this.startTicker(this.blocks.values().next().value!);
			return;
		}
		this.unsubscribe();
	}

	/** The plugin unloads: every live block stops, and nothing stays subscribed. */
	dispose(): void {
		const blocks = [...this.blocks];
		this.blocks.clear();
		this.stopTicker();
		this.unsubscribe();
		for (const block of blocks) block.stop();
	}

	private unsubscribe(): void {
		this.offSession?.();
		this.offSession = null;
		this.offStore?.();
		this.offStore = null;
		this.bound = null;
	}

	private startTicker(owner: DashboardBlockChild): void {
		const win = owner.containerEl.win;
		this.ticker = { owner, win, handle: win.setInterval(() => this.notify(), TICK_MS) };
	}

	private stopTicker(): void {
		if (this.ticker === null) return;
		this.ticker.win.clearInterval(this.ticker.handle);
		this.ticker = null;
	}

	/** Follows the open session: its store is the one listened to. */
	private bind(): void {
		const session = this.env.session();
		if (session === this.bound && (session === null || this.offStore !== null)) return;
		this.offStore?.();
		this.bound = session;
		this.offStore = session === null ? null : session.app.store.bus.on("changed", (event) => this.notify(event.changes));
	}

	/** `changes` is what a command wrote; without it (a tick, a settings event, a reload) a block checks everything it reads. */
	private notify(changes?: readonly Change[]): void {
		for (const block of [...this.blocks]) block.notify(changes);
	}
}

/** The header is drawn with or without a database, so its icon does not come from a session's host. */
const ICONS: Pick<UiHost, "setIcon"> = { setIcon: (el, icon) => setIcon(el, icon) };

class DashboardBlockChild extends MarkdownRenderChild {
	private readonly parsed: BlockParse;
	private readonly chips: string[];
	private root: HTMLElement | null = null;
	private observer: IntersectionObserver | null = null;
	private timer: { win: Window; handle: number } | null = null;
	/** Waits for a block outside the document to be attached; draws it anyway when it is not (print, export). */
	private detachedTimer: { win: Window; handle: number } | null = null;
	/** The block changed (or never drew) while it could not draw; it draws when it is shown. */
	private dirty = true;
	private seen: Seen | null = null;
	private unloaded = false;
	private stopped = false;

	/** One object for the life of the block, so memoized rows stay equal across redraws. */
	private readonly row: BlockRowOps = {
		complete: async (task) => {
			const session = this.env.session();
			if (session === null) return;
			await completeBlockTask(session.host, task);
			// The block's own write: no waiting for the delay.
			if (!this.unloaded && !this.stopped) this.refreshNow();
		},
	};
	private readonly openTask = (id: ID): void => this.env.openTask(id);
	private readonly openApp = (): void => {
		const session = this.env.session();
		this.env.openView(session === null ? null : blockOpenView(this.parsed.filters, session.app.store.state));
	};

	constructor(
		containerEl: HTMLElement,
		source: string,
		private readonly ctx: BlockContext,
		private readonly env: BlockEnv,
		private readonly hub: BlockHub,
	) {
		super(containerEl);
		// Once per instance: Obsidian runs the processor again, with a fresh element, whenever the source changes.
		this.parsed = parseBlockQuery(source);
		this.chips = describeBlockFilters(this.parsed.filters);
	}

	override onload(): void {
		const root = this.containerEl.createDiv({ cls: this.rootClass() });
		this.root = root;
		this.hub.add(this);
		// The element's own window: a pop-out window has its own IntersectionObserver.
		const win = this.containerEl.win as Window & { IntersectionObserver?: typeof IntersectionObserver };
		const Observer = win.IntersectionObserver;
		if (typeof Observer === "function") {
			// A little before it scrolls into view, so a block that was waiting has its height by the time it shows.
			this.observer = new Observer(
				(entries) => {
					if (this.dirty && entries.some((e) => e.isIntersecting)) this.refreshNow();
				},
				{ rootMargin: OBSERVER_MARGIN },
			);
			this.observer.observe(root);
		}
		// Drawn at once, so the block has its height on the first frame (no jump in Live Preview).
		this.refreshNow();
	}

	override onunload(): void {
		this.unloaded = true;
		this.release();
		if (this.root !== null) {
			render(null, this.root);
			this.root.remove();
			this.root = null;
		}
		this.hub.remove(this);
	}

	/** The plugin unloads while the note is open: the block drops its tree and its timers, and says why. */
	stop(): void {
		if (this.stopped || this.unloaded) return;
		this.stopped = true;
		this.release();
		const root = this.root;
		if (root === null) return;
		render(null, root);
		root.replaceChildren();
		const message = root.createDiv({ cls: "cp-block-msg" });
		message.textContent = NOT_RUNNING_TEXT;
	}

	/** Timers and the observer: nothing of the block stays registered. */
	private release(): void {
		this.disarm();
		this.disarmDetached();
		this.observer?.disconnect();
		this.observer = null;
	}

	/** The store or the session changed, or a tick came: draw again after the delay, unless nothing the block reads changed. */
	notify(changes?: readonly Change[]): void {
		if (this.unloaded || this.stopped) return;
		// A redraw is on its way and will read everything.
		if (this.timer !== null || !this.mayHaveChanged(changes)) return;
		if (this.mustWait()) {
			this.waitForShow();
			return;
		}
		this.arm();
	}

	/** Draws now, or marks the block dirty when it is not shown. */
	private refreshNow(): void {
		this.disarm();
		if (this.unloaded || this.stopped || this.root === null) return;
		if (this.mustWait()) {
			this.waitForShow();
			return;
		}
		this.draw(this.root);
	}

	/**
	 * Whether the block has to wait to be shown: not when nothing would tell it (no observer). A block outside the
	 * document waits only a moment for its attachment (reading view attaches a section after its blocks load); one
	 * that is never attached (a print or export render) draws then, since no observer reports it.
	 */
	private mustWait(): boolean {
		const root = this.root;
		return root !== null && this.observer !== null && !(root.isConnected && root.isShown());
	}

	/** Marks the block dirty; an unattached block also gets its moment to be attached. */
	private waitForShow(): void {
		this.dirty = true;
		const root = this.root;
		if (root === null || this.detachedTimer !== null || root.isConnected) return;
		const win = this.containerEl.win;
		this.detachedTimer = {
			win,
			handle: win.setTimeout(() => {
				this.detachedTimer = null;
				const r = this.root;
				if (this.unloaded || this.stopped || r === null || !this.dirty) return;
				// Still outside the document: a print or an export render. Attached by now: the observer decides.
				if (!r.isConnected) this.draw(r);
				else this.refreshNow();
			}, DETACHED_DRAW_MS),
		};
	}

	private arm(): void {
		const win = this.containerEl.win;
		this.timer = {
			win,
			handle: win.setTimeout(() => {
				this.timer = null;
				this.refreshNow();
			}, REFRESH_MS),
		};
	}

	private disarm(): void {
		if (this.timer === null) return;
		this.timer.win.clearTimeout(this.timer.handle);
		this.timer = null;
	}

	private disarmDetached(): void {
		if (this.detachedTimer === null) return;
		this.detachedTimer.win.clearTimeout(this.detachedTimer.handle);
		this.detachedTimer = null;
	}

	/** False when the last draw already shows the data, the day and the settings the app has now. */
	private mayHaveChanged(changes: readonly Change[] | undefined): boolean {
		const seen = this.seen;
		if (seen === null || seen.className !== this.rootClass()) return true;
		if (seen.fixed) return false;
		const session = this.env.session();
		if (session !== seen.session) return true;
		// A message without a database stays until one opens.
		if (session === null || seen.state === null) return false;
		const ctx = session.app.queryContext();
		if (ctx.today !== seen.today || ctx.zone !== seen.zone || ctx.weekStart !== seen.weekStart || ctx.upcomingDays !== seen.upcomingDays) return true;
		if (seen.sourcePath !== this.ctx.sourcePath) return true;
		const state = session.app.store.state;
		if (sameData(seen.state, state)) return false;
		if (changes === undefined) return true;
		let tasks = false;
		for (const change of changes) {
			if (change.c === "tasks") tasks = true;
			else if (READ_COLLECTIONS.has(change.c)) return true;
		}
		if (!tasks) return false;
		if (this.taskChangesMatter(seen, changes, session)) return true;
		// The shown rows stay what they are: the draw now matches this state too. A dirty block has missed an
		// earlier change, so its draw does not match this state and `seen` must stay with the last draw.
		if (!this.dirty) seen.state = state;
		return false;
	}

	/**
	 * Whether a change of tasks could alter the draw: a task whose record before or after passes the filters, a shown
	 * task, the parent of a shown subtask, or a subtask of a shown task (its count) may enter, leave or change a row.
	 */
	private taskChangesMatter(seen: Seen, changes: readonly Change[], session: BlockSession): boolean {
		const list = seen.list;
		if (list === null) return seen.tasksMatter;
		if (seen.matcher === null) {
			seen.matcher = compileBlockQuery(this.parsed.filters, session.app.store.state, session.app.queryContext(), this.ctx.sourcePath);
		}
		const matcher = seen.matcher;
		if (matcher.kind !== "ok") return true;
		for (const change of changes) {
			if (change.c !== "tasks") continue;
			for (const record of [change.before, change.after] as (Task | undefined)[]) {
				if (record === undefined) continue;
				if (list.ids.has(record.id) || list.parents.has(record.id)) return true;
				if (record.parentId !== null && list.ids.has(record.parentId)) return true;
				if (matcher.matches(record)) return true;
			}
		}
		return false;
	}

	private rootClass(): string {
		return `cp-block checkpoint-view cp-theme ${accentClass(this.env.settings())}`;
	}

	private draw(root: HTMLElement): void {
		this.dirty = false;
		this.disarmDetached();
		const className = this.rootClass();
		root.className = className;
		const previous = this.seen;
		const body = this.body(className);
		if (this.sameDraw(previous, this.seen)) return;
		render(h(DashboardBlock, { icons: ICONS, chips: this.chips, body, onOpenApp: this.openApp }), root);
	}

	/** Whether drawing `next` over `previous` would change nothing: the same rows, counts, lists, tags, day and class. */
	private sameDraw(previous: Seen | null, next: Seen | null): boolean {
		if (previous === null || next === null || previous.list === null || next.list === null) return false;
		if (previous.className !== next.className || previous.session !== next.session) return false;
		if (previous.today !== next.today || previous.zone !== next.zone) return false;
		const a = previous.state;
		const b = next.state;
		if (a === null || b === null) return false;
		// What a row reads besides its task: its list, its tags, its focus totals, its occurrences. Rows may read only
		// categories, tags and focus totals from `state`; anything else a row reads must be added to this comparison.
		if (!sameLists(a, b)) return false;
		return sameRows(previous.list, next.list);
	}

	private body(className: string): BlockBody {
		const { errors, filters } = this.parsed;
		const base = { className, sourcePath: this.ctx.sourcePath, today: "", zone: "", weekStart: "", upcomingDays: 0, state: null, list: null, tasksMatter: false, matcher: null };
		if (errors.length > 0) {
			this.seen = { ...base, fixed: true, session: null };
			return { kind: "message", tone: "error", lines: errors };
		}
		const session = this.env.session();
		if (session === null) {
			this.seen = { ...base, fixed: false, session: null };
			return { kind: "message", tone: "info", lines: [NO_DATABASE_TEXT] };
		}
		// Read again on every draw: the day, the zone and the week start can change between two of them.
		const ctx = session.app.queryContext();
		const state = session.app.store.state;
		const read = { ...base, fixed: false, session, today: ctx.today, zone: ctx.zone, weekStart: ctx.weekStart, upcomingDays: ctx.upcomingDays, state };
		let result: ReturnType<typeof runBlockQuery>;
		try {
			result = runBlockQuery(filters, state, ctx, this.ctx.sourcePath);
		} catch (err) {
			// Tried again after any change it may read.
			this.seen = { ...read, tasksMatter: true };
			return { kind: "message", tone: "error", lines: [err instanceof Error ? err.message : String(err)] };
		}
		if (result.kind === "error") {
			// A name that does not resolve changes with the lists, sections and tags, not with the tasks.
			this.seen = read;
			return { kind: "message", tone: "error", lines: [result.message] };
		}
		const ids = new Set<ID>();
		const parents = new Set<ID>();
		const shownParents = new Set<ID>();
		for (const { task } of result.entries) {
			ids.add(task.id);
			if (task.parentId === null) shownParents.add(task.id);
			else parents.add(task.parentId);
		}
		const counts = subtaskCountsFor(shownParents, state.tasks.values());
		this.seen = { ...read, list: { entries: result.entries, counts, ids, parents } };
		return {
			kind: "tasks",
			host: session.host,
			state,
			ctx,
			entries: result.entries,
			showList: filters.list === undefined,
			onOpenTask: this.openTask,
			row: this.row,
			counts,
			win: this.containerEl.win,
		};
	}
}

/** Registers the `logwell` code block processor. Blocks that are still on screen when the plugin unloads are stopped. */
export function registerDashboardBlock(plugin: Plugin, env: BlockEnv): void {
	const hub = new BlockHub(env);
	plugin.register(() => hub.dispose());
	plugin.registerMarkdownCodeBlockProcessor(BLOCK_LANGUAGE, (source, el, ctx) => {
		ctx.addChild(new DashboardBlockChild(el, source, ctx, env, hub));
	});
}
