// Description-note naming rules. Pure: the Obsidian
// adapter does the vault lookups.

import { collapseWhitespace } from "./text";

const FORBIDDEN_CHARS_RE = /[\\/:*?"<>|#^[\]]/g;
const MAX_NAME_LENGTH = 100;
const UNTITLED_NOTE_NAME = "Untitled task";

/**
 * Removes \ / : * ? " < > | # ^ [ ], collapses whitespace, truncates to 100
 * characters and drops leading dots (they would hide the file). An empty result becomes "Untitled task".
 */
export function sanitizeNoteName(title: string): string {
	const cleaned = collapseWhitespace(title.normalize("NFC").replace(FORBIDDEN_CHARS_RE, ""))
		.slice(0, MAX_NAME_LENGTH)
		.trim()
		// A leading dot would hide the file in Obsidian.
		.replace(/^\.+/, "")
		.trim();
	return cleaned.length > 0 ? cleaned : UNTITLED_NOTE_NAME;
}

/** Candidate file names in probe order: "Name.md", "Name (2).md", ...; `ext` is another extension, or "" for a folder. */
export function noteNameCandidate(name: string, attempt: number, ext = ".md"): string {
	return attempt <= 1 ? `${name}${ext}` : `${name} (${attempt})${ext}`;
}

export function joinPath(folder: string, name: string): string {
	const f = folder.replace(/^\/+|\/+$/g, "");
	return f.length === 0 ? name : `${f}/${name}`;
}

/**
 * The new path for a reference after a rename, or null if the
 * reference is unaffected. Folder renames rewrite by prefix.
 */
export function rewriteNotePath(
	path: string,
	oldPath: string,
	newPath: string,
	isFolder: boolean,
): string | null {
	if (!isFolder) return path === oldPath ? newPath : null;
	const prefix = `${oldPath}/`;
	return path.startsWith(prefix) ? `${newPath}/${path.slice(prefix.length)}` : null;
}

/** The last segment of a path: the file name with its extension. */
export function fileNameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** A note's path as a link names it when its name is not unique: the folders kept, only a ".md" extension hidden. */
export function noteLinkPath(path: string): string {
	return path.replace(/\.md$/iu, "");
}

/** The name a linked note is shown under: the file name without its folders; only a ".md" extension is hidden. */
export function noteDisplayName(path: string): string {
	return noteLinkPath(fileNameOf(path));
}

export function basenameOf(path: string): string {
	const file = fileNameOf(path);
	const dot = file.lastIndexOf(".");
	return dot > 0 ? file.slice(0, dot) : file;
}
