import { charAt, charBefore, isWordChar } from "./text";
import type { SpanDecision } from "./types";

/**
 * Shifts decisions after an edit from `prev` to `next`.
 *
 * The edit is the common-prefix / common-suffix difference. A decision entirely
 * before it is unchanged, one entirely after it moves by the length delta, and
 * one the edit touches or lies inside is dropped. Typing a word character
 * directly against a span (for example "tomorrow" becoming "tomorrowx") touches
 * it; typing a space or punctuation next to it does not, so a dismissed span
 * survives the user carrying on typing.
 */
export function rebaseDecisions(prev: string, next: string, decisions: readonly SpanDecision[]): SpanDecision[] {
	if (prev === next) return decisions.map((d) => ({ ...d, span: { ...d.span } }));
	const max = Math.min(prev.length, next.length);
	let prefix = 0;
	while (prefix < max && prev.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
	let suffix = 0;
	while (suffix < max - prefix && prev.charCodeAt(prev.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)) suffix++;
	const editStart = prefix;
	const prevEditEnd = prev.length - suffix;
	const nextEditEnd = next.length - suffix;
	const delta = next.length - prev.length;
	const removed = prev.slice(editStart, prevEditEnd);
	const inserted = next.slice(editStart, nextEditEnd);

	// Does the edit put a word character against the end / the start of a span?
	const wordAfter = isWordChar(charAt(inserted, 0)) || isWordChar(charAt(removed, 0));
	const wordBefore = isWordChar(charBefore(inserted, inserted.length)) || isWordChar(charBefore(removed, removed.length));

	const out: SpanDecision[] = [];
	for (const d of decisions) {
		const { start, end } = d.span;
		if (end < editStart || (end === editStart && !wordAfter)) {
			out.push({ ...d, span: { start, end } });
		} else if (start > prevEditEnd || (start === prevEditEnd && !wordBefore)) {
			out.push({ ...d, span: { start: start + delta, end: end + delta } });
		}
	}
	return out;
}
