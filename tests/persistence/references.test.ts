import { describe, expect, it } from "vitest";
import { Tx } from "../../src/app/tx";
import type { Task, TrashEntry } from "../../src/domain/types";
import { type ChangedRecord, REFERENCES, type ReverseLookup, referenceProblems } from "../../src/persistence/references";
import { type CollectionName, type DbData, type RecordOf, createEmptyDb, emptyCollections, inboxCategory } from "../../src/persistence/schema";
import { makeSection, makeTag, makeTask } from "./fixtures";

// The table of every link between records, read by each commit and by Undo: a command's result may not hold a
// pointer to a record that is gone (or one the rule does not accept: a section of another list, a parent that is a
// subtask), and may not remove a record that an unchanged record still points at. Links the table keeps (a trashed
// task's list, a focus session's task, a sync link) are never refused. A link already broken before the command is
// not the command's: only the links it breaks count.

const NOW = "2026-10-01T09:00:00.000Z";

const entry = (batchId: string, tasks: Task[]): TrashEntry => ({ batchId, deletedAt: NOW, tasks });

/**
 * Inbox and the list "work" with the section "s-work"; the tags home, home/calls and errands; the task "p" (tagged
 * home/calls) and its subtask "c" in the Inbox; "w" in work's section, tagged errands; a trash entry whose task is
 * tagged home.
 */
function base(): DbData {
	const data = { meta: createEmptyDb({ dbId: "db-1", revision: "r-000000000000", deviceId: "d-1", now: NOW }).meta, ...emptyCollections() };
	data.categories.set("inbox", inboxCategory(NOW));
	data.categories.set("work", { ...inboxCategory(NOW), id: "work", name: "Work", nameKey: "work", isInbox: false });
	data.sections.set("s-work", makeSection("s-work", "work"));
	for (const key of ["home", "home/calls", "errands"]) data.tags.set(key, makeTag(key));
	for (const t of [makeTask("p", { tagKeys: ["home/calls"] }), makeTask("c", { parentId: "p" }), makeTask("w", { categoryId: "work", sectionId: "s-work", tagKeys: ["errands"] })]) data.tasks.set(t.id, t);
	data.trash.set("b1", entry("b1", [makeTask("d", { tagKeys: ["home"] })]));
	return data;
}

/** One write of a command: a record put (by its id) or removed. */
type Write = { [C in CollectionName]: { c: C; put: RecordOf<C> } | { c: C; remove: string } }[CollectionName];

/** The state after `writes` and the change list of the command that made them, from a transaction as the store runs one. */
function apply(start: DbData, writes: readonly Write[]): { data: DbData; changes: ChangedRecord[] } {
	const tx = new Tx(start, NOW);
	for (const w of writes) {
		if ("put" in w) tx.put(w.c, w.put);
		else tx.remove(w.c, w.remove);
	}
	const { data, changes } = tx.finish();
	return { data, changes };
}

/** `base()` with `writes` already in it: a state a command starts from. */
function startingFrom(writes: readonly Write[]): DbData {
	return apply(base(), writes).data;
}

const task = (id: string, patch: Partial<Task> = {}): Write => ({ c: "tasks", put: makeTask(id, patch) });
const messages = (writes: readonly Write[], start = base()) => {
	const { data, changes } = apply(start, writes);
	return referenceProblems(data, changes).map((p) => p.message);
};

