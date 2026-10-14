import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// One word for lists: the UI says "list" everywhere. The code keeps `category` for identifiers, types, store
// keys and the file format, so a string literal may name a category only when it is exactly such a name. The
// store labels say "list" too: "Undone: <label>" shows them (#137).

const ROOT = join(__dirname, "..", "..", "src");

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/u.test(name) ? [path] : [];
	});
}

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
					// A template part that is only an identifier path, e.g. `${state.categories}`.
					if (!WORD.test(text.replace(/\$\{[^}]*\}/gu, ""))) continue;
					found.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${text}`);
				}
			});
		}
		expect(found).toEqual([]);
	});
});

describe("comments say the rule, never its number", () => {
	// The spec numbers its rules; code, tests and docs say what a rule says instead. Forms: "rule 28", "rules 24, 25",
	// "Repeating tasks rule 19", a section sign ("spec §7"), and the old requirement ids ("SYNC-10").
	const CITATION = /\b[Rr]ules? \d+[a-z]?\b|§\s?\d|\b(?:SYNC|AS|HAB|POM|SUB|NOTE|TAG|QA|TASK|EXP|CAL|PRI|CAT|REC|MAT|VIEW|UI|SRCH|TIME|DATA)-\d{2}\b/u;
	const REPO = join(__dirname, "..", "..");
	const SELF = join(__dirname, "source-rules.test.ts");

	for (const dir of ["src", "tests", "e2e-tests"]) {
		it(`#137: no line in ${dir} cites a rule by number, such as (rule 28) or Repeating tasks rule 19`, () => {
			const found: string[] = [];
			for (const file of files(join(REPO, dir))) {
				if (file === SELF) continue;
				readFileSync(file, "utf8")
					.split("\n")
					.forEach((line, i) => {
						if (CITATION.test(line)) found.push(`${file.slice(REPO.length + 1)}:${i + 1}: ${line.trim()}`);
					});
			}
			expect(found).toEqual([]);
		});
	}
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
