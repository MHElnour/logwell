import { isRecord } from "../domain/types";
import { CURRENT_SCHEMA_VERSION } from "./schema";

// Migration runner. Each step takes the raw JSON of schema version
// `from` and returns raw JSON of version `from + 1`. Steps run in order; the
// caller writes a backup before the first step.

export interface Migration {
	from: number;
	describe: string;
	migrate(raw: Record<string, unknown>): Record<string, unknown>;
}

type Rec = Record<string, unknown>;

function mapRecords(value: unknown, fn: (r: Rec) => Rec): unknown {
	if (!Array.isArray(value)) return value;
	return (value as unknown[]).map((r) => (isRecord(r) ? fn(r) : r));
}

const withPriority = (t: Rec): Rec => ("priority" in t ? t : { ...t, priority: 0 });

const withSectionId = (t: Rec): Rec => ("sectionId" in t ? t : { ...t, sectionId: null });

export const MIGRATIONS: readonly Migration[] = [
	{
		// Every task gets `priority: 0` (trashed tasks too) and every
		// category gets `color: null`. Existing values are left alone.
		from: 1,
		describe: "add task priority and list color",
		migrate(raw) {
			const out: Rec = { ...raw };
			if ("tasks" in raw) out.tasks = mapRecords(raw.tasks, withPriority);
			if ("categories" in raw) out.categories = mapRecords(raw.categories, (c) => ("color" in c ? c : { ...c, color: null }));
			if ("trash" in raw) {
				out.trash = mapRecords(raw.trash, (e) => ({ ...e, tasks: mapRecords(e.tasks, withPriority) }));
			}
			return out;
		},
	},
	{
		// Every task, trashed ones too, starts in "No section". The new
		// `sections` collection needs no step: a missing collection reads as empty
		// (validateDb) and is written back as `[]`.
		from: 2,
		describe: "add task sectionId",
		migrate(raw) {
			const out: Rec = { ...raw };
			if ("tasks" in raw) out.tasks = mapRecords(raw.tasks, withSectionId);
			if ("trash" in raw) {
				out.trash = mapRecords(raw.trash, (e) => ({ ...e, tasks: mapRecords(e.tasks, withSectionId) }));
			}
			return out;
		},
	},
	{
		// v3 to v4 changes no record. Every task's `recurrence` is already null (the v3 default)
		// and `occurrenceRecords` stays as it is. The step exists for the header alone: a schema 3
		// device must open a database that can hold repeating series read-only, because there a
		// repeating task looks undated and completing it would end the whole series.
		from: 3,
		describe: "recurrence (header only)",
		migrate: (raw) => ({ ...raw }),
	},
	{
		// The `syncLinks` collection starts empty; no record changes. The bump makes a
		// schema 4 device open a database with TickTick links read-only instead of dropping them.
		from: 4,
		describe: "add TickTick sync links",
		migrate: (raw) => ("syncLinks" in raw ? { ...raw } : { ...raw, syncLinks: [] }),
	},
];

export type MigrationPlan =
	| { kind: "current" }
	| { kind: "newer"; version: number }
	| { kind: "migrate"; from: number; steps: Migration[] }
	| { kind: "unsupported"; version: number; detail: string };

export function planMigration(
	version: number,
	migrations: readonly Migration[] = MIGRATIONS,
	target: number = CURRENT_SCHEMA_VERSION,
): MigrationPlan {
	if (!Number.isInteger(version) || version < 0) {
		return { kind: "unsupported", version, detail: `Unknown schema version ${version}.` };
	}
	if (version === target) return { kind: "current" };
	if (version > target) return { kind: "newer", version };
	const steps: Migration[] = [];
	for (let v = version; v < target; v++) {
		const step = migrations.find((m) => m.from === v);
		if (step === undefined) {
			return { kind: "unsupported", version, detail: `No migration from schema version ${v}.` };
		}
		steps.push(step);
	}
	return { kind: "migrate", from: version, steps };
}

export function runMigrations(raw: Record<string, unknown>, steps: readonly Migration[]): Record<string, unknown> {
	let current = raw;
	for (const step of steps) {
		current = { ...step.migrate(current), schemaVersion: step.from + 1 };
	}
	return current;
}
