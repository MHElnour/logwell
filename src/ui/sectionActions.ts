import { DELETE_SECTION_LABEL } from "../app/SectionService";
import { isDomainError } from "../domain/errors";
import { plural } from "../domain/text";
import type { ID, Section } from "../domain/types";
import type { MenuSpec, UiHost } from "./host";

// Section actions shared by the list headings and the board column headers.
// Every one is a single app.sections call, so one undo entry.

/** The result of an inline name field: a rule violation is shown in the field, never as a notice. */
type SectionNameResult = { ok: true } | { ok: false; message: string };

async function runName(host: UiHost, action: () => Promise<unknown>): Promise<SectionNameResult> {
	try {
		await action();
		return { ok: true };
	} catch (err) {
		if (isDomainError(err)) return { ok: false, message: err.message };
		host.error(err);
		return { ok: false, message: "" };
	}
}

/** Creates a section from the inline field; "A name is required" and "already exists" come back as text. */
export function createSection(host: UiHost, categoryId: ID, name: string): Promise<SectionNameResult> {
	if (name.trim() === "") return Promise.resolve({ ok: false, message: "A section needs a name." });
	return runName(host, () => host.app.sections.create(categoryId, name));
}

/** Rename by prompt (the existing prompt pattern); a rule violation shows as an error notice. */
async function renameSection(host: UiHost, section: Section): Promise<void> {
	const values = await host.prompt("Rename section", [{ key: "name", label: "Name", value: section.name }], "Save");
	if (values === null) return;
	const name = values.name ?? "";
	if (name === section.name) return;
	try {
		await host.app.sections.rename(section.id, name);
	} catch (err) {
		host.error(err);
	}
}

/** Delete: its tasks move to "No section" in the same run, then an Undo notice. */
async function deleteSection(host: UiHost, section: Section): Promise<void> {
	try {
		const mark = host.app.store.undoMark();
		const moved = await host.app.sections.delete(section.id);
		host.notifyUndo(
			moved > 0 ? `Deleted section "${section.name}". ${plural(moved, "task")} moved to No section.` : `Deleted section "${section.name}".`,
			DELETE_SECTION_LABEL,
			mark,
		);
	} catch (err) {
		host.error(err);
	}
}

/** The keyboard way to reorder: swaps `section` with its neighbour in the list's order. */
async function moveSection(host: UiHost, section: Section, delta: -1 | 1): Promise<void> {
	const order = host.app.sections.inList(section.categoryId).map((s) => s.id);
	const i = order.indexOf(section.id);
	const j = i + delta;
	if (i < 0 || j < 0 || j >= order.length) return;
	[order[i], order[j]] = [order[j]!, order[i]!];
	try {
		await host.app.sections.place(section.id, order);
	} catch (err) {
		host.error(err);
	}
}

/** The ⋯ menu of a section heading or column header. */
export function sectionMenu(host: UiHost, section: Section): MenuSpec {
	const order = host.app.sections.inList(section.categoryId).map((s) => s.id);
	const i = order.indexOf(section.id);
	return [
		{ title: "Rename", icon: "pencil", run: () => void renameSection(host, section) },
		{ title: "Move left", icon: "arrow-left", disabled: i <= 0, run: () => void moveSection(host, section, -1) },
		{ title: "Move right", icon: "arrow-right", disabled: i < 0 || i >= order.length - 1, run: () => void moveSection(host, section, 1) },
		{ title: "Delete", icon: "trash-2", warning: true, run: () => void deleteSection(host, section) },
	];
}
