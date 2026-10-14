import { collapseWhitespace } from "../text";
import { type ConflictResolver, diffLines, mergeLines, mergeText, sameLines, textLines } from "../textMerge";
import type { TtChecklistItem, TtChecklistItemWrite, TtTask, TtTaskWrite } from "./types";

// A description note the sync created and TickTick's text of its task, as one comparable
// value (`NoteDoc`), and the ways between them. Pure.
//
// Up, the note's body goes without its frontmatter; `[[Plan|my plan]]` goes as "my plan", `[[Plan]]` as "Plan", and
// embeds (`![[…]]`) are dropped. A checklist task (`kind` CHECKLIST) has its text in
// `desc` and its items as the note's `- [ ]` / `- [x]` lines, wherever they are in the note.
//
// Down, the note changes as little as it can (`writeNote`): a line whose text did not change stays as it is; a tick
// changes only the box; a changed line keeps its links whose text is still there and its embeds (at the end of the
// line); a removed line keeps its embeds; new lines go next to their neighbours; the user's layout (headings, text
// between items) stays. TickTick text that the note would read differently is escaped (`[[` as `\[[`, an item-like
// text line of a checklist as `- \[ ]`, a leading `---` behind an empty frontmatter), so reading the written note up
// always gives TickTick's text back.
//
// Checklist items are matched by their text, never by TickTick's ids: TickTick gives every item a new id on every
// update (probed 2026-10-08). An item is pushed with all the fields TickTick sent for it.

/** TickTick's side of a note: the text (normalized, `normalizeNoteText`) and the checklist items as lines. */
export interface NoteDoc {
	text: string;
	/** `- [ ] Title` or `- [x] Title` (`itemLine`), in order. Empty for a normal task. */
	items: string[];
}

/** An item line as the note reads it (after links are rendered). */
const ITEM_RE = /^([-*+]) \[([ xX])\](?: +(.*))?$/u;
/** The same on a raw note line, for its parts. */
const RAW_ITEM_RE = /^([-*+] \[)([ xX])(\](?: +)?)(.*)$/u;
/**
 * An item-like line written escaped (one backslash more than TickTick's text has): read back with one backslash
 * less, in either kind of note, so a checklist's text line stays text after the task becomes a normal one.
 */
const ESCAPED_ITEM_RE = /^([-*+] )\\(\\*\[[ xX]\].*)$/u;
/** In a checklist note every item-like text line is escaped; in a normal note only one that has a backslash already. */
const ITEM_LIKE_RE = /^([-*+] )(\\*\[[ xX]\])/u;
const ESCAPED_LIKE_RE = /^([-*+] )(\\+\[[ xX]\])/u;
/**
 * Escaped `[[`, a run of embeds with the spaces around it, a link. Left to right, so `\[[x]]` is never a link (no
 * lookbehind: iOS).
 */
const RENDER_RE = /\\\[\[|(?:[ \t]*!\[\[[^\]\n]*\]\])+[ \t]*|\[\[([^\]|\n]*)(?:\|([^\]\n]*))?\]\]/gu;
const EMBED_RE = /!\[\[[^\]\n]*\]\]/gu;

/** Line endings as "\n", no blank lines at the start, no whitespace at the end. */
export function normalizeNoteText(text: string): string {
	return text
		.replace(/\r\n?/gu, "\n")
		.replace(/^(?:[ \t]*\n)+/u, "")
		.replace(/\s+$/u, "");
}

export function isChecklist(tt: Pick<TtTask, "kind">): boolean {
	return tt.kind === "CHECKLIST";
}

/** Whether TickTick has text for the task: `content`, or a checklist's `desc` or at least one item. */
export function isEmptyDoc(doc: NoteDoc): boolean {
	return doc.text === "" && doc.items.length === 0;
}

function oneLine(s: string): string {
	return s.replace(/\s*\r?\n\s*/gu, " ").trim();
}

function itemLine(title: string, done: boolean): string {
	const t = oneLine(title);
	return `- [${done ? "x" : " "}]${t === "" ? "" : ` ${t}`}`;
}

/** An item line's tick and title; null for a line that is not an item. */
function parseItemLine(line: string): { done: boolean; title: string } | null {
	const m = ITEM_RE.exec(line);
	return m === null ? null : { done: m[2] !== " ", title: (m[3] ?? "").trim() };
}

