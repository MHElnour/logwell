import { MemoryTickTickPending } from "../../src/app/ports";
import { SyncService } from "../../src/app/SyncService";
import type { ID, SyncLink, SyncLinkKind, Task } from "../../src/domain/types";
import { syncLinkId } from "../../src/domain/types";
import { FakeTickTick } from "./fake-ticktick";
import { type AppHarness, appHarness } from "./harness";

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
