import { readFileSync } from "node:fs";

// The stylesheet read as text. happy-dom has no layout, so the tests check the rules of styles.css by reading them;
// the e2e specs check the real rendering. styles.css is cut into sections, each between `/* == <name> == */` and
// `/* == end <name> == */`.

export const css = readFileSync("styles.css", "utf8");

/** The text without its comments. */
export const uncommented = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "");

/** The section that opens with `/* == <name> == *\/`, both markers included (empty when it is missing). */
export function cssSection(name: string): string {
	const mark = `/* == ${name} == */`;
	const end = `/* == end ${name} == */`;
	const start = css.indexOf(mark);
	const stop = css.indexOf(end);
	return start < 0 || stop < 0 ? "" : css.slice(start, stop + end.length);
}

/** Every section marker in file order: `open` names a section, `end` closes the one it names. */
export function sectionMarks(): { name: string; end: boolean }[] {
	return [...css.matchAll(/\/\* == ([^=]+?) == \*\//g)].map((m) => {
		const end = m[1]!.startsWith("end ");
		return { name: end ? m[1]!.slice(4) : m[1]!, end };
	});
}

/** Every selector of a stylesheet text, comments removed and at-rule preludes skipped; a comma inside `:is(...)` does not start another selector. */
export function selectors(text: string): string[] {
	const out: string[] = [];
	const re = /([^{}]+)\{/g;
	const clean = uncommented(text);
	for (let m = re.exec(clean); m !== null; m = re.exec(clean)) {
		const prelude = m[1]!.trim();
		if (prelude.startsWith("@")) continue;
		for (const s of prelude.replace(/\([^)]*\)/g, (g) => g.replace(/,/g, "|")).split(",")) out.push(s.trim());
	}
	return out;
}

/** The text between the braces of the first rule (or at-rule, with what it nests) that starts with `head`. */
export function cssBlock(head: string, text: string = css): string {
	const start = text.indexOf(head);
	if (start < 0) throw new Error(`no rule ${head}`);
	const open = text.indexOf("{", start);
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "{") depth++;
		else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
	}
	throw new Error(`unbalanced ${head}`);
}
