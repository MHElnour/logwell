import { TRASH_RETENTION_DAYS } from "../app/settings";
import type { QueryContext } from "../domain/queries";
import type { DbData } from "../persistence/schema";
import { EmptyState } from "./common";
import { ICON } from "./icons";
import { formatInstant } from "./format";
import type { UiHost } from "./host";

/** Trash: batches with restore and permanent delete. */
export function TrashList({ host, state, ctx }: { host: UiHost; state: DbData; ctx: QueryContext }) {
	const entries = [...state.trash.values()].sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
	const restore = async (batchId: string) => {
		try {
			const n = await host.app.tasks.restore(batchId);
			host.notify(`Restored ${n} task${n === 1 ? "" : "s"}.`);
		} catch (err) {
			host.error(err);
		}
	};
	const purge = async (batchId: string, title: string) => {
		const ok = await host.choose(
			"Delete permanently",
			`Delete "${title}" permanently? Linked notes are not touched.`,
			[{ label: "Delete permanently", value: true, warning: true }],
		);
		if (ok === true) await host.app.tasks.purge(batchId).catch((err: unknown) => host.error(err));
	};
	const empty = async () => {
		const ok = await host.choose(
			"Empty trash",
			`Delete all ${entries.length} trash entries permanently? Linked notes are not touched.`,
			[{ label: "Empty trash", value: true, warning: true }],
		);
		if (ok === true) await host.app.tasks.emptyTrash().catch((err: unknown) => host.error(err));
	};
	if (entries.length === 0) return <EmptyState host={host} icon={ICON.trash} text="Trash is empty." />;
	return (
		<div class="cp-trash">
			<p class="cp-hint">
				Deleted tasks stay here for {TRASH_RETENTION_DAYS} days. Description notes are never deleted.{" "}
				<button type="button" class="cp-link-button" onClick={() => void empty()}>
					Empty trash
				</button>
			</p>
			<ul class="cp-trash-list">
				{entries.map((e) => {
					const [first, ...subs] = e.tasks;
					const title = first?.title ?? "";
					return (
						<li key={e.batchId} class="cp-trash-entry">
							<div class="cp-trash-text">
								<div class="cp-task-title">{title}</div>
								<div class="cp-hint">
									Deleted {formatInstant(e.deletedAt, ctx.zone)}
									{subs.length > 0 && ` · with ${subs.length} subtask${subs.length === 1 ? "" : "s"}`}
								</div>
							</div>
							<button type="button" onClick={() => void restore(e.batchId)}>
								Restore
							</button>
							<button type="button" class="mod-warning" onClick={() => void purge(e.batchId, title)}>
								Delete permanently
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