/** TickTick's text of a task: `content`, or for a checklist `desc` and its items. */
export function docFromTickTick(tt: Pick<TtTask, "kind" | "content" | "desc" | "items">): NoteDoc {
	if (!isChecklist(tt)) return { text: normalizeNoteText(tt.content ?? ""), items: [] };
	return { text: normalizeNoteText(tt.desc ?? ""), items: (tt.items ?? []).map((i) => itemLine(i.title ?? "", (i.status ?? 0) !== 0)) };
}

/** Same text and the same item lines in the same order. */
export function sameDoc(a: NoteDoc, b: NoteDoc): boolean {
	return a.text === b.text && sameLines(a.items, b.items);
}

/** The canonical lines of a doc: the text, a blank line, the items. */
export function docLines(doc: NoteDoc): string[] {
	const out = textLines(doc.text);
	if (doc.items.length > 0) {
		if (out.length > 0) out.push("");
		out.push(...doc.items);
	}
	return out;
}

/** A doc read as the other kind (a task whose kind changed in TickTick): nothing is lost either way. */
export function asKind(doc: NoteDoc, checklist: boolean): NoteDoc {
	if (!checklist) return doc.items.length === 0 ? doc : { text: docLines(doc).join("\n"), items: [] };
	if (doc.items.length > 0) return doc;
	const text: string[] = [];
	const items: string[] = [];
	for (const line of textLines(doc.text)) {
		const item = parseItemLine(line);
		if (item === null) text.push(line);
		else items.push(itemLine(item.title, item.done));
	}
	return items.length === 0 ? doc : { text: normalizeNoteText(text.join("\n")), items };
}

/** What a link stores as the text of the last sync. */
export interface StoredNoteBase {
	noteBase: string;
	/** Checklists only: the item lines. */
	noteItems?: string[];
}

export function storedBase(doc: NoteDoc, checklist: boolean): StoredNoteBase {
	return checklist ? { noteBase: doc.text, noteItems: [...doc.items] } : { noteBase: doc.text };
}

/** The doc of the last sync, read as the task's kind now. */
export function baseDoc(link: { noteBase?: string; noteItems?: string[] }, checklist: boolean): NoteDoc {
	return asKind({ text: link.noteBase ?? "", items: link.noteItems ?? [] }, checklist);
}

// -- reading a note ------------------------------------------------------------------------------------------------

/** A note split at its frontmatter (`---` on the first line, up to the next `---` line). */
export function splitFrontmatter(note: string): { front: string; body: string } {
	const m = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)??---[ \t]*(?:\r?\n|$)/u.exec(note);
	return m === null ? { front: "", body: note } : { front: m[0], body: note.slice(m[0].length) };
}

/** A note body read for TickTick, line by line, with where each line came from. */
interface RenderedBody {
	/** The body's own lines (endings removed). */
	raw: string[];
	/** The lines TickTick sees, in order, before the blank lines at the ends of the text are dropped. */
	lines: string[];
	/** For each rendered line, its raw line. A raw line not listed (an embed alone) is hidden. */
	at: number[];
	/** For each rendered line, whether it is a checklist item. */
	item: boolean[];
}

/**
 * One line as TickTick sees it. Embeds go with the space they leave: at either end of the line, all of it; between
 * words, one space.
 */
function renderLine(line: string): { text: string; embed: boolean } {
	let embed = false;
	const text = line.replace(RENDER_RE, (m: string, target: string | undefined, alias: string | undefined, offset: number) => {
		if (m === "\\[[") return "[[";
		if (target === undefined && m.includes("![[")) {
			embed = true;
			const atEnd = offset === 0 || offset + m.length === line.length;
			return atEnd || !/^[ \t]|[ \t]$/u.test(m) ? "" : " ";
		}
		return alias ?? target ?? "";
	});
	return { text, embed };
}

/**
 * Reads a note body: links as their text, embeds dropped (a line of embeds alone is hidden). Code blocks are read
 * like any line: a fence's place in the note depends on the user's layout (items between lines), so treating it
 * apart would break the round trip; TickTick's `[[` inside code is escaped like anywhere else.
 */
function renderBody(body: string, checklist: boolean): RenderedBody {
	const raw = body.replace(/\r\n?/gu, "\n").split("\n");
	const out: RenderedBody = { raw, lines: [], at: [], item: [] };
	raw.forEach((line, i) => {
		const escaped = ESCAPED_ITEM_RE.exec(line);
		const r = renderLine(escaped === null ? line : `${escaped[1]}${escaped[2]}`);
		if (r.embed && r.text.trim() === "") return;
		const isItem = checklist && escaped === null && ITEM_RE.test(r.text);
		out.lines.push(r.text);
		out.at.push(i);
		out.item.push(isItem);
	});
	return out;
}

