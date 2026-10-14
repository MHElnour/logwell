import type { Clock, IdGenerator } from "../src/domain/ports";
import type { Scheduler, StoreLocalState } from "../src/persistence/CpbaseStore";

/** A test UUID: `prefix` in the first group, `n` in the last. */
export const uuid = (prefix: number, n: number) => `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
/** The id of the n-th seeded task (1-based). */
export const taskId = (n: number) => uuid(0, n);

export class FakeClock implements Clock {
	private t: number;

	constructor(iso = "2026-10-01T10:00:00.000Z") {
		this.t = Date.parse(iso);
	}

	now(): Date {
		return new Date(this.t);
	}

	advance(ms: number): void {
		this.t += ms;
	}

	set(iso: string): void {
		this.t = Date.parse(iso);
	}
}

/**
 * Deterministic UUID-shaped ids: 00000001-0000-4000-8000-000000000001, …
 * The counter is also in the first group, so every id has a distinct prefix and
 * `newRevision` (which keeps the first 12 hex digits) gives distinct revisions.
 */
export function sequentialIds(prefix = ""): IdGenerator {
	let n = 0;
	return () => {
		n++;
		const head = `${prefix}${n.toString(16).padStart(7, "0")}`.slice(-8).padStart(8, "0");
		return `${head}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
	};
}

/** A manual scheduler: timers run only when the test calls runAll/advance. */
export class ManualScheduler implements Scheduler {
	private next = 1;
	readonly timers = new Map<number, { fn: () => void; at: number }>();
	private now = 0;

	set(fn: () => void, ms: number): number {
		const h = this.next++;
		this.timers.set(h, { fn, at: this.now + ms });
		return h;
	}

	clear(handle: number): void {
		this.timers.delete(handle);
	}

	advance(ms: number): void {
		this.now += ms;
		for (const [h, t] of [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
			if (t.at <= this.now && this.timers.has(h)) {
				this.timers.delete(h);
				t.fn();
			}
		}
	}

	get pending(): number {
		return this.timers.size;
	}
}

export class MemoryLocalState implements StoreLocalState {
	lastWritten = new Map<string, string>();
	knownDbId: string | null = null;

	getLastWritten(dbId: string): string | null {
		return this.lastWritten.get(dbId) ?? null;
	}

	setLastWritten(dbId: string, revision: string): void {
		this.lastWritten.set(dbId, revision);
	}

	getKnownDbId(): string | null {
		return this.knownDbId;
	}

	setKnownDbId(dbId: string): void {
		this.knownDbId = dbId;
	}
}

/** Lets 20 rounds of promise jobs run; no timer fires (`settle` in tests/ui/app-helpers.tsx waits for timers and renders). */
export async function drainPromises(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}
