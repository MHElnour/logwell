import type { Setting, SettingGroupItem } from "obsidian";
import { unixLineEnds } from "../domain/text";
import { DB_EXTENSION } from "../persistence/schema";

// The "Git sync" row of the settings tab. Git merges text files line by line, and the database holds one record per
// line, so two computers that both saved leave a file Logwell cannot read. One line in `.gitattributes` makes Git keep
// the pulling computer's whole file instead, and Logwell then offers Keep mine or Keep theirs.
//
// `.git` and `.gitattributes` are dotfiles that Obsidian's vault index does not list (`getFileByPath` finds neither),
// so they are read and written through the vault adapter, which works on paths.

const GIT_FOLDER = ".git";
const GIT_ATTRIBUTES_FILE = ".gitattributes";

/** The `.gitattributes` line that stops Git from merging a database file line by line. */
export const GIT_ATTRIBUTES_LINE = `*.${DB_EXTENSION} merge=binary -text`;

/** True when a `.gitattributes` text holds the database line (any line equal to it once trimmed). */
export function hasGitAttributesLine(text: string): boolean {
	return unixLineEnds(text)
		.split("\n")
		.some((line) => line.trim() === GIT_ATTRIBUTES_LINE);
}

/**
 * What to append to a `.gitattributes` text so it holds the database line: the line after a line break when the text
 * does not end in one, in the text's own line ending. Empty when the text holds the line already. No other line changes.
 */
export function gitAttributesAddition(text: string): string {
	if (hasGitAttributesLine(text)) return "";
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lead = text === "" || text.endsWith("\n") ? "" : eol;
	return `${lead}${GIT_ATTRIBUTES_LINE}${eol}`;
}

/** The part of the vault adapter this uses (the real `DataAdapter` fits). Paths are relative to the vault root. */
export interface GitSyncFiles {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	/** Adds to the end of the file and creates it when missing; never replaces what is there. */
	append(path: string, data: string): Promise<void>;
}

/** True when the vault is a Git repository whose `.gitattributes` does not hold the database line yet. */
export async function gitSyncNeeded(files: GitSyncFiles): Promise<boolean> {
	if (!(await files.exists(GIT_FOLDER))) return false;
	if (!(await files.exists(GIT_ATTRIBUTES_FILE))) return true;
	return !hasGitAttributesLine(await files.read(GIT_ATTRIBUTES_FILE));
}

/**
 * Adds the database line to `.gitattributes`, creating the file when it is missing. It appends and never replaces, so
 * a file that a pull brings in meanwhile keeps its lines. True when the file changed, false when the line was there.
 */
export async function addGitAttributesLine(files: GitSyncFiles): Promise<boolean> {
	const text = (await files.exists(GIT_ATTRIBUTES_FILE)) ? await files.read(GIT_ATTRIBUTES_FILE) : "";
	const addition = gitAttributesAddition(text);
	if (addition === "") return false;
	await files.append(GIT_ATTRIBUTES_FILE, addition);
	return true;
}

export interface GitSyncRowDeps {
	/** The vault adapter. Read when used, so a tab built before the app is ready is fine. */
	files: () => GitSyncFiles;
	notify: (message: string) => void;
	error: (err: unknown) => void;
	/** Applies the row's `visible` again (the tab's `refreshDomState`). */
	refresh: () => void;
}

export const GIT_SYNC_ADDED = "Added to .gitattributes.";
export const GIT_SYNC_PRESENT = "Git sync is already set up.";

/**
 * The row and the check that decides whether it shows. Obsidian reads the definitions once, not each time the tab
 * opens, but evaluates `visible` on every display, so the check starts from `visible`: the row starts hidden and shows
 * once the vault is known to need the line, and hides when a pull or the user adds it.
 */
export function gitSyncRow(deps: GitSyncRowDeps): { item: SettingGroupItem; check: () => Promise<void> } {
	let needed = false;
	let adding = false;
	let running: Promise<void> | null = null;
	// A check that started before the line was added must not show the row again.
	let generation = 0;

	const set = (next: boolean) => {
		if (next === needed) return;
		needed = next;
		deps.refresh();
	};

	const run = async () => {
		const started = generation;
		let result = false;
		try {
			result = await gitSyncNeeded(deps.files());
		} catch {
			// Not readable here (no adapter yet, a mobile vault): there is nothing to offer.
		}
		if (started === generation && !adding) set(result);
	};

	/** One check at a time: a call while one runs shares it. */
	const check = (): Promise<void> => {
		if (adding) return Promise.resolve();
		running ??= run().finally(() => {
			running = null;
		});
		return running;
	};

	const item: SettingGroupItem = {
		name: "Git sync",
		desc: "Stops Git from merging the database line by line, so a conflict offers Keep mine or Keep theirs.",
		visible: () => {
			void check();
			return needed;
		},
		render: (setting: Setting) => {
			setting.addButton((button) =>
				button.setButtonText("Add to .gitattributes").onClick(() => {
					if (adding || !needed) return;
					adding = true;
					generation++;
					button.setDisabled(true);
					void addGitAttributesLine(deps.files())
						.then((changed) => {
							generation++;
							deps.notify(changed ? GIT_SYNC_ADDED : GIT_SYNC_PRESENT);
							set(false);
						})
						.catch((err: unknown) => {
							button.setDisabled(false);
							deps.error(err);
						})
						.finally(() => {
							adding = false;
						});
				}),
			);
		},
	};
	return { item, check };
}
