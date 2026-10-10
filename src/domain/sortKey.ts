// Fractional sort keys. A key is a base-62 fraction (digits after the point),
// compared with plain code-unit order. keyBetween always returns a key
// strictly between its bounds, so items can be reordered by rewriting one key.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;

function digit(key: string, i: number): number {
	const ch = key[i];
	return ch === undefined ? 0 : DIGITS.indexOf(ch);
}

export function compareSortKeys(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Returns a key k with a < k < b. `a = null` means the start, `b = null` the
 * end. Keys never end in "0", so there is always room between two keys.
 */
export function keyBetween(a: string | null, b: string | null): string {
	const lo = a ?? "";
	if (b !== null && compareSortKeys(lo, b) >= 0) {
		throw new RangeError(`keyBetween: ${lo} is not before ${b}`);
	}
	let result = "";
	for (let i = 0; ; i++) {
		const dLo = digit(lo, i);
		const dHi = b === null ? BASE : i < b.length ? digit(b, i) : BASE;
		if (dHi - dLo > 1) {
			return result + DIGITS.charAt(Math.floor((dLo + dHi) / 2));
		}
		result += DIGITS.charAt(dLo);
		if (dHi - dLo === 1) {
			// The upper bound is no longer a constraint after this digit.
			return result + midAbove(lo, i + 1);
		}
	}
}

function midAbove(lo: string, from: number): string {
	let result = "";
	for (let i = from; ; i++) {
		const d = digit(lo, i);
		if (BASE - d > 1) return result + DIGITS.charAt(Math.floor((d + BASE) / 2));
		result += DIGITS.charAt(d);
	}
}

/** The key after the largest existing key. */
export function keyAfter(keys: Iterable<string>): string {
	let max: string | null = null;
	for (const k of keys) if (max === null || compareSortKeys(k, max) > 0) max = k;
	return keyBetween(max, null);
}

/**
 * New keys for an ordered list whose item `i` was just put at its place. `keys` are the current keys, in
 * the new order. When the other keys are strictly ascending, only item `i` gets a key, strictly between
 * its neighbours. Otherwise every item gets a new ascending key inside the open interval between the
 * nearest keys outside the list below and above it: `candidates` are the other records that share the
 * order's key space, `inList` says which of them are the list itself. Items that keep their key come back
 * with it.
 */
export function rekeyOrder<T extends { sortKey: string }>(keys: readonly string[], i: number, candidates: Iterable<T>, inList: (c: T) => boolean): string[] {
	const others = keys.filter((_, n) => n !== i);
	if (others.every((k, n) => n === 0 || others[n - 1]! < k)) {
		const next = [...keys];
		next[i] = keyBetween(i > 0 ? keys[i - 1]! : null, i < keys.length - 1 ? keys[i + 1]! : null);
		return next;
	}
	const minKey = keys.reduce((a, b) => (b < a ? b : a));
	const maxKey = keys.reduce((a, b) => (b > a ? b : a));
	let lo: string | null = null;
	let hi: string | null = null;
	for (const c of candidates) {
		if (inList(c)) continue;
		if (c.sortKey < minKey && (lo === null || c.sortKey > lo)) lo = c.sortKey;
		if (c.sortKey > maxKey && (hi === null || c.sortKey < hi)) hi = c.sortKey;
	}
	let key = lo;
	return keys.map(() => (key = keyBetween(key, hi)));
}
