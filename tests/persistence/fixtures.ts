import type { Task } from "../../src/domain/types";
import { BackupStore, dbBackupRoot } from "../../src/persistence/backups";
import { CpbaseStore, type StoreDeps, type StoreEvent, loadText } from "../../src/persistence/CpbaseStore";
import type { DbFile } from "../../src/persistence/gateway";
import { MemoryFileGateway, bindFile } from "./memoryGateway";
import type { JournalOp } from "../../src/persistence/journal";
import type { Migration } from "../../src/persistence/migrations";
import { type DbData, HISTORY_LIMIT, createEmptyDb } from "../../src/persistence/schema";
import { serializeDb } from "../../src/persistence/serializer";
import { FakeClock, ManualScheduler, MemoryLocalState, sequentialIds, settle } from "../helpers";

export const DB_PATH = "Checkpoint.cpbase";
export const BACKUP_ROOT = "plugin/backups";

export function makeTask(id: string, patch: Partial<Task> = {}): Task {
	return {
		id,
		title: `Task ${id}`,
		descriptionNote: null,
		categoryId: "inbox",
		tagKeys: [],
		parentId: null,
		sectionId: null,
		scheduled: null,
		deadline: null,
		plannedDurationMin: null,
		urgent: false,
		important: false,
		priority: 0,
		status: "open",
		completedAt: null,
		recurrence: null,
		sortKey: "V",
		createdAt: "2026-10-01T09:00:00.000Z",
		modifiedAt: "2026-10-01T09:00:00.000Z",
		...patch,
	};
}

export function emptyDbText(dbId = "db-1", revision = "r-000000000000"): string {
	return serializeDb(
		createEmptyDb({ dbId, revision, deviceId: "d-other", now: "2026-10-01T08:00:00.000Z" }),
	);
}

export function load(text: string): DbData {
	const r = loadText(text, "2026-10-01T10:00:00.000Z");
	if (r.kind !== "ok") throw new Error(`load failed: ${r.kind}`);
	return r.data;
}

/** Another device's write that descends from `base` (history capped like the store does). */
export function descendant(base: string, change: (d: DbData) => DbData, revision: string): string {
	const data = change(load(base));
	return serializeDb({
		...data,
		meta: {
			...data.meta,
			revision,
			baseRevision: data.meta.revision,
			history: [...data.meta.history, data.meta.revision].slice(-HISTORY_LIMIT),
			writtenBy: "d-other",
		},
	});
}

/** `count` further saves on another device, each a descendant of the previous one. */
export function descendants(base: string, count: number, prefix: string): string {
	let text = base;
	for (let i = 1; i <= count; i++) text = descendant(text, (d) => d, `r-${prefix}${String(i).padStart(4, "0")}`);
	return text;
}

export function withTask(data: DbData, task: Task): { next: DbData; ops: JournalOp[] } {
	const tasks = new Map(data.tasks);
	tasks.set(task.id, task);
	return { next: { ...data, tasks }, ops: [{ c: "tasks", id: task.id, v: task }] };
}

export interface Harness {
	fs: MemoryFileGateway;
	clock: FakeClock;
	scheduler: ManualScheduler;
	local: MemoryLocalState;
	events: StoreEvent[];
	store: CpbaseStore;
	newStore(): CpbaseStore;
	dbText(): string;
	addTask(task: Task, store?: CpbaseStore): void;
	saveNow(store?: CpbaseStore): Promise<void>;
}

/**
 * Runs `before` ahead of the next `times` writes to a path `match` accepts (every one by default); a throw from it
 * fails that write. `hits` counts the runs; `restore` puts the plain write back.
 */
export function interceptWrite(h: Harness, match: (path: string) => boolean, before: (path: string) => void, times = Infinity): { readonly hits: number; restore(): void } {
	const write = h.fs.write.bind(h.fs);
	let hits = 0;
	h.fs.write = async (path, data) => {
		if (hits < times && match(path)) {
			hits++;
			before(path);
		}
		await write(path, data);
	};
	return {
		get hits() {
			return hits;
		},
		restore() {
			h.fs.write = write;
		},
	};
}

export function harness(
	initial: string | null = emptyDbText(),
	migrations?: Migration[],
	wrapFile: (file: DbFile) => DbFile = (file) => file,
): Harness {
	const fs = new MemoryFileGateway();
	if (initial !== null) fs.files.set(DB_PATH, initial);
	const clock = new FakeClock();
	const scheduler = new ManualScheduler();
	const local = new MemoryLocalState();
	const events: StoreEvent[] = [];
	const ids = sequentialIds();
	const deps = (): StoreDeps => ({
		file: wrapFile(bindFile(fs, () => DB_PATH)),
		backupsFor: (dbId) => new BackupStore(fs, dbBackupRoot(BACKUP_ROOT, dbId), clock),
		clock,
		ids,
		deviceId: "d-test",
		local,
		scheduler,
		onEvent: (e) => events.push(e),
		...(migrations === undefined ? {} : { migrations }),
	});
	const h: Harness = {
		fs,
		clock,
		scheduler,
		local,
		events,
		store: new CpbaseStore(deps()),
		newStore: () => new CpbaseStore(deps()),
		dbText: () => fs.files.get(DB_PATH) ?? "",
		addTask(task, store = h.store) {
			const { next, ops } = withTask(store.data, task);
			store.commit(next, ops);
		},
		async saveNow(store = h.store) {
			await store.flush();
			await settle();
		},
	};
	return h;
}
