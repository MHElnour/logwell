// A line-based three-way merge: the text of a description note the sync created, merged against
// the text both sides last agreed on. Pure.

/**
 * The line put before TickTick's version of a passage that both sides changed differently. Logwell's lines stay
 * first, then this line, then TickTick's.
 */
export const MERGE_MARKER = "From TickTick:";

/** `a[aStart, aEnd)` became `b[bStart, bEnd)`. Between two hunks the lines are equal. */
export interface Hunk {
	aStart: number;
	aEnd: number;
	bStart: number;
	bEnd: number;
}

/** Above this many cells the middle of two texts is compared as one changed block (a longer note still merges). */
const LCS_CELL_LIMIT = 1_000_000;

/** How many lines `a` and `b` share at the start (`head`), and then at the end (`tail`, never overlapping `head`). */
function commonEnds(a: readonly string[], b: readonly string[]): { head: number; tail: number } {
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	return { head, tail };
}

/** The hunks that turn `a` into `b`: a longest common subsequence of equal lines, after the common ends. */
export function diffLines(a: readonly string[], b: readonly string[]): Hunk[] {
	const { head, tail } = commonEnds(a, b);
	const n = a.length - head - tail;
	const m = b.length - head - tail;
	if (n === 0 && m === 0) return [];
	if (n === 0 || m === 0 || n * m > LCS_CELL_LIMIT) return [{ aStart: head, aEnd: head + n, bStart: head, bEnd: head + m }];
	// lcs[i][j]: the longest common subsequence of a[head+i..] and b[head+j..].
	const w = m + 1;
	const lcs = new Uint32Array((n + 1) * w);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i * w + j] = a[head + i] === b[head + j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
		}
	}
	const hunks: Hunk[] = [];
	let i = 0;
	let j = 0;
	let open: Hunk | null = null;
	const close = () => {
		if (open !== null) {
			open.aEnd = head + i;
			open.bEnd = head + j;
			hunks.push(open);
			open = null;
		}
	};
	while (i < n || j < m) {
		if (i < n && j < m && a[head + i] === b[head + j]) {
			close();
			i++;
			j++;
			continue;
		}
		open ??= { aStart: head + i, aEnd: head + i, bStart: head + j, bEnd: head + j };
		if (j >= m || (i < n && lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) i++;
		else j++;
	}
	close();
	return hunks;
}

