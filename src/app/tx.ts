import type { Instant } from "../domain/types";
import type { JournalOp } from "../persistence/journal";
import type { CollectionName, DbData, RecordOf } from "../persistence/schema";
import { recordId } from "../persistence/schema";

/** One record change with the values before and after, for undo. */
export interface Change {
	c: CollectionName;
	id: string;
	before: unknown;
	after: unknown;
}

/**
 * A copy-on-write transaction over the immutable state. Services read and
 * write through it; the store commits the result in one step, so a command
 * that touches a parent and its subtasks is one write and one undo.
 */
export class Tx {
	private readonly maps = new Map<CollectionName, Map<string, unknown>>();
	private readonly changes = new Map<string, Change>();

	constructor(
		readonly base: DbData,
		readonly now: Instant,
	) {}

	private view<C extends CollectionName>(c: C): ReadonlyMap<string, RecordOf<C>> {
		return (this.maps.get(c) ?? this.base[c]) as ReadonlyMap<string, RecordOf<C>>;
	}

	private writable(c: CollectionName): Map<string, unknown> {
		let m = this.maps.get(c);
		if (m === undefined) {
			m = new Map(this.base[c] as ReadonlyMap<string, unknown>);
			this.maps.set(c, m);
		}
		return m;
	}

	get<C extends CollectionName>(c: C, id: string): RecordOf<C> | undefined {
		return this.view(c).get(id);
	}

	all<C extends CollectionName>(c: C): RecordOf<C>[] {
		return [...this.view(c).values()];
	}

	map<C extends CollectionName>(c: C): ReadonlyMap<string, RecordOf<C>> {
		return this.view(c);
	}

	private record(c: CollectionName, id: string, after: unknown): void {
		const key = `${c}\u0000${id}`;
		const existing = this.changes.get(key);
		const before = existing === undefined ? (this.base[c] as ReadonlyMap<string, unknown>).get(id) : existing.before;
		this.changes.set(key, { c, id, before, after });
	}

	put<C extends CollectionName>(c: C, record: RecordOf<C>): RecordOf<C> {
		const id = recordId(c, record);
		this.writable(c).set(id, record);
		this.record(c, id, record);
		return record;
	}

	remove(c: CollectionName, id: string): void {
		if (!this.view(c).has(id)) return;
		this.writable(c).delete(id);
		this.record(c, id, undefined);
	}

	finish(): { data: DbData; ops: JournalOp[]; changes: Change[] } {
		const changes = [...this.changes.values()].filter((ch) => ch.before !== ch.after);
		if (changes.length === 0) return { data: this.base, ops: [], changes: [] };
		const data = { ...this.base } as Record<string, unknown>;
		for (const [c, m] of this.maps) data[c] = m;
		return {
			data: data as unknown as DbData,
			ops: changes.map((ch) => ({ c: ch.c, id: ch.id, v: ch.after ?? null })),
			changes,
		};
	}
}
