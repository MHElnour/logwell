import { Notice, normalizePath } from "obsidian";
import { CheckpointApp } from "../app/App";
import type { OpenResult } from "../app/FocusService";
import type { TickTickApi } from "../app/ports";
import { SyncService } from "../app/SyncService";
import { type SyncFailure } from "../app/syncModel";
import { displayZone } from "../app/settings";
import { DomainError, isDomainError } from "../domain/errors";
import { joinPath } from "../domain/notes";
import { randomId, systemClock } from "../domain/ports";
import { BackupStore, dbBackupRoot } from "../persistence/backups";
import { CpbaseStore, type StoreEvent } from "../persistence/CpbaseStore";
import { storableDbId } from "../persistence/schema";
import { accentClass } from "../ui/accent";
import type CheckpointPlugin from "../main";
import { LocalStorageActiveTimer } from "./activeTimer";
import { AdapterGateway, LocalStorageState, VaultDbFile, VaultNotes } from "./gateways";
import { actionNotice, plainNotice, showError } from "./notices";
import { undoNotice } from "./undoNotice";
import { LocalStorageReminderState } from "./reminderState";
import { LocalStorageRenameQueue } from "./renameQueue";
import { TICKTICK_TIMEOUT_MS, TickTickHttp } from "./tickTickHttp";
import { ConfirmationPrompter, type LinkFlowDeps, linkListFlow, unlinkListFlow } from "./tickTickFlow";
import { LocalStorageTickTickDevice, LocalStorageTickTickPending, SecretStorageTickTickSecret } from "./tickTickPorts";
import { askMissing, pickLinkOption, showFirstSyncPreview } from "./tickTickDialogs";
import { TickTickScheduler } from "./tickTickScheduler";

/**
 * How long a database switch waits for the TickTick request in flight before it closes anyway. Longer than
 * the request timeout, so the request in flight has answered or failed by then and an answered create is linked.
 */
export const SYNC_CLOSE_WAIT_MS = TICKTICK_TIMEOUT_MS + 1_000;

/** The main window's timers: they live as long as the plugin, and `close()` clears what is pending. */
const windowTimers = {
	set: (fn: () => void, ms: number): number => window.setTimeout(fn, ms),
	clear: (handle: number): void => window.clearTimeout(handle),
};

/** The open active database: persistence store plus app services. */
export class DbSession {
	readonly store: CpbaseStore;
	readonly app: CheckpointApp;
	/**
	 * The TickTick sync engine. Always there, so the bookkeeping of a removed linked task is written whichever
	 * device syncs; it makes no request unless `tickTick` (or a sync action) calls it.
	 */
	readonly sync: SyncService;
	/**
	 * The TickTick client the link dialog reads the project list through (and creates a project with). The same
	 * client as the sync's, so it has the same token and timeout.
	 */
	readonly tickTickApi: TickTickApi;
	/** When the sync runs on this device. Started when the database is open. */
	readonly tickTick: TickTickScheduler;
	private stopSessionEvents: (() => void) | null = null;

	/**
	 * The database file this session reads and writes. Pinned when the session is
	 * created, so changing the "active database" setting never redirects a pending
	 * save of this session to another file. Only `renamed` moves it.
	 */
	private dbPath: string;
	private closing = false;
	/** What `focus.open` found when the session opened; the plugin hands it to the focus host. */
	focusOpened: OpenResult = "none";
	/** The plugin's `backups` folder; each database has its own subfolder. */
	private readonly backupRoot: string;
	/** Conflict copies already announced because the session was closing: one notice each. */
	private readonly announcedCopies = new Set<string>();

