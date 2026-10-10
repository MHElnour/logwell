// Description-note naming rules. Pure: the Obsidian
// adapter does the vault lookups.

const FORBIDDEN_CHARS_RE = /[\\/:*?"<>|#^[\]]/g;
const MAX_NAME_LENGTH = 100;
const UNTITLED_NOTE_NAME = "Untitled task";

/**
 * Removes \ / : * ? " < > | # ^ [ ], collapses whitespace, truncates to 100
 * characters and drops leading dots (they would hide the file). An empty result becomes "Untitled task".
 */
export function sanitizeNoteName(title: string): string {
	const cleaned = title
		.normalize("NFC")
		.replace(FORBIDDEN_CHARS_RE, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_NAME_LENGTH)
		.trim()
		// A leading dot would hide the file in Obsidian.
		.replace(/^\.+/, "")
		.trim();
	return cleaned.length > 0 ? cleaned : UNTITLED_NOTE_NAME;
}

/** Candidate file names in probe order: "Name.md", "Name (2).md", ... */
export function noteNameCandidate(name: string, attempt: number): string {
	return attempt <= 1 ? `${name}.md` : `${name} (${attempt}).md`;
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

export function basenameOf(path: string): string {
	const file = path.slice(path.lastIndexOf("/") + 1);
	const dot = file.lastIndexOf(".");
	return dot > 0 ? file.slice(0, dot) : file;
}
