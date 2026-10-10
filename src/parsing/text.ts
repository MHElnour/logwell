// Small text helpers shared by the tokenizer and the cursor logic. No regex
// lookbehind anywhere in this layer (iOS): boundaries are checked by hand.

const WORD_RE = /^[\p{L}\p{N}\p{M}_]$/u;
const SPACE_RE = /^\s$/u;
const TOKEN_CHAR_RE = /^[\p{L}\p{N}\p{M}_/-]$/u;

/** The code point that ends right before `index` ("" at the start). */
export function charBefore(s: string, index: number): string {
	if (index <= 0) return "";
	const low = s.charCodeAt(index - 1);
	if (index >= 2 && low >= 0xdc00 && low <= 0xdfff) {
		const high = s.charCodeAt(index - 2);
		if (high >= 0xd800 && high <= 0xdbff) return s.slice(index - 2, index);
	}
	return s.charAt(index - 1);
}

/** The code point that starts at `index` ("" at the end). */
export function charAt(s: string, index: number): string {
	if (index >= s.length) return "";
	const cp = s.codePointAt(index);
	return cp === undefined ? "" : String.fromCodePoint(cp);
}

export function isWordChar(ch: string): boolean {
	return ch !== "" && WORD_RE.test(ch);
}

export function isSpaceChar(ch: string): boolean {
	return ch !== "" && SPACE_RE.test(ch);
}

/** Letters, digits, marks, "_", "/" and "-": the characters of a # or @ token. */
export function isTokenChar(ch: string): boolean {
	return ch !== "" && TOKEN_CHAR_RE.test(ch);
}

/** True at the start of the text or after a character that is not part of a word. */
export function wordBoundaryBefore(s: string, index: number): boolean {
	return index <= 0 || !isWordChar(charBefore(s, index));
}

/** `#` and `@` start a token only at the start of the text or after whitespace. */
export function tokenStartAllowed(s: string, index: number): boolean {
	return index === 0 || isSpaceChar(charBefore(s, index));
}

/** The end of the run of token characters that starts at `from`. */
export function tokenRunEnd(s: string, from: number): number {
	let i = from;
	while (i < s.length) {
		const ch = charAt(s, i);
		if (!isTokenChar(ch)) break;
		i += ch.length;
	}
	return i;
}

export function collapseWhitespace(s: string): string {
	return s.replace(/\s+/gu, " ").trim();
}

/** The replacement for masked text. U+FFFC is not whitespace, so chrono cannot bridge it. */
export const MASK_CHAR = "\uFFFC";
