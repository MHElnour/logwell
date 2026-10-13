import type { ActiveTimer } from "../domain/focus";
import type { ReminderState } from "../domain/habitReminders";
import type {
	TtBatch,
	TtBatchResult,
	TtColumn,
	TtCompletedQuery,
	TtMove,
	TtMoveResult,
	TtProject,
	TtProjectCreate,
	TtProjectData,
	TtTag,
	TtTagCreate,
	TtTask,
	TtTaskCreate,
	TtTaskFilter,
	TtTaskUpdate,
} from "../domain/ticktick/types";
import type { WeekStart } from "../domain/types";

// Ports the app layer needs from the host (Obsidian adapters implement them).

/**
 * Vault access for description notes. Never writes to an existing note, except `replaceText`, which only
 * the TickTick sync calls, for notes it created. Never deletes or renames a note.
 */
export interface NotePort {
	/** Whether a Markdown file exists at the path (resolution is computed at runtime). */
	exists(path: string): boolean;
	/**
	 * Creates a note in `folder` named after `baseName`, probing "Name.md", "Name (2).md", … and creating the folder if
	 * missing. It is empty unless `content` is given. Returns the new path.
	 */
	createNote(folder: string, baseName: string, content?: string): Promise<string>;
	/** The note's last modification time (ms), or null when there is no file at the path. */
	modifiedAt(path: string): number | null;
	/**
	 * Replaces the whole text of a note the TickTick sync created, through `vault.process`, only while it is
	 * still `expected` (compare-and-swap: an edit that landed meanwhile is never overwritten). Resolves whether it
	 * wrote; false also when the file is gone.
	 */
	replaceText(path: string, expected: string, next: string): Promise<boolean>;
	/** Reads note text for a search; the result is never stored. */
	read(path: string): Promise<string | null>;
	/** Markdown files with this basename (for the relink suggestion). */
	findByBasename(basename: string): string[];
}

export interface SettingsPort {
	/** The display zone. */
	zone(): string;
	noteFolder(): string;
	upcomingDays(): number;
	/** The week start a new habit version gets (the "Week starts on" setting). */
	weekStart(): WeekStart;
	/** "HH:mm", the start of Evening (the Evening time setting). */
	eveningTime(): string;
}

/** A note rename or move seen in the vault. */
export interface NoteRename {
	oldPath: string;
	newPath: string;
	isFolder: boolean;
}

/**
 * Renames not yet applied to a database, kept per database (`dbId`)
 * so a reload does not lose them. Device-local: this device saw the events.
 */
export interface RenameQueuePort {
	load(dbId: string): NoteRename[];
	/** An empty list clears the entry. */
	save(dbId: string, renames: readonly NoteRename[]): void;
}

/** Timers for the rename queue's write throttle; tests and hosts may substitute their own. */
export interface RenameTimers {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

/** The default: kept for the lifetime of the plugin only. */
export class MemoryRenameQueue implements RenameQueuePort {
	private readonly queues = new Map<string, NoteRename[]>();

	load(dbId: string): NoteRename[] {
		return (this.queues.get(dbId) ?? []).map((r) => ({ ...r }));
	}

	save(dbId: string, renames: readonly NoteRename[]): void {
		if (renames.length === 0) this.queues.delete(dbId);
		else this.queues.set(dbId, renames.map((r) => ({ ...r })));
	}
}

/** The running timer, device-local and per database. `load` returns whatever is stored. */
export interface ActiveTimerPort {
	load(dbId: string): unknown;
	/** null clears the entry. */
	save(dbId: string, timer: ActiveTimer | null): void;
}

export interface FocusSettingsPort {
	deviceId(): string;
	/** A focus under a minute that ends by Stop or Finish is not saved. */
	discardShortFocus(): boolean;
}

/** Keeps one JSON text per database id for the lifetime of the plugin only; `load` returns what was saved, parsed. */
class MemoryJsonPort<T> {
	private readonly texts = new Map<string, string>();

	load(dbId: string): unknown {
		const text = this.texts.get(dbId);
		return text === undefined ? null : (JSON.parse(text) as unknown);
	}

	save(dbId: string, value: T | null): void {
		if (value === null) this.texts.delete(dbId);
		else this.texts.set(dbId, JSON.stringify(value));
	}
}

/** The default: kept for the lifetime of the plugin only. */
export class MemoryActiveTimer extends MemoryJsonPort<ActiveTimer> implements ActiveTimerPort {}

/** The habit reminder state, device-local and per database. `load` returns whatever is stored. */
export interface ReminderStatePort {
	load(dbId: string): unknown;
	/** null clears the entry. May throw; the reminder host keeps its state in memory and logs it once. */
	save(dbId: string, state: ReminderState | null): void;
}

/** The default: kept for the lifetime of the plugin only. */
export class MemoryReminderState extends MemoryJsonPort<ReminderState> implements ReminderStatePort {}

/**
 * Tasks the TickTick sync created in TickTick but has not linked yet, by list and then by Logwell task: TickTick's id
 * and the field hashes sent, or null when the answer was lost.
 */
export interface TickTickPending {
	v: 1;
	lists: Record<string, Record<string, { ttId: string; base: Record<string, string> } | null>>;
}

/** `TickTickPending`, device-local and per database, so a restart does not lose it. `load` returns whatever is stored. */
export interface TickTickPendingPort {
	load(dbId: string): unknown;
	/** null clears the entry. May throw; the sync then keeps it in memory. */
	save(dbId: string, pending: TickTickPending | null): void;
}

/** The default: kept for the lifetime of the plugin only. */
export class MemoryTickTickPending extends MemoryJsonPort<TickTickPending> implements TickTickPendingPort {}

/**
 * The TickTick API token. Kept in the host's secret storage, never in the database or
 * `data.json`. An empty token reads as none.
 */
export interface TickTickSecretPort {
	get(): string | null;
	set(token: string): void;
	clear(): void;
}

/** The default: kept for the lifetime of the plugin only. */
export class MemoryTickTickSecret implements TickTickSecretPort {
	private token: string | null = null;

