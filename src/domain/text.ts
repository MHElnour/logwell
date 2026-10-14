// Small text and number helpers shared by every layer. Pure.

/** `n` kept within `lo` to `hi`; `lo` wins when `hi` is below it (an empty range). */
export function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

/** "high" becomes "High". */
export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "1 task", "3 tasks": the count and the word, plural by adding an s unless `many` is given ("entry", "entries"). */
export function plural(n: number, word: string, many = `${word}s`): string {
	return `${n} ${n === 1 ? word : many}`;
}

/** Typed text as names and titles are kept: Unicode NFC, the ends trimmed. */
export function normalizedText(raw: string): string {
	return raw.normalize("NFC").trim();
}

/** Every line ending ("\r\n", "\r") as "\n". */
export function unixLineEnds(s: string): string {
	return s.replace(/\r\n?/gu, "\n");
}

/** Runs of whitespace become one space and the ends are trimmed. */
export function collapseWhitespace(s: string): string {
	return s.replace(/\s+/gu, " ").trim();
}

/**
 * A deep copy with every object's keys sorted and undefined values left out: the file's record form, and (stringified)
 * a key-order-independent comparison of values built in different places.
 */
export function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value).sort()) {
			const v = (value as Record<string, unknown>)[k];
			if (v !== undefined) out[k] = canonical(v);
		}
		return out;
	}
	return value;
}
