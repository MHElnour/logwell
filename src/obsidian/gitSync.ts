import type { Setting, SettingGroupItem } from "obsidian";
import { hasGitAttributesLine, withGitAttributesLine } from "../persistence/serializer";

// The "Git sync" row of the settings tab. Git merges text files line by line, and the database holds one record per
// line, so two computers that both saved leave a file Logwell cannot read. One line in `.gitattributes` makes Git keep
// the pulling computer's whole file instead, and Logwell then offers Keep mine or Keep theirs.
//
// `.git` and `.gitattributes` are dotfiles that Obsidian's vault index does not list (`getFileByPath` finds neither),
// so they are read and written through the vault adapter, which works on paths.

const GIT_FOLDER = ".git";
const GIT_ATTRIBUTES_FILE = ".gitattributes";

/** The part of the vault adapter this uses (the real `DataAdapter` fits). Paths are relative to the vault root. */
export interface GitSyncFiles {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	/** Reads, changes and writes in one step. */
	process(path: string, fn: (data: string) => string): Promise<string>;
}

/** True when the vault is a Git repository whose `.gitattributes` does not hold the database line yet. */
export async function gitSyncNeeded(files: GitSyncFiles): Promise<boolean> {
	if (!(await files.exists(GIT_FOLDER))) return false;
	if (!(await files.exists(GIT_ATTRIBUTES_FILE))) return true;
	return !hasGitAttributesLine(await files.read(GIT_ATTRIBUTES_FILE));
}

/** Adds the database line to `.gitattributes`, creating the file when it is missing. No other line changes. */
export async function addGitAttributesLine(files: GitSyncFiles): Promise<void> {
	if (await files.exists(GIT_ATTRIBUTES_FILE)) await files.process(GIT_ATTRIBUTES_FILE, withGitAttributesLine);
	else await files.write(GIT_ATTRIBUTES_FILE, withGitAttributesLine(""));
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

/**
 * The row and the check that decides whether it shows. `check()` runs each time the tab's definitions are read; the
 * row starts hidden and appears once the vault is known to need the line.
 */
export function gitSyncRow(deps: GitSyncRowDeps): { item: SettingGroupItem; check: () => Promise<void> } {
	let needed = false;
	let adding = false;
	// A check that started before the line was added must not show the row again.
	let generation = 0;

	const set = (next: boolean) => {
		if (next === needed) return;
		needed = next;
		deps.refresh();
	};

	const check = async () => {
		const started = generation;
		let result = false;
		try {
			result = await gitSyncNeeded(deps.files());
		} catch {
			// Not readable here (no adapter yet, a mobile vault): there is nothing to offer.
		}
		if (started === generation) set(result);
	};

	const item: SettingGroupItem = {
		name: "Git sync",
		desc: "Stops Git from merging the database line by line, so a conflict offers Keep mine or Keep theirs.",
		visible: () => needed,
		render: (setting: Setting) => {
			setting.addButton((button) =>
				button.setButtonText("Add to .gitattributes").onClick(() => {
					if (adding || !needed) return;
					adding = true;
					generation++;
					button.setDisabled(true);
					void addGitAttributesLine(deps.files())
						.then(() => {
							deps.notify(GIT_SYNC_ADDED);
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
