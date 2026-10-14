import { type App, Setting } from "obsidian";
import type { ImportChangeKind, ImportPreview } from "../app/DataService";
import { COLLECTIONS, type CollectionName } from "../persistence/schema";
import { ResolvingModal } from "./resolvingModal";

type ImportMode = "replace" | "merge";

const CHANGE_LABELS: Record<ImportChangeKind, string> = {
	add: "new",
	overwrite: "overwritten",
	remove: "removed",
};

/** Every collection's name in the preview; typed over all collections so a new one cannot be left out. */
const COLLECTION_LABELS: Record<CollectionName, string> = {
	categories: "Lists",
	sections: "Sections",
	tags: "Tags",
	tasks: "Tasks",
	occurrenceRecords: "Occurrence records",
	habits: "Habits",
	checkins: "Check-ins",
	focusSessions: "Focus sessions",
	savedFilters: "Saved filters",
	trash: "Trash entries",
	syncLinks: "TickTick links",
};

/** The preview shown before any import. */
class ImportPreviewModal extends ResolvingModal<ImportMode | null> {
	constructor(
		app: App,
		private readonly fileName: string,
		private readonly preview: ImportPreview,
		/** Why the preview is shown again (it was stale when confirmed). */
		private readonly notice: string | null,
	) {
		super(app, null);
	}

	override onOpen(): void {
		const p = this.preview;
		this.setTitle("Import backup");
		const el = this.contentEl;
		el.addClass("checkpoint-import");
		if (this.notice !== null) el.createEl("p", { cls: "checkpoint-import-notice", text: this.notice });
		el.createEl("p", {
			text:
				`${this.fileName} — schema version ${p.migratedFrom ?? p.schemaVersion}` +
				(p.migratedFrom !== null ? ` (migrated to ${p.schemaVersion})` : ""),
		});
		const table = el.createEl("table", { cls: "checkpoint-import-counts" });
		for (const c of COLLECTIONS) {
			if (p.counts[c] === 0) continue;
			const row = table.createEl("tr");
			row.createEl("td", { text: COLLECTION_LABELS[c] });
			row.createEl("td", { text: String(p.counts[c]) });
		}
		const count = (kind: ImportChangeKind) => p.changes.filter((c) => c.kind === kind).length;
		el.createEl("p", {
			text: `Merge by ID adds ${count("add")} records, overwrites ${count("overwrite")} and removes ${count("remove")}.`,
		});
		// Overwrites and removals are listed first, then additions.
		const order: ImportChangeKind[] = ["overwrite", "remove", "add"];
		const changes = [...p.changes].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
		if (changes.length > 0) {
			const details = el.createEl("details");
			details.createEl("summary", { text: "Records a merge would change" });
			const list = details.createEl("ul");
			for (const c of changes.slice(0, 200)) {
				list.createEl("li", { text: `${COLLECTION_LABELS[c.collection]}: ${c.label} (${CHANGE_LABELS[c.kind]})` });
			}
			if (changes.length > 200) list.createEl("li", { text: `… and ${changes.length - 200} more` });
		}
		el.createEl("p", {
			cls: "setting-item-description",
			text: "A backup of the current database is taken before either option.",
		});
		new Setting(el)
			.addButton((b) =>
				b
					.setButtonText("Merge by ID")
					.setCta()
					.onClick(() => this.cpAnswer("merge")),
			)
			.addButton((b) =>
				b
					.setButtonText("Replace all")
					.setDestructive()
					.onClick(() => this.cpAnswer("replace")),
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

}

export function showImportPreview(
	app: App,
	fileName: string,
	preview: ImportPreview,
	notice: string | null = null,
): Promise<ImportMode | null> {
	return new ImportPreviewModal(app, fileName, preview, notice).cpAsk();
}
