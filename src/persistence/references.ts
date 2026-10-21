import { tagPrefixes } from "../domain/tags";
import { canBeParentOf, isSectionOf } from "../domain/tasks";
import type { CollectionName, DbCollections, RecordOf } from "./schema";

// Every link between records: which field of which collection points at which collection, and what happens when the
// target goes away. The one list of them; nothing else lists which fields point where. Each commit and each Undo
// check a command's result against it (`referenceProblems`); the load repair (`repairReferences`) does what `load`
// names for each record whose target is missing, and records `loadIssue`.
//
// The table only checks. The services keep their cascades (a list's delete moves its tasks to Inbox, a task's delete
// takes its subtasks, a tag's delete rekeys the tasks that hold it), and the check refuses (or reports) a result that
// one of them, or a write that is not an undo step, would leave with a broken link.
//
// Not in the table, never checked: a task's description note (a note path in the vault), a sync link's TickTick ids
// (`ttId`, `ttProjectId`) and a focus session's device id. Not a link either: a subtask shares its parent's list and
// section, which the services keep and `repairReferences` repairs by hand after the links.

/**
 * What the load repair does when the target is missing (or `accepts` refuses it): send the task to Inbox, clear the
 * pointer, drop the record, recreate the missing tag, make the subtask a top-level task, or nothing.
 */
export type LoadAction = "inbox" | "null" | "drop" | "recreateTag" | "topLevel" | "keep";

/**
 * Whether commits and Undo check a link. `restrict`: a result that holds a pointer that does not resolve (or that
 * `accepts` refuses) is refused, and so is one that removes a record an unchanged record still points at; `messages`
 * say why: `missing` for a pointer the result holds, `held` for a target it removes. `keep`: allowed to dangle, never
 * checked (a trashed task's list, a focus session's task).
 */
type Live = { live: "restrict"; messages: { missing: string; held: string } } | { live: "keep" };

/**
 * What the load repair does for this link, and the issue it records for a record whose target is missing (`missing`)
 * or refused by `accepts`.
 */
type Load<R> = { load: "keep" } | { load: Exclude<LoadAction, "keep">; loadIssue(record: R, ref: string, missing: boolean): string };

/** The task fields that point at another record. */
export type TaskRefField = "categoryId" | "sectionId" | "parentId" | "tagKeys";

/**
 * Where the pointer is: a field of `from` (a task's are `TaskRefField`), `tasks[].field` for the tasks of a trash
 * entry, `key` for the tags above a tag.
 */
type Pointer = { from: "tasks"; field: TaskRefField } | { from: Exclude<CollectionName, "tasks">; field: string };

/** One link. */
export type ReferenceRule = Live & Load<unknown> & Pointer & {
	to: CollectionName;
	/** The ids of `to` one record of `from` points at (none for a null pointer). */
	refsOf(record: unknown): readonly string[];
	/** Beyond existence: whether the record may point at this target (a section of its own list, a top-level parent). */
	accepts?(record: unknown, target: unknown): boolean;
	/**
	 * What of a target `accepts` reads: a change of it rechecks the records that point at the target, as a removal does
	 * (a parent made a subtask while it has subtasks).
	 */
	acceptsOn?(target: unknown): unknown;
};

/** One record a command wrote, before and after (undefined: absent). The app's `Change` is one. */
export interface ChangedRecord {
	c: CollectionName;
	id: string;
	before: unknown;
	after: unknown;
}

/**
 * The ids of `rule.from` that point at `targetId` in the state a command started from, from an index; undefined when
 * the index has no answer (the check then reads the collection). May list records that no longer point at it.
 */
export type ReverseLookup = (rule: ReferenceRule, targetId: string) => Iterable<string> | undefined;

/** A broken link in a command's result: the record `id` of `rule.from` and the `target` it points at. */
export interface ReferenceProblem {
	rule: ReferenceRule;
	id: string;
	target: string;
	message: string;
}

/** A row, typed by its collections. */
function row<F extends CollectionName, T extends CollectionName>(
	r: Live &
		Load<RecordOf<F>> & {
			from: F;
			field: F extends "tasks" ? TaskRefField : string;
			to: T;
			refsOf(record: RecordOf<F>): readonly string[];
			accepts?(record: RecordOf<F>, target: RecordOf<T>): boolean;
			acceptsOn?(target: RecordOf<T>): unknown;
		},
): ReferenceRule {
	return r as ReferenceRule;
}

const one = (id: string | null): readonly string[] => (id === null ? [] : [id]);

/** The issue of a tag the load recreated, for a task that holds it or a tag under it. */
const tagRecreated = (_record: unknown, key: string): string => `Tag "${key}" was missing and has been recreated.`;

/**
 * The rows. Their order is the order a refusal names the first problem in: a list's tasks before its sections, a
 * tag's tasks before the tags under it.
 */