/** The same lines in the same order. */
export function sameLines(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

interface SideHunk extends Hunk {
	ours: boolean;
}

/** Whether a hunk joins a group: their ranges of `base` overlap, or both insert at the same place. */
function overlaps(gs: number, ge: number, s: number, e: number): boolean {
	if (gs === ge && s === e) return s === gs;
	if (gs === ge) return s < gs && gs < e;
	if (s === e) return gs < s && s < ge;
	return s < ge && gs < e;
}

/** One side's lines for `base[start, end)`, and for each line whether that side wrote it (else it is a base line it kept). */
interface SideLines {
	lines: string[];
	written: boolean[];
}

function sideVersion(base: readonly string[], side: readonly string[], hunks: readonly SideHunk[], start: number, end: number): SideLines {
	const lines: string[] = [];
	const written: boolean[] = [];
	const push = (xs: readonly string[], own: boolean) => {
		lines.push(...xs);
		for (let i = 0; i < xs.length; i++) written.push(own);
	};
	let pos = start;
	for (const h of hunks) {
		push(base.slice(pos, h.aStart), false);
		push(side.slice(h.bStart, h.bEnd), true);
		pos = h.aEnd;
	}
	push(base.slice(pos, end), false);
	return { lines, written };
}

function endsWith(lines: readonly string[], tail: readonly string[]): boolean {
	if (tail.length > lines.length) return false;
	const off = lines.length - tail.length;
	return tail.every((x, i) => lines[off + i] === x);
}

/** How a passage both sides changed differently is resolved: Logwell's lines and TickTick's, both kept. `base` is the passage before. */
export type ConflictResolver = (ours: readonly string[], theirs: readonly string[], base: readonly string[]) => string[];

/** The default: Logwell's lines, then the marker line, then TickTick's. */
export function markConflict(marker = MERGE_MARKER): ConflictResolver {
	return (ours, theirs) => [...ours, marker, ...theirs];
}

/**
 * One overlapping passage. Lines both versions start or end with are shared; when one version is then only an
 * extension of the other (A,B against A,B,C), the lines the longer one wrote are taken, and the base lines it only
 * kept go, since the other side deleted them. Otherwise the differing middle goes to `resolve`. A middle that already
 * ends with `marker` and TickTick's lines (an earlier merge whose base could not be saved) is not resolved again.
 */
function resolvePassage(so: SideLines, st: SideLines, vb: readonly string[], resolve: ConflictResolver, marker: string | null): string[] {
	const vo = so.lines;
	const vt = st.lines;
	const { head, tail } = commonEnds(vo, vt);
	const mo = vo.slice(head, vo.length - tail);
	const mt = vt.slice(head, vt.length - tail);
	const shared = head + tail > 0;
	const writtenBy = (s: SideLines, mid: readonly string[]) => mid.filter((_, i) => s.written[head + i]);
	let middle: string[];
	if (mo.length === 0 && mt.length === 0) middle = [];
	else if (shared && mt.length === 0) middle = writtenBy(so, mo);
	else if (shared && mo.length === 0) middle = writtenBy(st, mt);
	else if (marker !== null && endsWith(mo, [marker, ...mt])) middle = mo;
	else middle = resolve(mo, mt, vb);
	return [...vo.slice(0, head), ...middle, ...vo.slice(vo.length - tail)];
}

/**
 * Merges two edits of `base` line by line. A side that did not change gives the other side. Changes to different
 * lines both apply. A passage both sides changed to different lines keeps Logwell's lines (`ours`), then the
 * `marker` line, then TickTick's (`theirs`), or what `resolve` gives (checklist items).
 */
export function mergeLines(
	base: readonly string[],
	ours: readonly string[],
	theirs: readonly string[],
	marker: string | null = MERGE_MARKER,
	resolve: ConflictResolver = markConflict(marker ?? MERGE_MARKER),
): string[] {
	if (sameLines(ours, base)) return [...theirs];
	if (sameLines(theirs, base) || sameLines(ours, theirs)) return [...ours];
	const all: SideHunk[] = [...diffLines(base, ours).map((h) => ({ ...h, ours: true })), ...diffLines(base, theirs).map((h) => ({ ...h, ours: false }))];
	all.sort((x, y) => x.aStart - y.aStart || x.aEnd - x.aStart - (y.aEnd - y.aStart));
	const groups: { start: number; end: number; hunks: SideHunk[] }[] = [];
	for (const h of all) {
		const g = groups[groups.length - 1];
		if (g !== undefined && overlaps(g.start, g.end, h.aStart, h.aEnd)) {
			g.end = Math.max(g.end, h.aEnd);
			g.hunks.push(h);
		} else {
			groups.push({ start: h.aStart, end: h.aEnd, hunks: [h] });
		}
	}
	const out: string[] = [];
	let pos = 0;
	for (const g of groups) {
		out.push(...base.slice(pos, g.start));
		pos = g.end;
		const mine = g.hunks.filter((h) => h.ours);
		const other = g.hunks.filter((h) => !h.ours);
		const vo = sideVersion(base, ours, mine, g.start, g.end);
		const vt = sideVersion(base, theirs, other, g.start, g.end);
		if (other.length === 0) out.push(...vo.lines);
		else if (mine.length === 0) out.push(...vt.lines);
		else out.push(...resolvePassage(vo, vt, base.slice(g.start, g.end), resolve, marker));
	}
	out.push(...base.slice(pos));
	return out;
}

/** Lines of a text: line endings as "\n"; the empty text has none. */
export function textLines(text: string): string[] {
	return text === "" ? [] : text.replace(/\r\n?/gu, "\n").split("\n");
}

/** `mergeLines` over texts. Line endings come out as "\n". */
export function mergeText(base: string, ours: string, theirs: string, marker = MERGE_MARKER): string {
	return mergeLines(textLines(base), textLines(ours), textLines(theirs), marker).join("\n");
}
