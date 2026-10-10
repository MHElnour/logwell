import { FileView, Scope, type TFile, type WorkspaceLeaf } from "obsidian";
import { h, render } from "preact";
import type CheckpointPlugin from "../main";
import { AppRoot, type AppRootHandle } from "../ui/AppRoot";
import { SectionRelay } from "../ui/sectionRelay";
import { accentClass } from "../ui/accent";
import { ACCENTS } from "../app/settings";
import { ICON } from "../ui/icons";
import { InactiveDatabase, Loading } from "../ui/Banners";
import { routeBoardMove } from "../ui/board/keys";
import { MOVE_ARROWS, routeMatrixMove } from "../ui/matrix/keys";
import { TOGGLE_COMPLETE_EVENT } from "../ui/TaskList";
import type { TaskView } from "../app/views";
import { DB_EXTENSION } from "../persistence/schema";
import type { ID } from "../domain/types";
import type { SectionId } from "../ui/host";
import { ViewHost } from "./host";

export const CHECKPOINT_VIEW_TYPE = "checkpoint-app";

/**
 * The full-page app, bound to `.cpbase` files. The view
 * only renders; all reads and writes go through the plugin's session.
 */
export class CheckpointView extends FileView {
	override allowNoFile = false;
	private root: HTMLElement | null = null;
	private host: ViewHost | null = null;
	private unsubscribe: (() => void) | null = null;
	private readonly sections = new SectionRelay();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: CheckpointPlugin,
	) {
		super(leaf);
		// Obsidian's global Mod+Enter hotkeys (open link in new tab/window/split)
		// consume the key before it reaches the page, so the task row never sees
		// Cmd/Ctrl+Enter. The view's own scope runs first while it is active.
		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "Enter", () => this.toggleFocusedRow());
		// Alt+Arrow moves a matrix card. Obsidian binds Alt+Left/Right to back/forward on Windows and
		// Linux and would take the key first; anywhere else (true) its default still runs. The same keys move a
		// board card: a second handler per key, because the matrix one returns true when the focus is
		// not on its card, so the scope tries the board one next.
		for (const key of MOVE_ARROWS) {
			this.scope.register(["Alt"], key, (evt) => !routeMatrixMove(this.containerEl, evt));
			this.scope.register(["Alt"], key, (evt) => !routeBoardMove(this.containerEl, evt));
		}
	}

	/** Cmd/Ctrl+Enter on a focused task row or board card toggles completion. */
	private toggleFocusedRow(): boolean {
		const focused = this.containerEl.doc.activeElement;
		const row = focused?.instanceOf(HTMLElement) ? focused.closest(".cp-task-row, .cp-board-item") : null;
		if (row === null || row === undefined || !this.containerEl.contains(row)) return true;
		row.dispatchEvent(new CustomEvent(TOGGLE_COMPLETE_EVENT));
		return false;
	}

	override getViewType(): string {
		return CHECKPOINT_VIEW_TYPE;
	}

	override getDisplayText(): string {
		return this.file?.basename ?? "Logwell";
	}

	override getIcon(): string {
		return ICON.railTasks;
	}

	override canAcceptExtension(extension: string): boolean {
		return extension === DB_EXTENSION;
	}

	override async onOpen(): Promise<void> {
		this.unsubscribe = this.plugin.events.on("session", () => this.renderApp());
	}

	private rootEl(): HTMLElement {
		if (this.root === null) {
			this.contentEl.addClass("checkpoint-view");
			this.root = this.contentEl.createDiv({ cls: "checkpoint-root" });
		}
		return this.root;
	}

	/** The accent class lives on the view container, where the design tokens are declared. */
	private applyAccent(): void {
		this.contentEl.removeClasses(ACCENTS.map((a) => `cp-accent-${a}`));
		this.contentEl.addClass(accentClass(this.plugin.settings));
	}

	override async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		await this.plugin.ready();
		this.renderApp();
	}

	override async onUnloadFile(file: TFile): Promise<void> {
		this.unmount();
		await super.onUnloadFile(file);
	}

	override async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.unmount();
	}

	/** The task selected in the section on screen, for the "Start focus on selected task" command. */
	selectedTaskId(): ID | null {
		return this.sections.selectedTaskId();
	}

	/** Shows a section; a request made before the app root has mounted is queued, not dropped. */
	showSection(section: SectionId | "today"): void {
		this.sections.show(section);
	}

	/** Shows a Tasks view with a task selected (a dashboard block opened it); queued like a section when the app root has not mounted. */
	showTasks(view: TaskView, selectedId: ID | null): void {
		this.sections.showTasks(view, selectedId);
	}

	/** Shows the Habits page with a habit selected; queued like a section when the app root has not mounted. */
	showHabit(id: ID, focusControl = false): void {
		this.sections.showHabit(id, focusControl);
	}

	private unmount(): void {
		this.sections.detach();
		if (this.root !== null) render(null, this.root);
		this.host?.dispose();
		this.host = null;
	}

	private renderApp(): void {
		const file = this.file;
		if (file === null) return;
		const root = this.rootEl();
		this.applyAccent();
		const session = this.plugin.session;
		if (file.path !== this.plugin.settings.activeDatabasePath) {
			this.unmount();
			render(
				h(InactiveDatabase, {
					path: file.path,
					onMakeActive: () => void this.plugin.setActiveDatabase(file.path),
				}),
				root,
			);
			return;
		}
		if (session === null) {
			this.unmount();
			render(h(Loading, {}), root);
			return;
		}
		if (this.host?.session !== session) {
			this.unmount();
			this.host = new ViewHost(this.plugin, session, this);
		}
		render(
			h(AppRoot, {
				host: this.host,
				initialSection: this.sections.pending,
				handle: (handle: AppRootHandle) => this.sections.attach(handle),
			}),
			root,
		);
	}
}