/** The note as TickTick's text: its text lines (blank ones at the ends dropped) and its items, with their raw lines. */
interface NoteView {
	text: string[];
	textAt: number[];
	items: string[];
	itemAt: number[];
}

function viewOf(r: RenderedBody): NoteView {
	const v: NoteView = { text: [], textAt: [], items: [], itemAt: [] };
	r.lines.forEach((line, k) => {
		if (r.item[k]) {
			const p = parseItemLine(line)!;
			v.items.push(itemLine(p.title, p.done));
			v.itemAt.push(r.at[k]!);
		} else {
			v.text.push(line);
			v.textAt.push(r.at[k]!);
		}
	});
	while (v.text.length > 0 && v.text[0]!.trim() === "") {
		v.text.shift();
		v.textAt.shift();
	}
	while (v.text.length > 0 && v.text[v.text.length - 1]!.trim() === "") {
		v.text.pop();
		v.textAt.pop();
	}
	if (v.text.length > 0) v.text[v.text.length - 1] = v.text[v.text.length - 1]!.replace(/\s+$/u, "");
	return v;
}

function docOfView(v: NoteView): NoteDoc {
	return { text: v.text.join("\n"), items: [...v.items] };
}

/** A whole note read as TickTick's text. */
export function readNote(note: string, checklist: boolean): NoteDoc {
	return docOfView(viewOf(renderBody(splitFrontmatter(note).body, checklist)));
}

// -- writing a note ------------------------------------------------------------------------------------------------

