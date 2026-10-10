import { type App, normalizePath } from "obsidian";

/**
 * The vault notes a `[[link]]` in Quick Add can mean. `.md` files only.
 * An exact path (with or without `.md`) wins as the single result; otherwise
 * every note whose basename equals the text (case-insensitive), sorted by path.
 * `[[Name|alias]]` and `[[Name#heading]]` use the part before `|` / `#`.
 */
export function resolveNoteLinks(app: App, linktext: string): string[] {
	const bar = linktext.indexOf("|");
	const head = bar < 0 ? linktext : linktext.slice(0, bar);
	const hash = head.indexOf("#");
	const name = (hash < 0 ? head : head.slice(0, hash)).trim();
	if (name === "") return [];
	const path = normalizePath(name);
	const exact = app.vault.getFileByPath(path.toLowerCase().endsWith(".md") ? path : `${path}.md`);
	if (exact !== null && exact.extension === "md") return [exact.path];
	const wanted = name.toLowerCase();
	return app.vault
		.getMarkdownFiles()
		.filter((f) => f.extension === "md" && f.basename.toLowerCase() === wanted)
		.map((f) => f.path)
		.sort();
}
