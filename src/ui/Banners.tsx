import type { ReadOnlyState } from "../persistence/CpbaseStore";

export function Loading() {
	return <div class="cp-empty-state">Loading the database…</div>;
}

/** One active database at a time. */
export function InactiveDatabase(props: { path: string; onMakeActive: () => void }) {
	return (
		<div class="cp-banner cp-banner-info" role="status">
			<p>
				This is not the active database: <code>{props.path}</code>
			</p>
			<button type="button" class="mod-cta" onClick={props.onMakeActive}>
				Make active
			</button>
		</div>
	);
}

/** Read-only banner: a damaged file or a newer schema. */
export function ReadOnlyBanner(props: {
	state: ReadOnlyState;
	onRestore: () => void;
	onOpenConflicts: () => void;
}) {
	const s = props.state;
	if (s.reason === "newer-schema") {
		return (
			<div class="cp-banner cp-banner-warning" role="alert">
				<p>
					This database uses schema version {s.version}, which is newer than this plugin supports. Update the plugin.
					The database is read-only and is never written.
				</p>
			</div>
		);
	}
	return (
		<div class="cp-banner cp-banner-error" role="alert">
			<p>
				Database file is damaged or has a merge conflict ({s.detail}).{" "}
				{s.recoveredFrom !== null
					? "Showing the newest valid backup. Nothing is written until you choose."
					: "No valid backup was found. Nothing is written."}
			</p>
			<div class="cp-banner-actions">
				{s.recoveredFrom !== null && (
					<button type="button" class="mod-cta" onClick={props.onRestore}>
						Restore backup
					</button>
				)}
				<button type="button" onClick={props.onOpenConflicts}>
					Open conflict view
				</button>
			</div>
		</div>
	);
}
