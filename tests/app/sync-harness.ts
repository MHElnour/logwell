import { expect } from "vitest";
import { MemoryTickTickPending } from "../../src/app/ports";
import { SyncService } from "../../src/app/SyncService";
import type { SyncResult } from "../../src/app/syncModel";
import type { TtTaskCreate } from "../../src/domain/ticktick/types";
import type { ID, SyncLink, SyncLinkKind, Task } from "../../src/domain/types";
import { syncLinkId } from "../../src/domain/types";
import { FakeTickTick } from "./fake-ticktick";
import { type AppHarness, appHarness, makeReadOnly, makeWritable } from "./harness";

// A real app store, a fake TickTick and the sync engine between them.

export const ZONE = "Europe/Berlin";

export interface SyncHarness {
	h: AppHarness;
	tt: FakeTickTick;
	sync: SyncService;
	/** A new sync engine on the same database, TickTick and device storage, as after Obsidian restarts: `sync` is replaced. */
	restart(): SyncService;
	/** The Logwell task with this title (throws when none). */
	task(title: string): Task;
	/** The Logwell tasks with this title. */
	tasks(title: string): Task[];
	link(kind: SyncLinkKind, id: ID): SyncLink | undefined;
	/** The TickTick id a Logwell task is linked to (throws when not linked). */
	ttIdOf(title: string): string;
	/** Advances the clock (a minute by default), as between two syncs. */
	tick(ms?: number): void;
	/** The `tickTickNotes` setting; off by default. */
	notesOn: boolean;
}

/** `initial` is a database text; `fake` a TickTick filled before it (its clock is then its own). */
export async function syncHarness(initial?: string, fake?: FakeTickTick): Promise<SyncHarness> {
	const h = await appHarness(initial === undefined ? {} : { initial });
	const tt = fake ?? new FakeTickTick(h.clock);
	// The setting is read through the harness object, so a test can turn it on and off between syncs.
	let harness: SyncHarness | null = null;
	const device = new MemoryTickTickPending();
	const engine = () =>
		new SyncService(
			h.app.store,
			h.app.tasks,
			h.app.sections,
			{ zone: () => ZONE },
			tt,
			{
				port: h.notes,
				enabled: () => harness?.notesOn === true,
				folder: () => "Task notes",
			},
			device,
		);
	const sync = engine();
	const all = (title: string) => [...h.app.store.state.tasks.values()].filter((t) => t.title === title);
	const link = (kind: SyncLinkKind, id: ID) => h.app.store.state.syncLinks.get(syncLinkId(kind, id));
	harness = {
		h,
		tt,
		sync,
		restart() {
			harness!.sync.stop();
			harness!.sync = engine();
			return harness!.sync;
		},
		notesOn: false,
		tasks: all,
		task(title) {
			const found = all(title);
			if (found.length !== 1) throw new Error(`expected one task "${title}", found ${found.length}`);
			return found[0]!;
		},
		link,
		ttIdOf(title) {
			const found = all(title);
			if (found.length !== 1) throw new Error(`expected one task "${title}", found ${found.length}`);
			const l = link("task", found[0]!.id);
			if (l === undefined) throw new Error(`"${title}" is not linked`);
			return l.ttId;
		},
		tick(ms = 60_000) {
			h.clock.advance(ms);
		},
	};
	return harness;
}

/** A Logwell list linked to a new TickTick project by a first sync. */
export async function linkedList(s: SyncHarness, name = "Work"): Promise<{ listId: ID; projectId: string }> {
	const list = await s.h.app.categories.create(name);
	const project = s.tt.addProject(name);
	const r = await s.sync.applyFirstSync(list.id, project.id);
	if (!r.ok) throw new Error(`first sync failed: ${r.error?.message}`);
	s.tick();
	return { listId: list.id, projectId: project.id };
}

/** A synced task and where it lives on both sides. */
export type SyncedTask = SyncHarness & { listId: string; projectId: string; id: string; ttId: string };

/** A linked list "Work" holding one task, synced: "Call the bank" unless named otherwise. */
export async function oneSyncedTask(title = "Call the bank"): Promise<SyncedTask> {
	const s = await syncHarness();
	const { listId, projectId } = await linkedList(s);
	const { task } = await s.h.app.tasks.create({ title, categoryId: listId });
	await s.sync.sync();
	s.tick();
	return Object.assign(s, { listId, projectId, id: task.id, ttId: s.ttIdOf(title) });
}

/**
 * A create TickTick answered whose link was never written: the store turns read-only right after the answer, then
 * the file is repaired (`saved`, the database before that sync) and the store is writable again, with no link.
 */
export async function failedLink(title = "Buy milk"): Promise<SyncedTask & { saved: string }> {
	const s = await syncHarness();
	const { listId, projectId } = await linkedList(s);
	const { task } = await s.h.app.tasks.create({ title, categoryId: listId });
	await s.h.saveNow();
	const saved = s.h.dbText();
	const create = s.tt.createTask.bind(s.tt);
	s.tt.createTask = async (input: TtTaskCreate) => {
		const made = await create(input);
		await makeReadOnly(s.h);
		return made;
	};
	await expect(s.sync.sync()).rejects.toThrow();
	s.tt.createTask = create;
	await makeWritable(s.h, saved);
	s.tick();
	return Object.assign(s, { listId, projectId, id: task.id, ttId: s.tt.findByTitle(title)!.id, saved });
}

/**
 * Two syncs a minute apart, the second's result returned. A task deleted in TickTick counts as gone only when a second
 * read finds it unchanged: the first sync reads it, the second decides.
 */
export async function syncTwice(s: SyncHarness): Promise<SyncResult> {
	await s.sync.sync();
	s.tick();
	return s.sync.sync();
}

/** The titles of the tasks in the Logwell Trash, sorted. */
export function trashedTitles(s: SyncHarness): string[] {
	return [...s.h.app.store.state.trash.values()].flatMap((e) => e.tasks.map((t) => t.title)).sort();
}

/** The task writes sent to TickTick so far: creates, updates and batches. */
export const pushes = (s: SyncHarness): number => s.tt.count("batchTasks") + s.tt.count("updateTask") + s.tt.count("createTask");

const READS = new Set(["listProjects", "getProjectData", "listCompleted", "filterTasks", "getTask", "listTags"]);

/** The next sync, a minute later, succeeds and sends nothing to TickTick: it only reads. */
export async function quiet(s: SyncHarness): Promise<void> {
	s.tick();
	const from = s.tt.calls.length;
	const r = await s.sync.sync();
	expect(r.ok).toBe(true);
	expect(s.tt.calls.slice(from).filter((c) => !READS.has(c.split(":")[0]!))).toEqual([]);
}
