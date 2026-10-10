// The TickTick Open API shapes Logwell reads and writes. Recorded responses are in
// tests/fixtures/ticktick/recorded.json. Fields the sync never reads are left out.

/**
 * Items of a `kind: "CHECKLIST"` task. The text of such a task is in `desc`, not `content`. Probed 2026-10-08: an
 * item also has `startDate`, `isAllDay` and `timeZone`; TickTick gives every item a new id on every update of its
 * task, so an id says nothing across writes. Fields Logwell does not read are kept and sent back as they are.
 */
export interface TtChecklistItem {
	id: string;
	title: string;
	/** 0 open, 1 done. */
	status: number;
	sortOrder?: number;
	[field: string]: unknown;
}

/**
 * A checklist item as sent. An update replaces the whole list (probed 2026-10-08): an item left out is
 * removed, and a field left out of an item is erased, so an existing item is sent with every field TickTick gave it.
 * An item without an id is new.
 */
export interface TtChecklistItemWrite {
	id?: string;
	title: string;
	/** 0 open, 1 done. */
	status: number;
	[field: string]: unknown;
}

export interface TtTask {
	id: string;
	projectId: string;
	title: string;
	/** Text of a normal task. */
	content?: string;
	/** Text of a checklist task. */
	desc?: string;
	/** `2026-10-07T21:00:00.000+0000`. Absent when the task has no date. */
	startDate?: string;
	dueDate?: string;
	/** IANA zone the task was made in. */
	timeZone?: string;
	isAllDay?: boolean;
	isFloating?: boolean;
	/** 0 none, 1 low, 3 medium, 5 high. */
	priority?: number;
	/** 0 open, 2 completed, -1 won't do. Stays correct after a reopen, unlike `completedTime`. */
	status?: number;
	tags?: string[];
	parentId?: string;
	childIds?: string[];
	/** Sectioned (kanban) projects only. */
	columnId?: string;
	columnName?: string;
	/** A non-empty value means the task repeats. */
	repeatFlag?: string;
	/** "TEXT", "CHECKLIST" or "NOTE". */
	kind?: string;
	items?: TtChecklistItem[];
	sortOrder?: number;
	/** Changes on every edit, including API edits. */
	etag?: string;
	etimestamp?: number;
	completedTime?: string;
	createdTime?: string;
	/** Does NOT change on API edits: never use it to detect a change. */
	modifiedTime?: string;
}

export interface TtProject {
	id: string;
	name: string;
	sortOrder?: number;
	viewMode?: string;
	/** "TASK" or "NOTE". Note projects cannot be linked. */
	kind?: string;
	closed?: boolean;
}

export interface TtColumn {
	id: string;
	projectId: string;
	name: string;
	sortOrder?: number;
}

/** `GET /project/{id}/data`: the open tasks only. */
export interface TtProjectData {
	project: TtProject;
	tasks: TtTask[];
	columns: TtColumn[];
}

/** What a task write may carry. A partial update keeps every field it does not name. */
export interface TtTaskWrite {
	title?: string;
	content?: string;
	desc?: string;
	/** null clears the date (an empty string is ignored by TickTick). */
	startDate?: string | null;
	dueDate?: string | null;
	timeZone?: string;
	isAllDay?: boolean;
	priority?: number;
	status?: number;
	tags?: string[];
	parentId?: string;
	columnId?: string;
	sortOrder?: number;
	items?: TtChecklistItemWrite[];
}

/** `POST /task`. TickTick ignores a client-supplied id and returns its own. */
export interface TtTaskCreate extends TtTaskWrite {
	projectId: string;
	title: string;
}

/** `POST /task/{id}` and the `update` list of a batch. */
export interface TtTaskUpdate extends TtTaskWrite {
	id: string;
	projectId: string;
}

/** `POST /task/filter`. Every field narrows the result. */
export interface TtTaskFilter {
	projectIds?: string[];
	startDate?: string;
	endDate?: string;
	priority?: number[];
	tag?: string[];
	/** 0 open, 2 completed, -1 won't do. */
	status?: number[];
}

/** `POST /task/completed`: completed tasks in a time window. */
export interface TtCompletedQuery {
	projectIds: string[];
	startDate: string;
	endDate: string;
}

export interface TtMove {
	fromProjectId: string;
	toProjectId: string;
	taskId: string;
}

/** One entry of the `POST /task/move` answer: the moved task's id and its new etag. */
export interface TtMoveResult {
	id: string;
	etag?: string;
}

/**
 * `POST /task/batch`. `id2etag` holds the etags of the added and updated tasks; a new id is NOT labeled per added
 * item, so added tasks are matched by re-reading, not by position. `id2error` holds per-task failures.
 */
export interface TtBatchResult {
	id2etag: Record<string, string>;
	id2error: Record<string, unknown>;
}

export interface TtBatch {
	add?: TtTaskCreate[];
	update?: TtTaskUpdate[];
}

export interface TtProjectCreate {
	name: string;
	/** "list" or "kanban": a project with sections is kanban. */
	viewMode?: string;
	kind?: string;
}

/**
 * `GET /tag` (probed 2026-10-08; not in the documented API). `name` is the lowercase key a task's `tags` holds, unique
 * across the account; `label` the display text; `parent` the parent's name (one level). There is no tag delete.
 */
export interface TtTag {
	name: string;
	label: string;
	parent?: string;
}

/** `POST /tag`. A name that exists already, under any parent, is a silent no-op. */
export interface TtTagCreate {
	name: string;
	label: string;
	parent?: string;
}

/** A batch holds at most this many tasks. */
export const TICKTICK_BATCH_MAX = 50;
/** Open tasks a list may hold on TickTick's free plan; a write past it fails with HTTP 500. */
export const TICKTICK_FREE_OPEN_MAX = 99;
/** `POST /task/completed` returns at most this many tasks. */
export const TICKTICK_COMPLETED_MAX = 200;