	constructor(
		private readonly plugin: CheckpointPlugin,
		path: string = plugin.settings.activeDatabasePath,
	) {
		this.dbPath = path;
		const obsidian = plugin.app;
		const pinned = () => this.dbPath;
		const backupRoot = normalizePath(joinPath(plugin.manifest.dir ?? joinPath(obsidian.vault.configDir, `plugins/${plugin.manifest.id}`), "backups"));
		this.backupRoot = backupRoot;
		const adapter = new AdapterGateway(obsidian.vault.adapter);
		this.store = new CpbaseStore({
			file: new VaultDbFile(obsidian, pinned),
			backupsFor: (dbId) => new BackupStore(adapter, dbBackupRoot(backupRoot, dbId), systemClock),
			clock: systemClock,
			ids: randomId,
			deviceId: plugin.deviceId,
			local: new LocalStorageState(obsidian, pinned),
			scheduler: windowTimers,
			onEvent: (e) => this.onStoreEvent(e),
		});
		this.app = new CheckpointApp(
			this.store,
			systemClock,
			randomId,
			{
				zone: () => displayZone(plugin.settings),
				noteFolder: () => plugin.settings.noteFolder,
				upcomingDays: () => plugin.settings.upcomingDays,
				weekStart: () => plugin.settings.weekStart,
				eveningTime: () => plugin.settings.eveningTime,
			},
			new VaultNotes(obsidian),
			new LocalStorageRenameQueue(obsidian),
			new LocalStorageActiveTimer(obsidian),
			{ deviceId: () => plugin.deviceId, discardShortFocus: () => plugin.settings.discardShortFocus },
			new LocalStorageReminderState(obsidian),
			new SecretStorageTickTickSecret(obsidian, () => plugin.settings.tickTickSecretId),
			// No database id until the store is open: the switch then reads off and setEnabled does nothing.
			new LocalStorageTickTickDevice(obsidian, () =>
				this.store.isLoaded ? storableDbId(this.store.data.meta.dbId, this.store.readOnlyState !== null) : null,
			),
		);
		const app = this.app;
		// A listener that throws is shown as an error; the change and the other listeners go on.
		app.store.bus.onListenerError = showError;
		app.focus.bus.onListenerError = showError;
		// A command that leaves a record pointing at one that is gone is saved and reported (`referenceMode` "report").
		app.store.onReferenceProblem = (label, problems) => {
			console.warn(`Logwell: "${label}" left ${problems.length} broken link(s)`, problems.map(({ rule, id, target }) => `${rule.from}.${rule.field} ${id} -> ${target}`));
			showError(new DomainError("ReferenceConflict", `"${label}" was saved with a broken link: ${problems[0]?.message ?? ""}`));
		};
		this.tickTickApi = new TickTickHttp(app.tickTickSecret);
		this.sync = new SyncService(
			app.store,
			app.tasks,
			app.sections,
			app.settings,
			this.tickTickApi,
			{
				port: app.notes,
				enabled: () => plugin.settings.tickTickNotes,
				folder: () => plugin.settings.noteFolder,
			},
			new LocalStorageTickTickPending(obsidian),
		);
		this.tickTick = new TickTickScheduler({
			store: app.store,
			sync: this.sync,
			device: app.tickTickDevice,
			secret: app.tickTickSecret,
			pullMinutes: () => plugin.settings.tickTickPullMinutes,
			timers: windowTimers,
			now: () => systemClock.now().getTime(),
			notify: plainNotice,
			notifyFailure: (failure, text) => this.notifyFailure(failure, text),
			error: showError,
		});
	}

	/**
	 * A failure notice; a refused token offers the settings, the free plan's list limit offers Sync now, a TickTick list
	 * that no longer exists offers Unlink.
	 */
	private notifyFailure(failure: SyncFailure, text: string): void {
		const listId = failure.listId;
		if (failure.kind === "unauthorized") {
			actionNotice(`${text}. Replace it in Settings > Logwell.`, [{ label: "Open settings", run: () => this.plugin.openSettings() }]);
		} else if (failure.kind === "list-limit") {
			actionNotice(text, [{ label: "Sync now", run: () => void this.tickTick.syncNow() }]);
		} else if (failure.kind === "list-gone" && listId !== null) {
			actionNotice(text, [{ label: "Unlink", run: () => void this.unlinkFromTickTick(listId) }]);
		} else {
			new Notice(text);
		}
	}

	/** A token is chosen and set, and the switch for this device is on. */
	tickTickReady(): boolean {
		return this.app.tickTickSecret.get() !== null && this.app.tickTickDevice.isEnabled();
	}

	/** Projects the link dialog created whose first sync did not link the list; a retry reuses them. */
	private readonly createdProjects = new Map<string, { projectId: string; name: string }>();

	private linkDeps(): LinkFlowDeps {
		const accent = accentClass(this.plugin.settings);
		return {
			state: () => this.app.store.state,
			ready: () => this.tickTickReady(),
			api: this.tickTickApi,
			sync: this.sync,
			index: this.app.tasks.lists,
			pick: (deps) => pickLinkOption(this.plugin.app, deps, accent),
			preview: (deps) => showFirstSyncPreview(this.plugin.app, deps, accent),
			notify: plainNotice,
			error: showError,
			created: this.createdProjects,
			linked: (result) => {
				if (result !== null) this.tickTick.recordSync(result);
				this.tickTick.refresh();
			},
		};
	}

	/** Screens 5 and 6 for one list (the list menu's "Sync with TickTick…"). */
	linkWithTickTick(listId: string): Promise<void> {
		return this.closing ? Promise.resolve() : linkListFlow(this.linkDeps(), listId);
	}

	/** Unlinks one list; every task stays on both sides. */
	unlinkFromTickTick(listId: string): Promise<void> {
		return unlinkListFlow(this.linkDeps(), listId);
	}

	get path(): string {
		return this.dbPath;
	}

	/** The vault renamed or moved the open database file. */
	renamed(newPath: string): void {
		this.dbPath = newPath;
	}