describe("the reference table", () => {
	describe("#215: a command's result", () => {
		it.each<{ name: string; writes: Write[]; problem: string }>([
			{ name: "a task in a list that does not exist", writes: [task("t", { categoryId: "gone" })], problem: "a task is in a list that does not exist." },
			{ name: "a task in a section of another list", writes: [task("t", { sectionId: "s-work" })], problem: "a task is in a section that is not in its list." },
			{ name: "a task in a section that does not exist", writes: [task("t", { sectionId: "gone" })], problem: "a task is in a section that is not in its list." },
			{ name: "a subtask under a task that does not exist", writes: [task("t", { parentId: "gone" })], problem: "a task's parent is gone or is not a top-level task." },
			{ name: "a subtask under a subtask", writes: [task("t", { parentId: "c" })], problem: "a task's parent is gone or is not a top-level task." },
			{ name: "a task that is its own parent", writes: [task("t", { parentId: "t" })], problem: "a task's parent is gone or is not a top-level task." },
			{ name: "a task with a tag that does not exist", writes: [task("t", { tagKeys: ["home", "gone"] })], problem: "a task uses a tag that does not exist." },
			{ name: "a deleted task with a tag that does not exist", writes: [{ c: "trash", put: entry("b2", [makeTask("t", { tagKeys: ["gone"] })]) }], problem: "a deleted task uses a tag that does not exist." },
			{ name: "a tag under a tag that does not exist", writes: [{ c: "tags", put: makeTag("gone/child") }], problem: "a tag sits under a tag that does not exist." },
			{ name: "a section in a list that does not exist", writes: [{ c: "sections", put: makeSection("s-new", "gone") }], problem: "a section is in a list that does not exist." },
		])("refuses $name", ({ writes, problem }) => {
			expect(messages(writes)).toEqual([problem]);
		});

		it.each<{ name: string; writes: Write[]; problems: string[] }>([
			{ name: "a list a task uses and a section sits in", writes: [{ c: "categories", remove: "work" }], problems: ["a task now uses this list.", "a section now sits in this list."] },
			{ name: "a section a task uses", writes: [{ c: "sections", remove: "s-work" }], problems: ["a task now uses this section."] },
			{ name: "a task a subtask sits under", writes: [{ c: "tasks", remove: "p" }], problems: ["a task now has this task as its parent."] },
			{ name: "a parent made a subtask while it has subtasks", writes: [task("p", { tagKeys: ["home/calls"], parentId: "w", categoryId: "work" })], problems: ["a task now has this task as its parent."] },
			{ name: "a tag a task uses", writes: [{ c: "tags", remove: "errands" }], problems: ["a task now uses this tag."] },
			{ name: "a tag a deleted task uses and a tag sits under", writes: [{ c: "tags", remove: "home" }], problems: ["a task now uses this tag.", "a tag now sits under this tag."] },
		])("refuses removing $name", ({ writes, problems }) => {
			expect(messages(writes)).toEqual(problems);
		});

		it.each<{ name: string; writes: Write[] }>([
			{ name: "a task removed with its subtask", writes: [{ c: "tasks", remove: "c" }, { c: "tasks", remove: "p" }] },
			{ name: "a list removed with its section, its task moved to Inbox", writes: [{ c: "categories", remove: "work" }, { c: "sections", remove: "s-work" }, task("w", { tagKeys: ["errands"] })] },
			{ name: "a tag renamed with the task that uses it", writes: [{ c: "tags", remove: "errands" }, { c: "tags", put: makeTag("chores") }, task("w", { categoryId: "work", sectionId: "s-work", tagKeys: ["chores"] })] },
			{ name: "a subtask written before its new parent", writes: [task("r", { parentId: "q" }), task("q")] },
			{ name: "a parent written before its new subtask", writes: [task("q"), task("r", { parentId: "q" })] },
			{ name: "a task written before its new tag and the tag's parent", writes: [task("t", { tagKeys: ["new/child"] }), { c: "tags", put: makeTag("new/child") }, { c: "tags", put: makeTag("new") }] },
			{ name: "a section written before its new list", writes: [{ c: "sections", put: makeSection("s-new", "new") }, { c: "categories", put: { ...inboxCategory(NOW), id: "new", name: "New", nameKey: "new", isInbox: false } }] },
		])("passes $name, in any order within the command", ({ writes }) => {
			expect(messages(writes)).toEqual([]);
		});

		it.each<{ name: string; writes: Write[] }>([
			{ name: "a deleted task's list, section and parent", writes: [{ c: "trash", put: entry("b2", [makeTask("t", { categoryId: "gone", sectionId: "gone", parentId: "gone" })]) }] },
			{ name: "the list of a deleted task, removed", writes: [{ c: "trash", put: entry("b2", [makeTask("t", { categoryId: "work" })]) }, { c: "categories", remove: "work" }, task("w", { tagKeys: ["errands"] }), { c: "sections", remove: "s-work" }] },
			{ name: "an occurrence record's task", writes: [{ c: "occurrenceRecords", put: { taskId: "gone", occurrenceDate: "2026-10-01", status: "done", resolvedAt: NOW, auto: false, completedOn: null } }] },
			{ name: "a check-in's habit", writes: [{ c: "checkins", put: { id: "k", habitId: "gone", date: "2026-10-01", value: 1, note: null, createdAt: NOW, modifiedAt: NOW, deletedAt: null } }] },
			{ name: "a sync link's task", writes: [{ c: "syncLinks", put: { kind: "task", logwellId: "gone", ttId: "tt1", ttProjectId: null, etag: null, base: {}, noteBySync: false, lastPulledAt: null, pendingDelete: false, mode: "sync", modifiedAt: NOW } as unknown as RecordOf<"syncLinks"> }] },
		])("keeps $name: never refused", ({ writes }) => {
			expect(messages(writes)).toEqual([]);
		});

		it.each<{ name: string; broken: Write[]; writes: Write[] }>([
			{ name: "a tag under a tag that does not exist, recolored", broken: [{ c: "tags", put: makeTag("lost/child") }], writes: [{ c: "tags", put: makeTag("lost/child", { color: "red" }) }] },
			{
				name: "a deleted task's tag that does not exist, its entry rewritten by a rename of another tag it holds",
				broken: [{ c: "trash", put: entry("b2", [makeTask("t", { tagKeys: ["errands", "ghost"] })]) }],
				writes: [{ c: "tags", remove: "errands" }, { c: "tags", put: makeTag("chores") }, task("w", { categoryId: "work", sectionId: "s-work", tagKeys: ["chores"] }), { c: "trash", put: entry("b2", [makeTask("t", { tagKeys: ["chores", "ghost"] })]) }],
			},
			{ name: "a task in a section of another list, retitled", broken: [task("x", { sectionId: "s-work" })], writes: [task("x", { sectionId: "s-work", title: "Retitled" })] },
			{ name: "a subtask under a task that does not exist, retitled", broken: [task("o", { parentId: "gone" })], writes: [task("o", { parentId: "gone", title: "Retitled" })] },
			{ name: "a task in a section of another list, the section removed", broken: [task("x", { sectionId: "s-work" })], writes: [{ c: "sections", remove: "s-work" }, task("w", { categoryId: "work", tagKeys: ["errands"] })] },
		])("#215: does not blame a command for a link already broken before it: $name", ({ broken, writes }) => {
			expect(messages(writes, startingFrom(broken))).toEqual([]);
		});

		it.each<{ name: string; broken: Write[]; writes: Write[]; problems: string[] }>([
			{
				name: "a tag under a tag that does not exist, renamed (the new key is a new record)",
				broken: [{ c: "tags", put: makeTag("lost/child") }],
				writes: [{ c: "tags", remove: "lost/child" }, { c: "tags", put: makeTag("lost/kid") }],
				problems: ["a tag sits under a tag that does not exist."],
			},
			{ name: "a task holding a tag that does not exist, given a second one", broken: [task("u", { tagKeys: ["ghost"] })], writes: [task("u", { tagKeys: ["ghost", "gone"] })], problems: ["a task uses a tag that does not exist."] },
			{ name: "a subtask under a task that does not exist, moved under a subtask", broken: [task("o", { parentId: "gone" })], writes: [task("o", { parentId: "c" })], problems: ["a task's parent is gone or is not a top-level task."] },
		])("#215: blames a command for a link it breaks, beside one already broken: $name", ({ broken, writes, problems }) => {
			const { data, changes } = apply(startingFrom(broken), writes);
			const found = referenceProblems(data, changes);
			expect(found.map((p) => p.message)).toEqual(problems);
			expect(found.map((p) => p.target)).not.toContain("ghost");
		});

		it("checks the links it restricts, in the order a refusal names the first problem, and never the links it keeps", () => {
			const kept = REFERENCES.filter((r) => r.live === "keep").map((r) => `${r.from}.${r.field}`);
			expect(kept).toEqual(expect.arrayContaining(["focusSessions.taskId", "focusSessions.splitFrom", "occurrenceRecords.taskId", "checkins.habitId", "trash.tasks[].categoryId"]));
			const checked = REFERENCES.filter((r) => r.live === "restrict").map((r) => `${r.from}.${r.field}`);
			expect(checked).toEqual(["tasks.categoryId", "tasks.sectionId", "tasks.parentId", "tasks.tagKeys", "trash.tasks[].tagKeys", "tags.key", "sections.categoryId"]);
		});
	});

	describe("#215: the records that point at a removed one", () => {
		/** A task map that refuses to be read whole: the check must find holders through the lookup. */
		class NoScan<K, V> extends Map<K, V> {
			override values(): MapIterator<V> {
				throw new Error("scanned");
			}
			override entries(): MapIterator<[K, V]> {
				throw new Error("scanned");
			}
			override keys(): MapIterator<K> {
				throw new Error("scanned");
			}
			override forEach(): void {
				throw new Error("scanned");
			}
			override [Symbol.iterator](): MapIterator<[K, V]> {
				throw new Error("scanned");
			}
		}

		/** The holders in `start` of each target, as an index of the tasks would give them. */
		const lookup =
			(start: DbData): ReverseLookup =>
			(rule, target) => {
				if (rule.from !== "tasks") return undefined;
				return [...start.tasks.values()].filter((t) => rule.refsOf(t).includes(target)).map((t) => t.id);
			};

		it("reads them through the lookup, not the task map", () => {
			const start = base();
			const { data, changes } = apply(start, [{ c: "tasks", remove: "p" }]);
			const tasks = new NoScan(data.tasks);
			expect(referenceProblems({ ...data, tasks }, changes, lookup(start)).map((p) => [p.id, p.target, p.message])).toEqual([["c", "p", "a task now has this task as its parent."]]);
		});

		it("reads the collection when the lookup has no answer", () => {
			const { data, changes } = apply(base(), [{ c: "tasks", remove: "p" }]);
			expect(referenceProblems(data, changes, () => undefined).map((p) => p.id)).toEqual(["c"]);
		});

		it("counts a holder the command changed once, as the pointer it writes", () => {
			const start = base();
			const { data, changes } = apply(start, [{ c: "tasks", remove: "p" }, task("c", { parentId: "p", title: "Changed" })]);
			expect(referenceProblems(data, changes, lookup(start)).map((p) => [p.id, p.message])).toEqual([["c", "a task's parent is gone or is not a top-level task."]]);
		});

		it("does not count a holder that no longer points at it", () => {
			const start = base();
			// The lookup describes the state before the command; "c" left "p" in the same command.
			const { data, changes } = apply(start, [{ c: "tasks", remove: "p" }, task("c")]);
			expect(referenceProblems(data, changes, lookup(start))).toEqual([]);
		});
	});
});
