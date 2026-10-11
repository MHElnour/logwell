import { categoryText } from "../ui/icons";
import { Component, Keymap, MarkdownRenderer, Menu, Notice, TFile, normalizePath, setIcon } from "obsidian";
import { exportFileName, exportFolderName } from "../app/DataService";
import type { CheckpointApp } from "../app/App";
import type { CheckpointSettings } from "../app/settings";
import { isDomainError } from "../domain/errors";
import type { FocusSetConfig } from "../domain/focus";
import { isOpen } from "../domain/tasks";
import type { ID } from "../domain/types";
import type CheckpointPlugin from "../main";
import type { SpanDecision } from "../parsing";
import type { ButtonSpec, HabitDialogOptions, MenuSpec, NewListOptions, QuickAddPreset, SectionId, TagDialogOptions, TickTickUi, UiHost } from "../ui/host";
import type { CheckpointView } from "./CheckpointView";
import { CHECKPOINT_VIEW_TYPE } from "./CheckpointView";
import { habitDialog } from "./habitDialog";
import { tagDialog } from "./tagDialog";
import { showImportPreview } from "./ImportModal";
import { type PromptField, choose, newListDialog, pick, pickFolder, pickJsonFile, pickListIcon, pickNote, prompt } from "./modals";
import { accentClass } from "../ui/accent";
import { showError } from "./notices";
import { undoNotice } from "./undoNotice";
import { resolveNoteLinks } from "./noteLinks";
import { openQuickAdd } from "./QuickAddModal";
import type { DbSession } from "./session";
import { attachTokenSuggest } from "./suggest";

/** The Obsidian side of the UI contract, one per open app view. */
export class ViewHost implements UiHost {
	private disposers: (() => void)[] = [];
	private renderSeq = 0;

	constructor(
		private readonly plugin: CheckpointPlugin,
		readonly session: DbSession,
		/** The app tab this host serves; null for the host a dashboard block's rows use (no note pane, no sections of its own). */
		private readonly view: CheckpointView | null,
	) {}

	readonly tickTick: TickTickUi = {
		ready: () => this.session.tickTickReady(),
		link: (listId) => this.session.linkWithTickTick(listId),
		unlink: (listId) => this.session.unlinkFromTickTick(listId),
		lastSyncAt: () => this.session.tickTick.status().lastSyncAt,
		onStatus: (listener) => this.session.tickTick.events.on("status", () => listener()),
	};

	get app(): CheckpointApp {
		return this.session.app;
	}

	readonly openSection = (section: SectionId): void => {
		if (this.view === null) void this.plugin.openApp(section);
		else this.view.showSection(section);
	};

	settings(): CheckpointSettings {
		return this.plugin.settings;
	}

	/** The running-timer prompts live in the focus host; the Focus page opens after. */
	startFocus(taskId: ID | null): Promise<void> {
		return this.plugin.startFocus(taskId);
	}

	focusGesture(): void {
		this.plugin.focusGesture();
	}

	focusConfig(): FocusSetConfig {
		return this.plugin.focusConfig();
	}

	async setFocusConfig(config: FocusSetConfig): Promise<void> {
		const s = this.plugin.settings;
		s.focusRounds = config.rounds;
		s.focusMin = Math.round(config.focusSec / 60);
		s.breakMin = Math.round(config.breakSec / 60);
		s.longBreakMin = Math.round(config.longBreakSec / 60);
		await this.plugin.saveSettings();
	}

	notify(message: string): void {
		new Notice(message);
	}

	error(err: unknown): void {
		showError(err);
	}

	notifyUndo(message: string, label: string, mark: number): void {
		undoNotice(this.app.store, message, label, mark);
	}

	choose<T>(title: string, message: string, buttons: ButtonSpec<T>[]): Promise<T | null> {
		return choose(this.plugin.app, title, message, buttons);
	}

	prompt(
		title: string,
		fields: PromptField[],
		submit?: string,
	): Promise<Record<string, string> | null> {
		return prompt(this.plugin.app, title, fields, submit);
	}

