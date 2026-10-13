import { Notice, Platform, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { EventBus } from "./app/events";
import { taskListView } from "./app/blockView";
import type { TaskView } from "./app/views";
import { type CheckpointSettings, DEFAULT_SETTINGS, sanitizeSettings } from "./app/settings";
import type { FocusSetConfig } from "./domain/focus";
import { nowInstant, randomId, systemClock } from "./domain/ports";
import type { ID } from "./domain/types";
import { DB_EXTENSION, createEmptyDb } from "./persistence/schema";
import { serializeDb } from "./persistence/serializer";
import { newRevision } from "./persistence/CpbaseStore";
import { type BlockSession, registerDashboardBlock } from "./obsidian/dashboardBlock";
import { FocusHost } from "./obsidian/focusHost";
import { ViewHost } from "./obsidian/host";
import { HabitReminderHost } from "./obsidian/habitReminderHost";
import { deviceId } from "./obsidian/gateways";
import { choose, pickFolder, prompt } from "./obsidian/modals";
import { actionNotice, showError, syncNotice, undoAction } from "./obsidian/notices";
import { openQuickAdd } from "./obsidian/QuickAddModal";
import { DbSession } from "./obsidian/session";
import { CheckpointSettingTab } from "./obsidian/SettingTab";
import { SoundPlayer } from "./obsidian/sound";
import { SystemNotifier } from "./obsidian/systemNotification";
import { CHECKPOINT_VIEW_TYPE, CheckpointView } from "./obsidian/CheckpointView";
import { NOTHING_TO_UNDO } from "./ui/format";
import type { SectionId } from "./ui/host";

export interface PluginEvents {
	/** The active session was opened, replaced or closed. */
	session: undefined;
	/** A vault note changed (modify, create, delete, rename); the payload is its path. */
	note: string;
}

export default class CheckpointPlugin extends Plugin {
	override settings: CheckpointSettings = { ...DEFAULT_SETTINGS };
	deviceId = "";
	session: DbSession | null = null;
	readonly events = new EventBus<PluginEvents>();
	/** The Web Audio player for the focus moments; closed on unload. */
	readonly sound = new SoundPlayer(() => ({ theme: this.settings.soundTheme, volume: this.settings.soundVolume }));
	private readonly notifier = new SystemNotifier();
	private focusHost!: FocusHost;
	/**
	 * Habit reminders for the open database, one per plugin like the focus host. Public for the
	 * e2e spec: `tick()` checks when the device minute changed, `check()` checks at once.
	 */
	readonly reminderHost: HabitReminderHost = this.setupReminderHost();
	private statusBar: HTMLElement | null = null;
	private opening: Promise<void> | null = null;
	/** True while openActiveDatabase is closing the old session or opening the new one. */
	private openingNow = false;
	/** The session being opened, so a rename during open moves its pinned path. */
	private openingSession: DbSession | null = null;
	/** The session being closed by reopen(), so a rename while it closes still reaches it. */
	private closingSession: DbSession | null = null;
	/** Set by onunload: a session that finishes opening afterwards is not kept (it must not sync). */
	private unloaded = false;
	/** Note renames that arrived while no session could take them. */
	private renamesDuringOpen: { oldPath: string; newPath: string; isFolder: boolean }[] = [];

	override async onload(): Promise<void> {
		await this.loadSettings();
		this.deviceId = deviceId(this.app);

		this.registerView(CHECKPOINT_VIEW_TYPE, (leaf) => new CheckpointView(leaf, this));
		this.registerExtensions([DB_EXTENSION], CHECKPOINT_VIEW_TYPE);
		this.registerHoverLinkSource(CHECKPOINT_VIEW_TYPE, { display: "Logwell", defaultMod: true });
		this.addSettingTab(new CheckpointSettingTab(this.app, this));
		this.addRibbonIcon("check-square", "Open Logwell", () => void this.openApp("tasks"));
		this.setupFocusHost();
		this.registerCommands();
		this.registerDashboardBlock();

		this.app.workspace.onLayoutReady(() => {
			this.registerVaultEvents();
			void this.openActiveDatabase().then(() => this.firstRunPrompt());
		});

		// Flush pending saves when the window hides or loses focus.
		this.registerDomEvent(document, "visibilitychange", () => void this.session?.store.flush());
		this.registerDomEvent(window, "blur", () => void this.session?.store.flush());
		// Quitting does not always unload plugins first; Obsidian waits for these tasks.
		// A database being closed or opened by a switch is saved too. What cannot be
		// written is kept as a conflict copy, since no retry runs after the quit.
		this.registerEvent(
			this.app.workspace.on("quit", (tasks) =>
				tasks.add(async () => {
					try {
						this.session?.app.tasks.flushRenames();
					} catch (err) {
						showError(err);
					}
					const sessions = new Set([this.session, this.closingSession, this.openingSession]);
					await Promise.all([...sessions].filter((s) => s !== null).map((s) => s.store.flushBeforeQuit()));
				}),
			),
		);
		this.registerInterval(
			window.setInterval(() => {
				const app = this.session?.app;
				if (app !== undefined) void app.tasks.purgeExpired().then(() => app.recurrence.endExhaustedSeries());
			}, 60 * 60 * 1000),
		);
		// The focus heartbeat. FocusService.tick saves lastHeartbeat every 15 s and detects gaps.
		this.registerInterval(window.setInterval(() => this.focusTick(), 1000));
		// The habit reminder tick. The host only checks when the device minute changed.
		this.registerInterval(window.setInterval(() => this.reminderTick(), 30 * 1000));
	}

	/** The `logwell` code block. Its rows use a host of their own per open session. */
	private registerDashboardBlock(): void {
		const sessions = new WeakMap<DbSession, BlockSession>();
		registerDashboardBlock(this, {
			session: () => {
				const session = this.session;
				if (session === null) return null;
				let block = sessions.get(session);
				if (block === undefined) {
					block = { app: session.app, host: new ViewHost(this, session, null) };
					sessions.set(session, block);
				}
				return block;
			},
			onSession: (listener) => this.events.on("session", listener),
			settings: () => this.settings,
			openTask: (id) => void this.openTask(id),
			openView: (view) => void this.openTasksView(view),
		});
	}

	/** Opens the app on a task: in its list, with its details open. */
	async openTask(id: ID): Promise<void> {
		const task = this.session?.app.store.state.tasks.get(id);
		const view = await this.openApp("tasks");
		if (view === null || task === undefined) return;
		view.showTasks(taskListView(task), id);
	}

	/** Opens the app on a view of the Tasks section, or just opens it for null. */
	async openTasksView(taskView: TaskView | null): Promise<void> {
		const view = await this.openApp("tasks");
		if (view !== null && taskView !== null) view.showTasks(taskView, null);
	}

	/** The 1 s heartbeat. A failure is shown; the service pauses the round, so the next tick does not fail again. */
	private focusTick(): void {
		const focus = this.session?.app.focus;
		if (focus === undefined) return;
		focus.tick().catch((err: unknown) => showError(err));
	}

	/** The 30 s reminder tick; the host reports its own errors, this only guards the interval. */
	private reminderTick(): void {
		try {
			this.reminderHost.tick();
		} catch (err) {
			showError(err);
		}
	}

	override onunload(): void {
		this.unloaded = true;
		const session = this.session;
		this.session = null;
		// A session still opening is closed too; reopen() then does not keep it.
		const opening = this.openingSession;
		if (opening !== null && opening !== session) void opening.close().catch((err: unknown) => showError(err));
		this.focusHost?.detach();
		this.reminderHost.detach();
		this.sound.dispose();
		// A close that fails must not surface as an unhandled rejection.
		void session?.close().catch((err: unknown) => showError(err));
		this.events.clear();
	}

	async loadSettings(): Promise<void> {
		this.settings = sanitizeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** A sync tool changed data.json. */
	override async onExternalSettingsChange(): Promise<void> {
		const before = this.settings.activeDatabasePath;
		await this.loadSettings();
		if (this.settings.activeDatabasePath !== before) await this.openActiveDatabase();
		else this.events.emit("session", undefined);
	}

	/** Opens Settings on this plugin's tab. Obsidian has no public call for it; where the internal one is missing nothing happens. */
	openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
		setting?.open?.();
		setting?.openTabById?.(this.manifest.id);
	}

	async onSettingChanged(key: keyof CheckpointSettings): Promise<void> {
		if (key === "activeDatabasePath") await this.openActiveDatabase();
		else this.events.emit("session", undefined);
	}

	// -- database session ------------------------------------------------------

	/** Opens (or reopens) the active database named in settings. */
	openActiveDatabase(): Promise<void> {
		return this.queueOpen(() => this.reopen());
	}

	/**
	 * Opens the active database if no session is open when this turn comes up
	 * (the file reappeared after a delete). A session opened in the
	 * meantime is left alone.
	 */
	private openIfClosed(): Promise<void> {
		return this.queueOpen(() => this.reopen(), () => this.session === null);
	}

	private queueOpen(body: () => Promise<void>, guard: () => boolean = () => true): Promise<void> {
		const run = async () => {
			// Nothing opens once the plugin is unloaded: no one would close it.
			if (this.unloaded || !guard()) return;
			this.openingNow = true;
			try {
				await body();
			} finally {
				this.openingNow = false;
				this.renamesDuringOpen = [];
			}
		};
		this.opening = (this.opening ?? Promise.resolve()).then(run, run);
		return this.opening;
	}

	private async reopen(): Promise<void> {
		this.focusHost.detach();
		this.reminderHost.detach();
		if (this.session !== null) {
			// The heartbeat must not reach a session that is closing, so it stops pointing at it first.
			const old = this.session;
			this.session = null;
			this.closingSession = old;
			try {
				// The TickTick request in flight finishes first (at most SYNC_CLOSE_WAIT_MS), so what it created is linked.
				// It never keeps the close from running.
				await old.settleSync().catch(() => undefined);
				await old.close();
			} catch (err) {
				// The old database could not be closed cleanly (its pending edits may be
				// lost), but the setting names another one: report it and carry on.
				showError(err);
			} finally {
				// Never keep pointing at a session that is closing or closed.
				this.session = null;
				this.closingSession = null;
				this.events.emit("session", undefined);
			}
		}
		// Unloaded while the old database closed (a switch waits for its sync request): open nothing.
		if (this.unloaded) return;
		const path = this.settings.activeDatabasePath;
		if (path === "") return;
		if (this.app.vault.getFileByPath(path) === null) {
			new Notice(`The active Logwell database was not found: ${path}`);
			return;
		}
		const session = new DbSession(this, path);
		this.openingSession = session;
		try {
			await session.open();
			await this.applyBufferedRenames(session);
			// Unloaded meanwhile: onunload closed this session.
			if (this.unloaded) return;
			this.session = session;
			this.focusHost.attach(session.app.focus, session.focusOpened);
			// Each database keeps its own reminder state; attach runs the catch-up check. The dbId is read
			// on every check, so a placeholder that gets its real header later moves to its key.
			const app = session.app;
			this.reminderHost.attach({
				habits: app.habits,
				settings: app.settings,
				store: app.store,
				reminders: app.reminders,
				dbId: () => session.store.data.meta.dbId,
			});
			// Only a session the plugin keeps syncs.
			session.startSync();
		} catch (err) {
			// Unloaded meanwhile: onunload closed this session, and the rest of its open failing is expected.
			if (!this.unloaded) {
				showError(err);
				// A session the plugin does not keep is closed, saving what its open already wrote.
				await session.close().catch((closeErr: unknown) => showError(closeErr));
			}
		} finally {
			this.openingSession = null;
		}
		this.events.emit("session", undefined);
	}

	/**
	 * Sends a vault rename to the open database, or buffers it while the
	 * database is being (re)opened so it is not lost.
	 */
	forwardRename(oldPath: string, newPath: string, isFolder: boolean): void {
		if (this.session !== null && !this.openingNow) {
			// Exact match for files, prefix rewrite for folders. Idempotent.
			void this.session.app.tasks.rewriteNotePaths(oldPath, newPath, isFolder).catch((err: unknown) => showError(err));
			return;
		}
		if (this.openingNow) this.renamesDuringOpen.push({ oldPath, newPath, isFolder });
	}

	/** Applies, in order, the renames buffered while the database was opening. */
	async applyBufferedRenames(session: DbSession): Promise<void> {
		// Loop until empty: renames can arrive while earlier ones are applied. The
		// caller assigns the session right after, with no await in between.
		while (this.renamesDuringOpen.length > 0) {
			const pending = this.renamesDuringOpen;
			this.renamesDuringOpen = [];
			for (const r of pending) await session.app.tasks.rewriteNotePaths(r.oldPath, r.newPath, r.isFolder);
		}
	}

	async ready(): Promise<DbSession | null> {
		await this.opening;
		return this.session;
	}

	async setActiveDatabase(path: string): Promise<void> {
		this.settings.activeDatabasePath = path;
		await this.saveSettings();
		await this.openActiveDatabase();
	}

	private firstRunPrompt(): void {
		if (this.settings.activeDatabasePath !== "") return;
		actionNotice("Logwell keeps your tasks in a database file. Create one to get started.", [
			{ label: "Create database", run: () => this.createDatabase() },
		]);
	}

	/** "Create database": a new `.cpbase` file in a folder the user chooses. */
	async createDatabase(): Promise<void> {
		const folder = await pickFolder(this.app, "Choose a folder for the new database");
		if (folder === null) return;
		const values = await prompt(this.app, "Create database", [
			{ key: "name", label: "Name", value: "Logwell", placeholder: "Logwell" },
		], "Create");
		const name = values?.name?.trim().replace(/\.cpbase$/i, "");
		if (name === undefined || name === "") return;
		const path = normalizePath(folder.isRoot() ? `${name}.${DB_EXTENSION}` : `${folder.path}/${name}.${DB_EXTENSION}`);
		if (this.app.vault.getAbstractFileByPath(path) !== null) {
			new Notice(`A file already exists at ${path}.`);
			return;
		}
		const now = systemClock.now().toISOString();
		const content = serializeDb(
			createEmptyDb({ dbId: randomId(), revision: newRevision(randomId), deviceId: this.deviceId, now }),
		);
		await this.app.vault.create(path, content);
		await this.setActiveDatabase(path);
		if (!this.settings.syncNoticeShown) {
			syncNotice();
			this.settings.syncNoticeShown = true;
			await this.saveSettings();
		}
		await this.openApp("tasks");
	}

	private noDatabaseNotice(): void {
		actionNotice("No Logwell database is active.", [{ label: "Create database", run: () => this.createDatabase() }]);
	}

	/** Opens the app tab on the active database, or focuses it if open. Returns the view it showed, null when none could be. */
	async openApp(section: SectionId | "today" = "tasks"): Promise<CheckpointView | null> {
		const path = this.settings.activeDatabasePath;
		const file = path === "" ? null : this.app.vault.getFileByPath(path);
		if (file === null) {
			this.noDatabaseNotice();
			return null;
		}
		let leaf = this.app.workspace
			.getLeavesOfType(CHECKPOINT_VIEW_TYPE)
			.find((l) => (l.getViewState().state as { file?: string } | undefined)?.file === path);
		if (leaf === undefined) {
			leaf = this.app.workspace.getLeaf("tab");
			await leaf.openFile(file);
		}
		await this.app.workspace.revealLeaf(leaf);
		await leaf.loadIfDeferred();
		if (!(leaf.view instanceof CheckpointView)) return null;
		leaf.view.showSection(section);
		return leaf.view;
	}

	// -- events ----------------------------------------------------------------

	private registerVaultEvents(): void {
		const { vault } = this.app;
		this.registerEvent(
			vault.on("modify", (file) => {
				if (!(file instanceof TFile)) return;
				if (file.path === this.session?.path) void this.session.store.handleExternalChange();
				// A session still opening reads the change once its open has read the file (the store queues it).
				else if (file.path === this.openingSession?.path) void this.openingSession.store.handleExternalChange();
				else if (file.extension === "md") this.events.emit("note", file.path);
			}),
		);
		this.registerEvent(
			vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile && this.followDatabaseRename(oldPath, file.path)) return;
				// A database file moved onto the active path (a sync tool's
				// temp file, a restore) is opened if nothing is open.
				if (file instanceof TFile && file.path === this.settings.activeDatabasePath) void this.openIfClosed();
				this.forwardRename(oldPath, file.path, file instanceof TFolder);
				this.events.emit("note", oldPath);
				this.events.emit("note", file.path);
			}),
		);
		this.registerEvent(
			vault.on("delete", (file) => {
				// Nothing changes in storage; resolution is computed at runtime.
				if (file.path === this.settings.activeDatabasePath) {
					// The store does not retry a save against a missing file;
					// reopening shows the one "not found" notice.
					void this.openActiveDatabase();
					return;
				}
				this.events.emit("note", file.path);
			}),
		);
		this.registerEvent(
			vault.on("create", (file) => {
				// The active database was deleted and has been recreated.
				if (file instanceof TFile && file.path === this.settings.activeDatabasePath) void this.openIfClosed();
				if (file instanceof TFile && file.extension === DB_EXTENSION && /conflict/i.test(file.basename)) {
					new Notice(`A sync conflict copy of a Logwell database appeared: ${file.path}`);
				}
				this.events.emit("note", file.path);
			}),
		);
	}

	/**
	 * The vault renamed or moved a file. If it is the database, the open session
	 * (and one that is still opening) and the "active database" setting follow it.
	 * A session pinned to another path than the setting, one that is
	 * closing after a switch, moves on its own without touching the setting.
	 */
	private followDatabaseRename(oldPath: string, newPath: string): boolean {
		let followed = false;
		for (const s of [this.session, this.openingSession, this.closingSession]) {
			if (s !== null && s.path === oldPath) {
				s.renamed(newPath);
				followed = true;
			}
		}
		if (this.settings.activeDatabasePath === oldPath) {
			this.settings.activeDatabasePath = newPath;
			void this.saveSettings();
			followed = true;
		}
		if (followed) this.events.emit("session", undefined);
		return followed;
	}

	// -- focus -------------------------------------------------------------------

	private setupFocusHost(): void {
		const bar = Platform.isDesktop ? this.addStatusBarItem() : null;
		if (bar !== null) {
			this.statusBar = bar;
			bar.addClass("mod-clickable", "cp-focus-status");
			bar.setAttribute("role", "button");
			bar.setAttribute("aria-label", "Open focus");
			bar.tabIndex = 0;
			bar.hide();
			const open = () => void this.focusHost.statusClick();
			this.registerDomEvent(bar, "click", open);
			this.registerDomEvent(bar, "keydown", (evt) => {
				if (evt.key !== "Enter" && evt.key !== " ") return;
				evt.preventDefault();
				open();
			});
		}
		this.focusHost = new FocusHost(
			{
				notify: (message) => void new Notice(message),
				actionNotice: (message, actions) => void actionNotice(message, actions),
				systemNotify: (title, body) => this.notifier.notify(title, body),
				requestNotifyPermission: () => this.notifier.requestPermission(),
				choose: (title, message, buttons, cancelLabel, signal) => choose(this.app, title, message, buttons, cancelLabel, signal),
				openFocusPage: async () => void (await this.openApp("focus")),
				setStatus: (text, label) => {
					const el = this.statusBar;
					if (el === null) return;
					if (text === null) {
						el.hide();
						return;
					}
					if (label !== undefined && el.getAttribute("aria-label") !== label) el.setAttribute("aria-label", label);
					if (el.textContent !== text) el.setText(text);
					el.show();
				},
				error: showError,
			},
			this.sound,
			() => nowInstant(systemClock),
		);
	}

	// -- habit reminders ---------------------------------------------------------

	private setupReminderHost(): HabitReminderHost {
		return new HabitReminderHost(
			{
				actionNotice: (message, actions, timeout) => actionNotice(message, actions, timeout),
				systemNotify: (title, body) => this.notifier.notify(title, body, () => void this.openApp("habits")),
				openHabits: (id, focusControl) => void this.openHabits(id, focusControl),
				// `undo` acts on the database the check-in went to (the host binds it).
				notifyUndo: (message, _label, undo) => {
					actionNotice(message, [undoAction(undo)]);
				},
				requestNotifyPermission: () => this.notifier.requestPermission(),
				error: showError,
			},
			systemClock,
		);
	}

	/** The Habits page, with a habit selected when given (a reminder). */
	async openHabits(id: ID | null, focusControl = false): Promise<void> {
		try {
			const view = await this.openApp("habits");
			if (id === null) return;
			view?.showHabit(id, focusControl);
		} catch (err) {
			showError(err);
		}
	}

	/** A user gesture (saving a habit with a reminder on): asks for the notification permission once. */
	reminderGesture(): void {
		this.reminderHost.gesture();
	}

	/** The remembered set values as a config in seconds. */
	focusConfig(): FocusSetConfig {
		const s = this.settings;
		return { rounds: s.focusRounds, focusSec: s.focusMin * 60, breakSec: s.breakMin * 60, longBreakSec: s.longBreakMin * 60 };
	}

	/** A user gesture that starts a set (the Focus page Start button): unlocks sound and asks for notifications. */
	focusGesture(): void {
		this.focusHost.gesture();
	}

	/** Starts focus on a task (or none) with the focus host's prompts, then opens the Focus page. */
	startFocus(taskId: ID | null): Promise<void> {
		return this.withSession(async (s) => {
			const title = taskId === null ? "" : (s.app.store.state.tasks.get(taskId)?.title ?? "");
			await this.focusHost.start(taskId, this.focusConfig(), title);
		});
	}

	/** The open app view on the active database, preferring the one in front. */
	private appView(): CheckpointView | null {
		const active = this.app.workspace.getActiveViewOfType(CheckpointView);
		if (active !== null) return active;
		const path = this.settings.activeDatabasePath;
		for (const leaf of this.app.workspace.getLeavesOfType(CHECKPOINT_VIEW_TYPE)) {
			if (leaf.view instanceof CheckpointView && leaf.view.file?.path === path) return leaf.view;
		}
		return null;
	}

	private registerCommands(): void {
		this.addCommand({ id: "open-focus", name: "Open focus", callback: () => void this.focusHost.statusClick() });
		this.addCommand({
			id: "start-focus",
			name: "Start focus on selected task",
			callback: () => {
				// The selection comes from the app's state; with none there is nothing to start.
				const id = this.appView()?.selectedTaskId() ?? null;
				if (id === null) new Notice("Select a task first.");
				else void this.startFocus(id);
			},
		});
		this.addCommand({
			id: "toggle-focus",
			name: "Pause or resume focus",
			checkCallback: (checking) => {
				const focus = this.session?.app.focus;
				const timer = focus?.timer() ?? null;
				if (focus === undefined || timer === null) return false;
				if (checking) return true;
				if (timer.needsRecovery) void this.focusHost.promptRecovery();
				else void (timer.state === "running" ? focus.pause() : focus.resume()).catch(showError);
				return true;
			},
		});
		this.addCommand({
			id: "stop-focus",
			name: "Stop focus",
			checkCallback: (checking) => {
				const focus = this.session?.app.focus;
				if (focus === undefined || focus.timer() === null) return false;
				if (!checking) void focus.stop().catch(showError);
				return true;
			},
		});
		this.addCommand({
			id: "quick-add-task",
			name: "Quick add task",
			callback: () => void this.withSession((s) => openQuickAdd(this, s)),
		});
		this.addCommand({ id: "open-app", name: "Open app", callback: () => void this.openApp("tasks") });
		this.addCommand({ id: "open-today", name: "Open today", callback: () => void this.openApp("today") });
		this.addCommand({ id: "open-calendar", name: "Open calendar", callback: () => void this.openApp("calendar") });
		this.addCommand({ id: "open-habits", name: "Open habits", callback: () => void this.openApp("habits") });
		this.addCommand({ id: "open-matrix", name: "Open matrix", callback: () => void this.openApp("matrix") });
		this.addCommand({ id: "open-search", name: "Open search", callback: () => void this.openApp("search") });
		this.addCommand({ id: "create-database", name: "Create database", callback: () => void this.createDatabase() });
		// A full pull and push of every linked list, while the sync is on for this device.
		this.addCommand({
			id: "sync-ticktick-now",
			name: "Sync with TickTick now",
			checkCallback: (checking) => {
				const scheduler = this.session?.tickTick;
				if (scheduler === undefined || !scheduler.isActive()) return false;
				if (!checking) void scheduler.syncNow();
				return true;
			},
		});
		this.addCommand({
			id: "undo-last-change",
			name: "Undo last task change",
			callback: () =>
				void this.withSession(async (s) => {
					const label = await s.app.store.undo();
					new Notice(label === null ? NOTHING_TO_UNDO : `Undone: ${label}`);
				}),
		});
	}

	async withSession(fn: (session: DbSession) => void | Promise<void>): Promise<void> {
		const session = await this.ready();
		if (session === null) {
			this.noDatabaseNotice();
			return;
		}
		try {
			await fn(session);
		} catch (err) {
			showError(err);
		}
	}
}