	async open(): Promise<void> {
		await this.store.open();
		this.focusOpened = await this.app.focus.open();
		await this.app.noteRenames.resumeRenames();
		await this.app.tasks.purgeExpired();
		await this.app.recurrence.endExhaustedSeries();
	}

	/**
	 * The hourly Trash purge and end-of-series sweep. Never rejects. A refusal because the file turned
	 * read-only after the check waits for the next hour, as a read-only file does before it; any other
	 * failure is shown.
	 */
	async hourlyCleanup(): Promise<void> {
		try {
			await this.app.tasks.purgeExpired();
			await this.app.recurrence.endExhaustedSeries();
		} catch (err) {
			if (!isDomainError(err, "ReadOnly")) showError(err, "Could not purge the Trash or end finished repeats");
		}
	}

	/**
	 * Starts the TickTick schedule, with the pull "when Obsidian opens". The plugin calls it once it keeps
	 * this session as the open one, so a session still opening at unload, or one whose open failed, never syncs. A
	 * setting changed (the plugin emits "session"): the pull interval may differ.
	 */
	startSync(): void {
		if (this.closing) return;
		this.tickTick.start();
		if (this.stopSessionEvents !== null) return;
		const stopSession = this.plugin.events.on("session", () => this.tickTick.refresh());
		// An edit of a note the sync created goes up like a task edit.
		const stopNotes = this.plugin.events.on("note", (path) => {
			if (this.sync.isSyncNoteEdit(path)) this.tickTick.noteEdited();
		});
		this.stopSessionEvents = () => {
			stopSession();
			stopNotes();
		};
		// The tasks a pull would move to Trash wait for Move to Trash or Keep.
		const prompter = new ConfirmationPrompter({
			state: () => this.app.store.state,
			sync: this.sync,
			ask: (pending, listName) => (this.closing ? Promise.resolve(null) : askMissing(this.plugin.app, { pending, listName }, accentClass(this.plugin.settings))),
			undoMark: () => this.app.store.undoMark(),
			notifyUndo: (message, label, mark) => void undoNotice(this.app.store, message, label, mark),
			notify: plainNotice,
			error: showError,
		});
		this.tickTick.events.on("confirmations", (pending) => prompter.handle(pending));
	}

	/**
	 * Before a database switch: stops the TickTick sync (no new sync, no further request) and waits, at most
	 * `SYNC_CLOSE_WAIT_MS`, for the request in flight, so a create TickTick answered is linked before the store closes.
	 * Returns at once when no sync runs. Plugin unload does not call it: closing stays synchronous there.
	 */
	async settleSync(): Promise<void> {
		this.stopSync();
		if (!this.sync.busy) return;
		let timer: number | undefined;
		const limit = new Promise<void>((resolve) => {
			timer = window.setTimeout(resolve, SYNC_CLOSE_WAIT_MS);
		});
		try {
			await Promise.race([this.sync.idle(), limit]);
		} finally {
			window.clearTimeout(timer);
		}
	}

	private syncStopped = false;

	private stopSync(): void {
		if (this.syncStopped) return;
		this.syncStopped = true;
		this.tickTick.dispose();
		this.stopSessionEvents?.();
		this.stopSessionEvents = null;
		this.sync.stop();
	}

	async close(): Promise<void> {
		this.closing = true;
		// No sync starts and no TickTick request goes out any more. A sync in flight is not awaited here (a
		// switch waits for it first, `settleSync`): if TickTick answers a create after the store closed, its link cannot
		// be written and the next session imports that task once more. Accepted: at most the one request in flight.
		this.stopSync();
		try {
			// New ticks stop at once; a tick or commit already writing finishes before the store closes.
			// Only await when one is running: closing must stay synchronous otherwise (see FocusService.close).
			const writing = this.app.focus.close();
			if (writing !== null) await writing;
			// Renames held back by the rename queue go out first. A failure here
			// (local storage full or unavailable) must never keep the store open.
			try {
				this.app.noteRenames.flushRenames();
			} catch (err) {
				actionNotice(
					`Could not save the queued note renames for ${this.dbPath}: ${err instanceof Error ? err.message : String(err)} Links to notes renamed just now may need to be relinked.`,
					[],
				);
			}
			await this.store.close();
		} finally {
			// Even when the store fails to close, nothing may keep listening to it.
			this.app.store.bus.clear();
		}
	}

