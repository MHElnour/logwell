import { clamp } from "../domain/text";
import { charBefore, isTokenChar, tokenRunEnd, tokenStartAllowed } from "./text";
import type { Span } from "./types";

export interface CursorToken {
	kind: "category" | "tag" | "note";
	span: Span;
	/** The text after the trigger, up to the cursor. */
	query: string;
}

function noteTokenAt(input: string, c: number): CursorToken | null {
	const open = c >= 2 ? input.lastIndexOf("[[", c - 2) : -1;
	if (open === -1) return null;
	const nl = input.indexOf("\n", open + 2);
	if (nl !== -1 && nl < c) return null;
	const close = input.indexOf("]]", open + 2);
	const inner = input.indexOf("[[", open + 2);
	const closed = close !== -1 && (nl === -1 || close < nl) && (inner === -1 || inner > close);
	if (closed) {
		if (c >= close + 2) return null; // at or after the closing brackets: the link is done
		return { kind: "note", span: { start: open, end: close + 2 }, query: input.slice(open + 2, Math.min(c, close)) };
	}
	return { kind: "note", span: { start: open, end: c }, query: input.slice(open + 2, c) };
}

function wordTokenAt(input: string, c: number): CursorToken | null {
	let i = c;
	for (;;) {
		const ch = charBefore(input, i);
		if (ch === "#" || ch === "@") {
			const start = i - 1;
			if (!tokenStartAllowed(input, start)) return null;
			return {
				kind: ch === "#" ? "category" : "tag",
				span: { start, end: tokenRunEnd(input, c) },
				query: input.slice(start + 1, c),
			};
		}
		if (!isTokenChar(ch)) return null;
		i -= ch.length;
	}
}

/** The #, @ or [[ token that contains or ends at the cursor, for the suggesters. */
export function tokenAtCursor(input: string, cursor: number): CursorToken | null {
	const c = clamp(Math.trunc(Number.isFinite(cursor) ? cursor : 0), 0, input.length);
	return noteTokenAt(input, c) ?? wordTokenAt(input, c);
}