	showMenu(evt: MouseEvent | { x: number; y: number }, items: MenuSpec, onClose?: () => void): void {
		const menu = new Menu();
		if (onClose !== undefined) menu.onHide(onClose);
		for (const item of items) {
			if (item === "separator") {
				menu.addSeparator();
				continue;
			}
			menu.addItem((mi) => {
				mi.setTitle(item.title).onClick(() => item.run());
				if (item.icon !== undefined) mi.setIcon(item.icon);
				if (item.checked !== undefined) mi.setChecked(item.checked);
				if (item.warning === true) mi.setWarning(true);
				if (item.disabled === true) mi.setDisabled(true);
			});
		}
		if ("button" in evt) menu.showAtMouseEvent(evt);
		else menu.showAtPosition(evt);
	}

	async pickNote(): Promise<string | null> {
		return (await pickNote(this.plugin.app))?.path ?? null;
	}

	async pickTask(exclude: ID): Promise<ID | null> {
		const state = this.app.store.state;
		const candidates = [...state.tasks.values()]
			.filter((t) => t.id !== exclude && t.parentId === null && isOpen(t))
			.sort((a, b) => a.title.localeCompare(b.title));
		const chosen = await pick(this.plugin.app, candidates, (t) => t.title, "Choose the parent task");
		return chosen?.id ?? null;
	}

	async pickCategory(): Promise<ID | null> {
		const chosen = await pick(
			this.plugin.app,
			this.app.categories.list(),
			(c) => categoryText(c),
			"Move to list",
		);
		return chosen?.id ?? null;
	}

	pickIcon(current: string | null): Promise<string | null | undefined> {
		return pickListIcon(this.plugin.app, current, accentClass(this.plugin.settings));
	}

	newList(options: NewListOptions): Promise<void> {
		return newListDialog(this.plugin.app, options, accentClass(this.plugin.settings));
	}

	habitDialog(options: HabitDialogOptions): Promise<void> {
		return habitDialog(this.plugin.app, options, accentClass(this.plugin.settings));
	}

	tagDialog(options: TagDialogOptions): Promise<void> {
		return tagDialog(this.plugin.app, options, accentClass(this.plugin.settings));
	}

	/** Asks the Notification permission from this user gesture (once per plugin lifetime). */
	reminderGesture(): void {
		this.plugin.reminderGesture();
	}

	quickAdd(preset?: QuickAddPreset): void {
		openQuickAdd(this.plugin, this.session, preset);
	}

	attachTokenSuggest(input: HTMLInputElement, onBind: (decision: SpanDecision) => void): { isOpen(): boolean; dispose(): void } {
		const handle = attachTokenSuggest(this.plugin.app, this.app, input, onBind, () => {
			this.disposers = this.disposers.filter((d) => d !== handle.dispose);
		});
		this.disposers.push(handle.dispose);
		return handle;
	}

	resolveNoteLinks(linktext: string): string[] {
		return resolveNoteLinks(this.plugin.app, linktext);
	}

	openNote(path: string, split: boolean): void {
		void this.plugin.app.workspace.openLinkText(path, "", split ? "split" : "tab");
	}