/** TickTick's `[[` written so the note reads it back as `[[` (not a link or an embed). */
function escapeLinks(s: string): string {
	return s.replace(/\[\[/gu, "\\[[");
}

/** A text line of TickTick's written into the note (outside code blocks). */
function escapeTextLine(line: string, checklist: boolean): string {
	return escapeLinks(line).replace(checklist ? ITEM_LIKE_RE : ESCAPED_LIKE_RE, "$1\\$2");
}

interface Markup {
	links: { raw: string; shown: string }[];
	embeds: string[];
}

function markupOf(raw: string): Markup {
	const m: Markup = { links: [], embeds: [] };
	for (const x of raw.matchAll(RENDER_RE)) {
		if (x[0] === "\\[[") continue;
		if (x[1] === undefined && x[0].includes("![[")) m.embeds.push(...(x[0].match(EMBED_RE) ?? []));
		else m.links.push({ raw: x[0], shown: x[2] ?? x[1] ?? "" });
	}
	return m;
}

function withEmbeds(line: string, embeds: readonly string[]): string {
	let out = line;
	for (const e of embeds) out = out === "" || out.endsWith(" ") ? `${out}${e}` : `${out} ${e}`;
	return out;
}

/**
 * `next` (TickTick's text) written over a raw line: each link of the raw line whose text is still in `next`, in
 * order, stays a link; the rest is escaped; the line's embeds follow at its end, or on a line of their own after a
 * line TickTick emptied (an embed alone on a line is not read, so the empty line stays).
 */
function keepMarkupLines(raw: string, next: string, escape: (s: string) => string): string[] {
	const m = markupOf(raw);
	if (next.trim() === "") return m.embeds.length === 0 ? [escape(next)] : [escape(next), m.embeds.join(" ")];
	return [keepMarkup(raw, next, escape)];
}

function keepMarkup(raw: string, next: string, escape: (s: string) => string): string {
	const m = markupOf(raw);
	let out = "";
	let cursor = 0;
	for (const link of m.links) {
		if (link.shown === "") continue;
		const at = next.indexOf(link.shown, cursor);
		if (at < 0) continue;
		out += escape(next.slice(cursor, at)) + link.raw;
		cursor = at + link.shown.length;
	}
	out += escape(next.slice(cursor));
	return withEmbeds(out, m.embeds);
}

/** An item's raw line changed to `next` (an item line): the box alone for a tick, the title by `keepMarkup`. */
function updateItemLine(raw: string, old: string, next: string): string {
	const m = RAW_ITEM_RE.exec(raw);
	const was = parseItemLine(old);
	const now = parseItemLine(next)!;
	if (m === null || was === null) return newItemLine(next);
	const box = now.done === (m[2] !== " ") ? m[2]! : now.done ? "x" : " ";
	const title = now.title === was.title ? m[4]! : keepMarkup(m[4]!, now.title, escapeLinks);
	const gap = title === "" ? "" : m[3]!.endsWith(" ") ? "" : " ";
	return `${m[1]}${box}${m[3]}${gap}${title}`;
}

function newItemLine(line: string): string {
	const p = parseItemLine(line)!;
	return itemLine("", p.done) + (p.title === "" ? "" : ` ${escapeLinks(p.title)}`);
}

/**
 * The note with its text and items changed to `target`, changing as little as it can (see the top of this file).
 * The frontmatter stays; `checklist` says how the note is read. Reading the result (`readNote`) gives `target`.
 */
export function writeNote(note: string, checklist: boolean, target: NoteDoc): string {
	const crlf = note.includes("\r\n");
	const { front, body } = splitFrontmatter(note);
	const r = renderBody(body, checklist);
	const v = viewOf(r);
	const before = new Map<number, string[]>();
	const after = new Map<number, string[]>();
	const replace = new Map<number, string[]>();
	const add = (m: Map<number, string[]>, k: number, lines: readonly string[]) => {
		if (lines.length > 0) m.set(k, [...(m.get(k) ?? []), ...lines]);
	};
	/** Where lines go when the note has nothing of their kind: after the last line read, before blank lines at the end. */
	const lastShown = ((): number => {
		const last = Math.max(v.textAt.at(-1) ?? -1, v.itemAt.at(-1) ?? -1);
		if (last >= 0) return last;
		for (let i = r.raw.length - 1; i >= 0; i--) if (r.raw[i]!.trim() !== "") return i;
		return -1;
	})();
	const removeLine = (rawIdx: number) => {
		// A removed line keeps its embeds, which TickTick never saw.
		const embeds = markupOf(r.raw[rawIdx]!).embeds;
		replace.set(rawIdx, embeds.length === 0 ? [] : [embeds.join(" ")]);
	};

	// The text.
	const next = textLines(target.text);
	const written = next.map((line) => escapeTextLine(line, checklist));
	for (const h of diffLines(v.text, next)) {
		const aLen = h.aEnd - h.aStart;
		const bLen = h.bEnd - h.bStart;
		const pairs = Math.min(aLen, bLen);
		for (let k = 0; k < pairs; k++) {
			const rawIdx = v.textAt[h.aStart + k]!;
			const i = h.bStart + k;
			replace.set(rawIdx, keepMarkupLines(r.raw[rawIdx]!, next[i]!, (s) => escapeTextLine(s, checklist)));
		}
		for (let k = pairs; k < aLen; k++) removeLine(v.textAt[h.aStart + k]!);
		const extra = written.slice(h.bStart + pairs, h.bEnd);
		if (extra.length === 0) continue;
		if (pairs > 0) add(after, v.textAt[h.aStart + pairs - 1]!, extra);
		else if (h.aStart > 0) add(after, v.textAt[h.aStart - 1]!, extra);
		else if (v.text.length > 0) add(before, v.textAt[0]!, extra);
		else if (v.items.length > 0) add(before, v.itemAt[0]!, [...extra, ""]);
		else add(after, lastShown, extra);
	}

	// The items.
	for (const h of diffLines(v.items, target.items)) {
		const aLen = h.aEnd - h.aStart;
		const bLen = h.bEnd - h.bStart;
		const pairs = Math.min(aLen, bLen);
		for (let k = 0; k < pairs; k++) {
			const rawIdx = v.itemAt[h.aStart + k]!;
			replace.set(rawIdx, [updateItemLine(r.raw[rawIdx]!, v.items[h.aStart + k]!, target.items[h.bStart + k]!)]);
		}
		for (let k = pairs; k < aLen; k++) removeLine(v.itemAt[h.aStart + k]!);
		const extra = target.items.slice(h.bStart + pairs, h.bEnd).map(newItemLine);
		if (extra.length === 0) continue;
		if (pairs > 0) add(after, v.itemAt[h.aStart + pairs - 1]!, extra);
		else if (h.aStart > 0) add(after, v.itemAt[h.aStart - 1]!, extra);
		else if (v.items.length > 0) add(before, v.itemAt[0]!, extra);
		else {
			// The first items of the note go after everything shown, behind a blank line after text.
			const lastLine = lastShown >= 0 ? (replace.get(lastShown)?.at(-1) ?? r.raw[lastShown]!) : "";
			const tailText = after.get(lastShown)?.at(-1) ?? lastLine;
			add(after, lastShown, tailText.trim() === "" ? extra : ["", ...extra]);
		}
	}

	if (replace.size === 0 && before.size === 0 && after.size === 0) return note;
	const out: string[] = [...(after.get(-1) ?? [])];
	r.raw.forEach((line, i) => {
		out.push(...(before.get(i) ?? []), ...(replace.get(i) ?? [line]), ...(after.get(i) ?? []));
	});
	const eol = crlf ? "\r\n" : "\n";
	let newBody = out.join(eol);
	// An empty body that gets text ends with a newline.
	if (body === "" && newBody !== "" && !newBody.endsWith(eol)) newBody += eol;
	if (front === "") {
		// Text that starts like frontmatter goes behind an empty one, so it stays text.
		return splitFrontmatter(newBody).front === "" ? newBody : `---${eol}---${eol}${newBody}`;
	}
	// A frontmatter with no line ending after it gets one before the body.
	return front.endsWith("\n") || newBody === "" ? front + newBody : front + eol + newBody;
}

// -- merging -------------------------------------------------------------------------------------------------------

function itemKey(line: string): string {
	return collapseWhitespace((parseItemLine(line)?.title ?? line).toLowerCase());
}

/**
 * Items both sides changed in one place: Logwell's lines stay, then TickTick's that are not the same item (by
 * title, ignoring case) as one of Logwell's; for the same item, the tick comes from the side that changed it. No
 * marker: every line stays an item.
 */
const keepBothItems: ConflictResolver = (ours, theirs, base) => {
	const out = [...ours];
	const baseDone = new Map(base.map((b) => [itemKey(b), parseItemLine(b)?.done]));
	for (const t of theirs) {
		const k = itemKey(t);
		const at = out.findIndex((o) => itemKey(o) === k);
		if (at < 0) {
			out.push(t);
			continue;
		}
		// The same item: Logwell's title; the tick of the side that changed it.
		const mine = parseItemLine(out[at]!);
		const was = baseDone.get(k);
		const done = parseItemLine(t)?.done;
		if (mine !== null && done !== undefined && was !== undefined && mine.done === was && done !== was) out[at] = itemLine(mine.title, done);
	}
	return out;
};

/**
 * The three-way merge of the note (`ours`), TickTick's text (`theirs`) and the last sync (`base`), all read as the
 * same kind. The text merges line by line with the marker; the items merge line by line too: a tick, an added or
 * removed item on one side applies; an item both sides changed is kept in both versions (once when the same title).
 */
export function mergeDocs(base: NoteDoc, ours: NoteDoc, theirs: NoteDoc): NoteDoc {
	return {
		text: normalizeNoteText(mergeText(base.text, ours.text, theirs.text)),
		items: mergeLines(base.items, ours.items, theirs.items, null, keepBothItems),
	};
}

// -- pushing -------------------------------------------------------------------------------------------------------

/**
 * What goes up to TickTick for the doc: `content` for a normal task; `desc` and the whole checklist for a checklist.
 * An item TickTick has (matched by its line, then a changed tick or a one-for-one change in place) is sent with every
 * field TickTick gave it (an update erases what it leaves out), its title and tick from the doc; a new item has no id.
 */
export function ttNoteWrite(doc: NoteDoc, checklist: boolean, current: readonly TtChecklistItem[]): TtTaskWrite {
	if (!checklist) return { content: doc.text };
	const lines = current.map((i) => itemLine(i.title ?? "", (i.status ?? 0) !== 0));
	const source: (TtChecklistItem | null)[] = doc.items.map(() => null);
	let ai = 0;
	let bi = 0;
	for (const h of diffLines(lines, doc.items)) {
		for (; ai < h.aStart; ai++, bi++) source[bi] = current[ai]!;
		const aLen = h.aEnd - h.aStart;
		const bLen = h.bEnd - h.bStart;
		for (let k = 0; k < Math.min(aLen, bLen); k++) {
			if (aLen === bLen || itemKey(lines[h.aStart + k]!) === itemKey(doc.items[h.bStart + k]!)) source[h.bStart + k] = current[h.aStart + k]!;
		}
		ai = h.aEnd;
		bi = h.bEnd;
	}
	for (; ai < current.length && bi < doc.items.length; ai++, bi++) source[bi] = current[ai]!;
	const items: TtChecklistItemWrite[] = doc.items.map((line, i) => {
		const p = parseItemLine(line)!;
		const was = source[i];
		return was === null ? { title: p.title, status: p.done ? 1 : 0 } : { ...was, title: p.title, status: p.done ? 1 : 0 };
	});
	return { desc: doc.text, items };
}