export const REFERENCES: readonly ReferenceRule[] = [
	row({
		from: "tasks",
		field: "categoryId",
		to: "categories",
		refsOf: (t) => [t.categoryId],
		live: "restrict",
		load: "inbox",
		loadIssue: (t) => `Task "${t.title}" pointed to a missing list and was moved to Inbox.`,
		messages: { missing: "a task is in a list that does not exist.", held: "a task now uses this list." },
	}),
	row({
		from: "tasks",
		field: "sectionId",
		to: "sections",
		refsOf: (t) => one(t.sectionId),
		accepts: (t, s) => isSectionOf(s, t.categoryId),
		acceptsOn: (s) => s.categoryId,
		live: "restrict",
		load: "null",
		loadIssue: (t, _ref, missing) =>
			missing ? `Task "${t.title}" pointed to a missing section and was moved to No section.` : `Task "${t.title}" was in a section of another list and was moved to No section.`,
		messages: { missing: "a task is in a section that is not in its list.", held: "a task now uses this section." },
	}),
	row({
		from: "tasks",
		field: "parentId",
		to: "tasks",
		refsOf: (t) => one(t.parentId),
		accepts: (t, parent) => canBeParentOf(parent, t.id),
		acceptsOn: (parent) => parent.parentId,
		live: "restrict",
		load: "topLevel",
		loadIssue: (t) => `Subtask "${t.title}" lost its parent and is now a top-level task.`,
		messages: { missing: "a task's parent is gone or is not a top-level task.", held: "a task now has this task as its parent." },
	}),
	row({
		from: "tasks",
		field: "tagKeys",
		to: "tags",
		refsOf: (t) => t.tagKeys,
		live: "restrict",
		load: "recreateTag",
		loadIssue: tagRecreated,
		messages: { missing: "a task uses a tag that does not exist.", held: "a task now uses this tag." },
	}),
	// A tag's delete and rename rekey trashed tasks too, so a trashed task's tags exist, unless a file left one out:
	// the load keeps it, and restoring the task drops it.
	row({
		from: "trash",
		field: "tasks[].tagKeys",
		to: "tags",
		refsOf: (e) => e.tasks.flatMap((t) => t.tagKeys),
		live: "restrict",
		load: "keep",
		messages: { missing: "a deleted task uses a tag that does not exist.", held: "a task now uses this tag." },
	}),
	row({
		from: "tags",
		field: "key",
		to: "tags",
		// Every tag above it: `a/b/c` sits under `a/b` and `a`.
		refsOf: (tag) => tagPrefixes(tag.key).slice(0, -1),
		live: "restrict",
		load: "recreateTag",
		loadIssue: tagRecreated,
		messages: { missing: "a tag sits under a tag that does not exist.", held: "a tag now sits under this tag." },
	}),
	row({
		from: "sections",
		field: "categoryId",
		to: "categories",
		refsOf: (s) => [s.categoryId],
		live: "restrict",
		load: "drop",
		loadIssue: (s) => `Section "${s.name}" pointed to a missing list and was removed.`,
		messages: { missing: "a section is in a list that does not exist.", held: "a section now sits in this list." },
	}),
	// A trashed task keeps its list, section and parent as they were: restoring it sends it to Inbox, No section or the
	// top level when they are gone.
	row({ from: "trash", field: "tasks[].categoryId", to: "categories", refsOf: (e) => e.tasks.map((t) => t.categoryId), live: "keep", load: "keep" }),
	row({ from: "trash", field: "tasks[].sectionId", to: "sections", refsOf: (e) => e.tasks.flatMap((t) => one(t.sectionId)), live: "keep", load: "keep" }),
	row({ from: "trash", field: "tasks[].parentId", to: "tasks", refsOf: (e) => e.tasks.flatMap((t) => one(t.parentId)), live: "keep", load: "keep" }),
	// The done and skipped days of a task stay while it is in the Trash; its purge removes them.
	row({ from: "occurrenceRecords", field: "taskId", to: "tasks", refsOf: (r) => [r.taskId], live: "keep", load: "keep" }),
	// A habit's delete removes its check-ins.
	row({ from: "checkins", field: "habitId", to: "habits", refsOf: (c) => [c.habitId], live: "keep", load: "keep" }),
	// A focus round keeps the title of a task that is gone; a split round its first part.
	row({ from: "focusSessions", field: "taskId", to: "tasks", refsOf: (s) => one(s.taskId), live: "keep", load: "keep" }),
	row({ from: "focusSessions", field: "splitFrom", to: "focusSessions", refsOf: (s) => one(s.splitFrom), live: "keep", load: "keep" }),
	// A sync link alone never refuses: the next sync drops a link whose record is gone.
	row({ from: "syncLinks", field: "logwellId", to: "tasks", refsOf: (l) => (l.kind === "task" ? [l.logwellId] : []), live: "keep", load: "keep" }),
	row({ from: "syncLinks", field: "logwellId", to: "categories", refsOf: (l) => (l.kind === "list" ? [l.logwellId] : []), live: "keep", load: "keep" }),
	row({ from: "syncLinks", field: "logwellId", to: "sections", refsOf: (l) => (l.kind === "section" ? [l.logwellId] : []), live: "keep", load: "keep" }),
];