	get(): string | null {
		return this.token;
	}

	set(token: string): void {
		this.token = token === "" ? null : token;
	}

	clear(): void {
		this.token = null;
	}
}

/** "Sync with TickTick on this device", device-local and per database. Off until turned on. */
export interface TickTickDevicePort {
	isEnabled(): boolean;
	setEnabled(on: boolean): void;
}

/** The default: kept for the lifetime of the plugin only. */
export class MemoryTickTickDevice implements TickTickDevicePort {
	private on = false;

	isEnabled(): boolean {
		return this.on;
	}

	setEnabled(on: boolean): void {
		this.on = on;
	}
}

/**
 * Why a TickTick call failed.
 * - `unauthorized`: no token, or HTTP 401 or 403.
 * - `rate-limited`: HTTP 429; `retryAfterSec` is the `Retry-After` header when present.
 * - `not-found`: HTTP 404.
 * - `server`: HTTP 5xx.
 * - `network`: no answer.
 * - `bad-response`: an answer that cannot be read, or any other unexpected status.
 */
export type TickTickErrorKind = "unauthorized" | "rate-limited" | "not-found" | "server" | "network" | "bad-response";

/**
 * The only error a `TickTickApi` throws. The message never holds the token, a header or a response body.
 * `maybePartial` is true when a write may have been applied in part or in full although the call failed (an HTTP 500
 * on a batch can be partly applied): the caller re-reads before the next push.
 */
export class TickTickError extends Error {
	readonly kind: TickTickErrorKind;
	readonly status: number | null;
	readonly retryAfterSec: number | null;
	readonly maybePartial: boolean;

	constructor(
		kind: TickTickErrorKind,
		message: string,
		options: { status?: number | null; retryAfterSec?: number | null; maybePartial?: boolean } = {},
	) {
		super(message);
		this.name = "TickTickError";
		this.kind = kind;
		this.status = options.status ?? null;
		this.retryAfterSec = options.retryAfterSec ?? null;
		this.maybePartial = options.maybePartial ?? false;
	}
}

/**
 * The TickTick Open API. One method per endpoint; each throws `TickTickError` on failure. The
 * client never retries; the sync decides what a failure means. A project id may be `"inbox"` for reads and moves.
 */
export interface TickTickApi {
	/** GET /project */
	listProjects(): Promise<TtProject[]>;
	/** GET /project/{id}/data: the open tasks and the sections. */
	getProjectData(projectId: string): Promise<TtProjectData>;
	/** POST /task/completed: completed tasks in a window (200 at most). */
	listCompleted(query: TtCompletedQuery): Promise<TtTask[]>;
	/**
	 * POST /task/filter. Unused by the sync today. It is the only bulk way to read "won't do" tasks (status -1), which
	 * appear in neither the project data nor the completed list, should checking them one by one become too slow.
	 */
	filterTasks(filter: TtTaskFilter): Promise<TtTask[]>;
	/** GET /project/{p}/task/{t}. Not found under the wrong project; a deleted task still reads. */
	getTask(projectId: string, taskId: string): Promise<TtTask>;
	/** POST /task. The id in the answer is TickTick's own. */
	createTask(task: TtTaskCreate): Promise<TtTask>;
	/** POST /task/{id}: a partial update. */
	updateTask(task: TtTaskUpdate): Promise<TtTask>;
	/** DELETE /project/{p}/task/{t} */
	deleteTask(projectId: string, taskId: string): Promise<void>;
	/** POST /task/move */
	moveTasks(moves: TtMove[]): Promise<TtMoveResult[]>;
	/** POST /task/batch: 50 tasks at most. */
	batchTasks(batch: TtBatch): Promise<TtBatchResult>;
	/** POST /project */
	createProject(project: TtProjectCreate): Promise<TtProject>;
	/** POST /project/{p}/column. TickTick has no call that deletes a section. */
	createColumn(projectId: string, name: string): Promise<TtColumn>;
	/** GET /tag: every tag of the account. */
	listTags(): Promise<TtTag[]>;
	/** POST /tag. An existing name (under any parent) changes nothing. */
	createTag(tag: TtTagCreate): Promise<void>;
}
