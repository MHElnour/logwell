import { useEffect, useState } from "preact/hooks";
import type { QueryContext } from "../domain/queries";
import { RELOAD_LABEL, REPLACE_ALL_LABEL } from "../app/store";
import type { BackupInfo } from "../persistence/backups";
import { formatInstant } from "./format";
import type { UiHost } from "./host";
import { useUniqueId } from "./hooks";

const KIND_LABELS: Record<BackupInfo["kind"], string> = {
	hourly: "Snapshot",
	daily: "Daily snapshot",
	reload: "After reload",
	"pre-migration": "Before upgrade",
	"pre-repair": "Before repair",
	"pre-import": "Before import",
	"pre-restore": "Before restore",
	"pre-sync": "Before first TickTick sync",
	conflict: "Conflict copy",
};

/**
 * Data section: export, import, backups and conflicts.
 * Backups are listed when the section opens and after an action in it (restore, export, import, Keep mine, Keep
 * theirs) and when a status, reload or restore event says the files changed, not on every store change: listing reads
 * the backup files, so an edit, a focus round or a check-in made elsewhere in the app does not repeat it. A snapshot
 * taken while the section stays open shows when it is opened again.
 */
export function DataSection({ host, ctx, visible }: { host: UiHost; ctx: QueryContext; visible: boolean }) {
	const store = host.app.store;
	const [snapshots, setSnapshots] = useState<BackupInfo[]>([]);
	const [conflicts, setConflicts] = useState<BackupInfo[]>([]);
	const [version, setVersion] = useState(0);
	const readOnly = store.readOnlyState !== null;
	const exportHintId = useUniqueId("cp-export-hint");

	useEffect(() => {
		if (!visible) return;
		let cancelled = false;
		void Promise.all([store.host.listSnapshots(), store.host.listConflicts()]).then(([s, c]) => {
			if (cancelled) return;
			setSnapshots(s);
			setConflicts(c);
		});
		return () => {
			cancelled = true;
		};
	}, [store, version, visible]);

	const refresh = () => setVersion((v) => v + 1);

	// Changes made outside the section while it is open: a damaged file or an incoming conflict (status), a reload or a
	// restore or a resolved conflict from a notice (a reload or replacement, never an ordinary edit).
	useEffect(() => {
		if (!visible) return;
		const bump = () => setVersion((v) => v + 1);
		const offStatus = store.bus.on("status", bump);
		const offChanged = store.bus.on("changed", (e) => {
			if (e.label === RELOAD_LABEL || e.label === REPLACE_ALL_LABEL) bump();
		});
		return () => {
			offStatus();
			offChanged();
		};
	}, [store, visible]);
	const run = async (fn: () => Promise<void>) => {
		try {
			await fn();
		} catch (err) {
			host.error(err);
		}
		refresh();
	};

	const restore = (b: BackupInfo) =>
		run(async () => {
			const ok = await host.choose(
				"Restore backup",
				`Replace all records with the ${KIND_LABELS[b.kind].toLowerCase()} from ${formatInstant(b.writtenAt, ctx.zone)}? The current state is backed up first.`,
				[{ label: "Restore", value: true, warning: true }],
			);
			if (ok !== true) return;
			await store.restoreSnapshot(b.path);
			host.notify("Backup restored.");
		});

	const keep = (b: BackupInfo, which: "mine" | "theirs") =>
		run(async () => {
			if (which === "mine") {
				await store.keepMine(b.path);
				host.notify("Your version was restored on top of the current one.");
			} else {
				await store.keepTheirs(b.path);
				host.notify("Kept the current version. The copy was moved to resolved.");
			}
		});

	const s = store.readOnlyState;
	return (
		<main class="cp-main cp-data">
			<header class="cp-main-header">
				<h2 class="cp-main-title">Data</h2>
			</header>

			<section class="cp-data-section">
				<h3>Backup and export</h3>
				<p class="cp-hint">
					Export the whole database as one JSON file, or import a backup made by this plugin. Import shows a preview
					first.
				</p>
				<p class="cp-hint">One CSV file per entity (tasks, lists, sections, tags, occurrences, focus sessions, habits, check-ins) in a new folder in your vault.</p>
				<div class="cp-data-actions">
					<button
						type="button"
						disabled={readOnly}
						aria-describedby={readOnly ? exportHintId : undefined}
						onClick={() => void run(() => host.exportBackup())}
					>
						Export backup
					</button>
					{/* The same rules as the backup export; the host writes the files. */}
					<button
						type="button"
						disabled={readOnly}
						aria-describedby={readOnly ? exportHintId : undefined}
						onClick={() => void run(() => host.exportCsv())}
					>
						Export CSV
					</button>
					<button type="button" disabled={readOnly} onClick={() => void run(() => host.importBackup())}>
						Import backup
					</button>
				</div>
				{readOnly && (
					<p id={exportHintId} class="cp-hint">
						Export and import are unavailable while the database is read-only, because the app may be showing a
						recovered or partial copy. Resolve the problem in the banner first.
					</p>
				)}
			</section>

			<section class="cp-data-section">
				<h3>Conflicts</h3>
				{s?.reason === "damaged" && (
					<p class="cp-hint">
						The database file cannot be read ({s.detail}). A copy of the damaged file is listed below.
						{s.recoveredFrom !== null && " The app shows the newest valid backup; use “Restore backup” in the banner to write it."}
					</p>
				)}
				{conflicts.length === 0 ? (
					<p class="cp-hint">No open conflicts.</p>
				) : (
					<ul class="cp-backup-list">
						{conflicts.map((c) => (
							<li key={c.path}>
								<div>
									<div>{c.revision === "" ? "Damaged file copy" : `Conflict copy ${c.revision}`}</div>
									<div class="cp-hint">{c.writtenAt === "" ? c.stamp : formatInstant(c.writtenAt, ctx.zone)}</div>
								</div>
								{c.revision !== "" && (
									<button type="button" disabled={readOnly} onClick={() => void keep(c, "mine")}>
										Keep mine
									</button>
								)}
								<button type="button" onClick={() => void keep(c, "theirs")}>
									{c.revision === "" ? "Dismiss" : "Keep theirs"}
								</button>
							</li>
						))}
					</ul>
				)}
			</section>

			<section class="cp-data-section">
				<h3>Backups</h3>
				<p class="cp-hint">
					Snapshots are kept in the plugin folder on this device: one at session start, then hourly while you make
					changes, plus one per day for 14 days.
				</p>
				{snapshots.length === 0 ? (
					<p class="cp-hint">No backups yet.</p>
				) : (
					<ul class="cp-backup-list">
						{snapshots.map((b) => (
							<li key={b.path}>
								<div>
									<div>{KIND_LABELS[b.kind]}</div>
									<div class="cp-hint">{b.writtenAt === "" ? b.stamp : formatInstant(b.writtenAt, ctx.zone)}</div>
								</div>
								<button type="button" disabled={readOnly} onClick={() => void restore(b)}>
									Restore
								</button>
							</li>
						))}
					</ul>
				)}
			</section>
		</main>
	);
}
