import { DomainError } from "../domain/errors";
import { compareSortKeys } from "../domain/sortKey";
import type { ID, OccurrenceRecord, Task } from "../domain/types";
import type { Tx } from "./tx";

// Reads of a command's state that the task and repeat services share.

/** The task, or NotFound when it is gone. */
export function requireTask(tx: Tx, id: ID): Task {
	const t = tx.get("tasks", id);
	if (t === undefined) throw new DomainError("NotFound", "The task no longer exists.");
	return t;
}

/** The records of one task, sorted by date (not by resolution; every engine reader is order-free). */
export function recordsOfTask(tx: Tx, taskId: ID): OccurrenceRecord[] {
	const out: OccurrenceRecord[] = [];
	for (const r of tx.map("occurrenceRecords").values()) if (r.taskId === taskId) out.push(r);
	return out.sort((a, b) => compareSortKeys(a.occurrenceDate, b.occurrenceDate));
}