/**
 * The links a command that wrote `changes` broke, in `data`, its result (empty when there are none), in the order of
 * `REFERENCES`. The whole result is checked once, so a command may write a record before the one it points at.
 * Forward: each record the command put points only at records that exist and accept it. Reverse: no record the
 * command left alone points at a record it removed (or changed in what `accepts` reads); those records come from
 * `reverse` when it answers, else from one pass over the collection. A link that was already broken in the state the
 * command started from (the same record holding the same pointer, from a file the load left so, or a write that was
 * reported) is not the command's: it counts only when the command points a record at it anew. Cost: the records
 * written, plus the records that point at a removed one.
 */
export function referenceProblems(data: DbCollections, changes: readonly ChangedRecord[], reverse?: ReverseLookup): ReferenceProblem[] {
	const out: ReferenceProblem[] = [];
	const written = new Map<CollectionName, ChangedRecord[]>();
	for (const ch of changes) {
		const list = written.get(ch.c);
		if (list === undefined) written.set(ch.c, [ch]);
		else list.push(ch);
	}
	/** The ids the command wrote in each collection, made on the first ask. */
	const writtenIds = new Map<CollectionName, Set<string>>();
	for (const rule of REFERENCES) {
		const fromChanges = written.get(rule.from);
		const toChanges = written.get(rule.to);
		if (rule.live !== "restrict" || (fromChanges === undefined && toChanges === undefined)) continue;
		const from = data[rule.from] as ReadonlyMap<string, unknown>;
		const targets = data[rule.to] as ReadonlyMap<string, unknown>;
		const accepted = (record: unknown, target: unknown): boolean => target !== undefined && (rule.accepts === undefined || rule.accepts(record, target));
		const resolves = (record: unknown, ref: string): boolean => accepted(record, targets.get(ref));
		/** The targets the command wrote, by id, made on the first ask. */
		let toById: Map<string, ChangedRecord> | undefined;
		/** Whether `record`, as it was before the command, reached `ref` then (the target as it was too). */
		const resolvedBefore = (record: unknown, ref: string): boolean => {
			toById ??= new Map((toChanges ?? []).map((ch) => [ch.id, ch]));
			const ch = toById.get(ref);
			return accepted(record, ch === undefined ? targets.get(ref) : ch.before);
		};
		for (const ch of fromChanges ?? []) {
			if (ch.after === undefined) continue;
			for (const ref of rule.refsOf(ch.after)) {
				if (resolves(ch.after, ref)) continue;
				// The same pointer, already broken before the command: not this command's.
				if (ch.before !== undefined && rule.refsOf(ch.before).includes(ref) && !resolvedBefore(ch.before, ref)) continue;
				out.push({ rule, id: ch.id, target: ref, message: rule.messages.missing });
			}
		}
		// The targets the command removed, or changed in what `accepts` reads.
		const gone = new Set<string>();
		for (const ch of toChanges ?? []) {
			if (ch.before === undefined) continue;
			if (ch.after === undefined || (rule.acceptsOn !== undefined && rule.acceptsOn(ch.before) !== rule.acceptsOn(ch.after))) gone.add(ch.id);
		}
		if (gone.size === 0) continue;
		const held = (id: string, ref: string) => {
			const record = from.get(id);
			if (record === undefined || !rule.refsOf(record).includes(ref) || resolves(record, ref) || !resolvedBefore(record, ref)) return;
			// A record the command left alone is as it was, so `resolvedBefore` read it as it was; a record the command wrote
			// was checked forward. The ids are read only here, when a problem is found.
			let own = writtenIds.get(rule.from);
			if (own === undefined) writtenIds.set(rule.from, (own = new Set((fromChanges ?? []).map((ch) => ch.id))));
			if (!own.has(id)) out.push({ rule, id, target: ref, message: rule.messages.held });
		};
		const looked = lookUp(reverse, rule, gone);
		if (looked !== undefined) {
			for (const [ref, ids] of looked) for (const id of ids) held(id, ref);
		} else {
			for (const [id, record] of from) for (const ref of rule.refsOf(record)) if (gone.has(ref)) held(id, ref);
		}
	}
	return out;
}

/** The records `reverse` says point at each target, or undefined when it has no answer for one of them. */
function lookUp(reverse: ReverseLookup | undefined, rule: ReferenceRule, targets: ReadonlySet<string>): [string, Iterable<string>][] | undefined {
	if (reverse === undefined) return undefined;
	const out: [string, Iterable<string>][] = [];
	for (const ref of targets) {
		const ids = reverse(rule, ref);
		if (ids === undefined) return undefined;
		out.push([ref, ids]);
	}
	return out;
}