	async renderNote(path: string, el: HTMLElement): Promise<() => void> {
		const obsidian = this.plugin.app;
		const view = this.view;
		if (view === null) return () => undefined;
		const file = obsidian.vault.getFileByPath(path);
		const token = String(++this.renderSeq);
		el.dataset.cpRenderToken = token;
		if (file === null) {
			el.empty();
			return () => undefined;
		}
		// Rendered with the view's child component, never the plugin.
		const child = view.addChild(new Component());
		const content = await obsidian.vault.cachedRead(file);
		const box = createDiv();
		await MarkdownRenderer.render(obsidian, content, box, file.path, child);
		if (el.dataset.cpRenderToken !== token) {
			// A newer render of this element started meanwhile.
			view.removeChild(child);
			return () => undefined;
		}
		el.empty();
		el.appendChild(box);
		const linkOf = (evt: MouseEvent): HTMLElement | null => {
			const node = evt.targetNode;
			if (node === null || !node.instanceOf(HTMLElement)) return null;
			return node.closest<HTMLElement>("a.internal-link");
		};
		const onClick = (evt: MouseEvent) => {
			const link = linkOf(evt);
			if (link === null) return;
			evt.preventDefault();
			const href = link.getAttr("data-href") ?? link.getAttr("href") ?? "";
			void obsidian.workspace.openLinkText(href, file.path, Keymap.isModEvent(evt));
		};
		const onHover = (evt: MouseEvent) => {
			const link = linkOf(evt);
			if (link === null) return;
			obsidian.workspace.trigger("hover-link", {
				event: evt,
				source: CHECKPOINT_VIEW_TYPE,
				hoverParent: view,
				targetEl: link,
				linktext: link.getAttr("data-href") ?? "",
				sourcePath: file.path,
			});
		};
		el.addEventListener("click", onClick);
		el.addEventListener("mouseover", onHover);
		const dispose = () => {
			el.removeEventListener("click", onClick);
			el.removeEventListener("mouseover", onHover);
			view.removeChild(child);
			this.disposers = this.disposers.filter((d) => d !== dispose);
		};
		this.disposers.push(dispose);
		return dispose;
	}

	onNotesChanged(listener: (path: string) => void): () => void {
		return this.plugin.events.on("note", listener);
	}

	async exportBackup(): Promise<void> {
		const folder = await pickFolder(this.plugin.app, "Choose a folder for the backup");
		if (folder === null) return;
		await this.session.store.flush();
		const content = this.app.data.exportJson();
		const vault = this.plugin.app.vault;
		const base = exportFileName(this.app.clock.now()).replace(/\.json$/, "");
		const dir = folder.isRoot() ? "" : `${folder.path}/`;
		let path = `${dir}${base}.json`;
		for (let n = 2; vault.getAbstractFileByPath(path) !== null; n++) path = `${dir}${base} (${n}).json`;
		await vault.create(path, content);
		new Notice(`Backup exported to ${path}`);
	}

	async exportCsv(): Promise<void> {
		await this.session.store.flush();
		// Refused (ReadOnly) before anything is created: a half-written export is worse than none.
		const files = this.app.data.exportCsv(this.app.settings.weekStart());
		const vault = this.plugin.app.vault;
		const base = exportFolderName(this.app.clock.now(), this.app.settings.zone());
		let folder = normalizePath(base);
		for (let n = 2; vault.getAbstractFileByPath(folder) !== null; n++) folder = normalizePath(`${base} (${n})`);
		await vault.createFolder(folder);
		let written = 0;
		try {
			for (const file of files) {
				await vault.create(normalizePath(`${folder}/${file.name}`), file.content);
				written++;
			}
		} catch (err) {
			// A half-written folder must not pass for an export: say how far it got, then let the caller show the cause.
			new Notice(`Export failed after ${written} of ${files.length} files; ${folder} is incomplete.`);
			throw err;
		}
		new Notice(`Exported ${files.length} files to ${folder}`);
	}

	async importBackup(): Promise<void> {
		const file = await pickJsonFile(this.plugin.app);
		if (!(file instanceof TFile)) return;
		const text = await this.plugin.app.vault.read(file);
		// What is applied is what the preview showed. If the database changed
		// while the preview was open, the import is refused and previewed again.
		for (let notice: string | null = null; ; ) {
			const result = this.app.data.previewImport(text);
			if (!result.ok) {
				new Notice(result.message);
				return;
			}
			const mode = await showImportPreview(this.plugin.app, file.name, result.preview, notice);
			if (mode === null) return;
			try {
				if (mode === "replace") await this.app.data.importReplace(result.preview);
				else await this.app.data.importMerge(result.preview);
			} catch (err) {
				if (!isDomainError(err, "StalePreview")) throw err;
				notice = err.message;
				continue;
			}
			new Notice(mode === "replace" ? "Backup imported. All records were replaced." : "Backup merged.");
			return;
		}
	}

	setIcon(el: HTMLElement, icon: string): void {
		setIcon(el, icon);
	}

	dispose(): void {
		for (const d of this.disposers.splice(0)) d();
	}
}
