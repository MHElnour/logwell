// Pure helpers of the Quick Add suggester. No parsing import: the token
// shape is structural, so these stay testable without the parser.

export interface TokenSpan {
	start: number;
	end: number;
}

export interface ChoiceResult {
	value: string;
	/** The inserted text, in the new value. */
	span: TokenSpan;
	/** Cursor position after the inserted text. */
	cursor: number;
}

/** Replaces the token span of `value` with `insertText`. */
export function applyTokenChoice(value: string, token: { span: TokenSpan }, insertText: string): ChoiceResult {
	const start = Math.max(0, Math.min(token.span.start, value.length));
	const end = Math.max(start, Math.min(token.span.end, value.length));
	const next = value.slice(0, start) + insertText + value.slice(end);
	const stop = start + insertText.length;
	return { value: next, span: { start, end: stop }, cursor: stop };
}

function squash(s: string): string {
	return s.toLowerCase().replace(/[\s_-]+/g, "");
}

/** Rank: 0 prefix, 1 substring, 2 subsequence, -1 no match. */
function rank(label: string, query: string): number {
	const l = squash(label);
	const q = squash(query);
	if (q === "") return 0;
	if (l.startsWith(q)) return 0;
	if (l.includes(q)) return 1;
	let i = 0;
	for (const ch of l) if (ch === q[i] && ++i === q.length) return 2;
	return -1;
}

/** Case-insensitive prefix, substring, then fuzzy matches; stable within a rank. */
export function filterByQuery<T>(items: readonly T[], label: (item: T) => string, query: string, limit = 20): T[] {
	const ranked: { item: T; r: number; i: number }[] = [];
	items.forEach((item, i) => {
		const r = rank(label(item), query);
		if (r >= 0) ranked.push({ item, r, i });
	});
	ranked.sort((a, b) => a.r - b.r || a.i - b.i);
	return ranked.slice(0, limit).map((x) => x.item);
}

const baseOf = (p: string): string => (p.split("/").pop() ?? p).replace(/\.md$/i, "");

/** Counts notes per lower-cased basename, once, so insert names cost O(1) each. */
function basenameCounts(allPaths: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const p of allPaths) {
		const b = baseOf(p).toLowerCase();
		counts.set(b, (counts.get(b) ?? 0) + 1);
	}
	return counts;
}

/** `[[basename]]` text when the basename is unique among notes, else the path without `.md`. */
export function noteInsertName(path: string, allPaths: readonly string[] | ReadonlyMap<string, number>): string {
	const counts = allPaths instanceof Map ? allPaths : basenameCounts(allPaths as readonly string[]);
	return (counts.get(baseOf(path).toLowerCase()) ?? 0) > 1 ? path.replace(/\.md$/i, "") : baseOf(path);
}

export interface NoteFileLike {
	path: string;
	basename: string;
}

export interface NoteSuggestion {
	path: string;
	basename: string;
	insert: string;
}

/** Filters first (limit 20), then computes insert names only for the results. O(N) per call. */
export function suggestNotes(files: readonly NoteFileLike[], query: string, limit = 20): NoteSuggestion[] {
	const counts = basenameCounts(files.map((f) => f.path));
	return filterByQuery(files, (f) => f.path, query, limit).map((f) => ({
		path: f.path,
		basename: f.basename,
		insert: noteInsertName(f.path, counts),
	}));
}