	private onStoreEvent(e: StoreEvent): void {
		switch (e.type) {
			case "loaded":
				// A replacement (import, restore, Keep mine, Restore backup) runs through the app store, which announces
				// it once itself; only a change from outside the file is announced here.
				if (e.cause === "external") this.app.store.notifyReloaded();
				break;
			case "read-only":
				this.app.store.notifyStatus();
				if (e.state.reason === "damaged") {
					const actions = [
						{ label: "Open conflict view", run: () => this.openConflictView() },
					];
					if (e.state.recoveredFrom !== null) {
						actions.unshift({ label: "Restore backup", run: () => this.restoreRecovered() });
					}
					actionNotice(
						"Database file is damaged or has a merge conflict. It is read-only; nothing is written until you choose.",
						actions,
						0,
					);
				} else {
					actionNotice(
						`This database uses schema version ${e.state.version}, which is newer than this plugin supports. Update the plugin. The database stays read-only.`,
						[],
						0,
					);
				}
				break;
			case "writable":
				this.app.store.notifyStatus();
				break;
			case "conflict":
				this.app.store.notifyStatus();
				if (this.closing) {
					// Nothing is loaded and nothing can be resolved here: point at the copy.
					this.announceClosingCopy(e.path);
					break;
				}
				actionNotice(
					"The database changed outside Obsidian while this device had other changes. The other version is now loaded; yours was kept as a conflict copy.",
					[
						{ label: "Keep mine", run: () => this.resolveConflict(e.path, "mine") },
						{ label: "Keep theirs", run: () => this.resolveConflict(e.path, "theirs") },
					],
					0,
				);
				break;
			case "pending-saved-as-conflict":
				this.announceClosingCopy(e.path);
				break;
			case "lost-revision":
				this.app.store.notifyStatus();
				actionNotice(
					e.path === null
						? "Changes this device saved earlier are missing from the database file, and no backup of them was found."
						: "Changes this device saved earlier are missing from the database file. They were restored as a conflict copy.",
					e.path === null ? [] : [{ label: "Open conflict view", run: () => this.openConflictView() }],
					0,
				);
				break;
			case "repaired":
				actionNotice(`Some database records were repaired: ${e.issues.slice(0, 3).join(" ")}${e.issues.length > 3 ? " …" : ""}`, []);
				break;
			case "noticed":
				actionNotice(`Some database records need your attention: ${e.notes.slice(0, 3).join(" ")}${e.notes.length > 3 ? " …" : ""}`, []);
				break;
			case "migrated":
				actionNotice(`The database was upgraded from schema ${e.from} to ${e.to}. A backup was taken first.`, []);
				break;
			case "backup-error":
				// Only the backup failed: the database file is as saved, so no save is retried.
				actionNotice(`A backup of the database could not be written: ${e.message} The database file is not affected; the next save tries the backup again.`, []);
				break;
			case "save-error":
				// A closing store makes no further attempt, so never promise one.
				actionNotice(`Could not save the database: ${e.message}${this.closing ? "" : " Retrying."}`, []);
				break;
			case "edits-lost":
				actionNotice(
					`Unsaved changes to ${this.dbPath} could not be kept and are lost: ${e.message}`,
					[],
					0,
				);
				break;
			case "saved":
				break;
		}
	}

	/**
	 * Edits that could not be saved when the session closed (a database switch, the
	 * file deleted, another device's save that landed first) are kept as a conflict
	 * copy. Say so once, and offer the conflict view.
	 */
	private announceClosingCopy(copyPath: string): void {
		if (this.announcedCopies.has(copyPath)) return;
		this.announcedCopies.add(copyPath);
		actionNotice(
			`Changes made to ${this.dbPath} just before it closed could not be saved to the file. They were kept as a conflict copy.`,
			[{ label: "Open conflict view", run: () => this.openConflictView() }],
			0,
		);
	}

	/**
	 * Shows this database's conflict copies. A closed session is no longer the
	 * active one, so its database is made active again first, if the file exists.
	 */
	async openConflictView(): Promise<void> {
		const { plugin } = this;
		// Only a closed session can be reported as gone. The plugin's current session
		// may have a file that is missing for a moment (a sync tool rewriting it), so it
		// keeps the plain behavior: its own Data view.
		if (plugin.session !== this && plugin.app.vault.getFileByPath(this.dbPath) === null) {
			// The database is gone, so there is no conflict view to show for it, and
			// opening the Data view of another database would be misleading.
			const where = joinPath(dbBackupRoot(this.backupRoot, this.store.data.meta.dbId), "conflicts");
			actionNotice(
				`${this.dbPath} was not found. Its conflict copies are kept in ${where}. They show in the conflict view once the database file is back.`,
				[],
				0,
			);
			return;
		}
		if (plugin.settings.activeDatabasePath !== this.dbPath) await plugin.setActiveDatabase(this.dbPath);
		await plugin.openApp("data");
	}

	// Notice actions go through AppStore so they run on the command queue.
	restoreRecovered(): Promise<void> {
		return this.app.store.restoreRecovered();
	}

	resolveConflict(path: string, keep: "mine" | "theirs"): Promise<void> {
		return keep === "mine" ? this.app.store.keepMine(path) : this.app.store.keepTheirs(path);
	}
}
