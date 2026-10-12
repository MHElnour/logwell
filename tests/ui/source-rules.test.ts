import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// One word for lists: the UI says "list" everywhere. The code keeps `category` for identifiers, types, store
// keys and the file format, so a string literal may name a category only when it is exactly such a name or one
// of the store labels (internal undo keys, never shown).

const ROOT = join(__dirname, "..", "..", "src");

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/u.test(name) ? [path] : [];
	});
}

const STORE_LABELS = new Set(["Create category", "Edit category", "Change category icon", "Change category color", "Reorder categories", "Delete category"]);
const LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/gu;
const WORD = /\bcategor(?:y|ies)\b/iu;
/** JSX text between tags, e.g. `<legend>Categories</legend>`, and bare text lines inside an element. */
const JSX_TEXT = />([^<>{}]*\bcategor(?:y|ies)\b[^<>{}]*)</iu;

describe("list wording", () => {
	it("no string in src says category or categories where the user can read it", () => {
		const found: string[] = [];
		for (const file of files(ROOT)) {
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, i) => {
				const code = line.replace(/\/\/.*$/u, "");
				if (/^\s*(\*|\/\*)/u.test(code)) return;
				const jsx = file.endsWith(".tsx") ? JSX_TEXT.exec(code) : null;
				if (jsx !== null) found.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${jsx[1]}`);
				if (file.endsWith(".tsx") && /^\s*[A-Za-z][^<>{}=]*$/u.test(code) && WORD.test(code) && !/[;(:"']/u.test(code)) found.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${code.trim()}`);
				for (const m of code.matchAll(LITERAL)) {
					const text = m[1] ?? m[2] ?? m[3] ?? "";
					if (!WORD.test(text)) continue;
					// An identifier or a CSS class: no space and a lowercase start ("category", "cp-search-categories").
					if (/^[a-z][\w-]*$/u.test(text) || /^cp-[\w-]+( cp-[\w-]+)*$/u.test(text)) continue;
					// The services own the labels; the sidebar passes "Delete category" to notifyUndo so Undo finds that write.
					if (STORE_LABELS.has(text) && /(CategoryService\.ts|Sidebar\.tsx)$/u.test(file)) continue;
					// A template part that is only an identifier path, e.g. `${state.categories}`.
					if (!WORD.test(text.replace(/\$\{[^}]*\}/gu, ""))) continue;
					found.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${text}`);
				}
			});
		}
		expect(found).toEqual([]);
	});
});

describe("the UI and the store host", () => {
	// The UI reaches the restore, conflict and write paths through the command queue, never through the store host.
	it("the UI never calls the mutating host methods directly", () => {
		const dir = join(ROOT, "ui");
		const offenders: string[] = [];
		for (const file of files(dir)) {
			const text = readFileSync(file, "utf8");
			if (/\.host\.(restoreSnapshot|restoreRecovered|keepMine|keepTheirs|replaceAll|commit|flush)\b/.test(text)) offenders.push(file.slice(dir.length + 1));
		}
		expect(offenders).toEqual([]);
	});
});
