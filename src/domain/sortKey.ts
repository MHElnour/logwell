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
 * New keys after `order[i]` was put at its place in `order`, records in their new order whose other records are
 * in the key space's sort order. `outside` are the other records that share the key space (none of `order`), and
 * `compare` is that sort order (`sortKey` first, then a tie-break). Returns each record whose key changes, with
 * its new key. Every two records other than `order[i]` keep their order:
 * - When the other keys of `order` are strictly ascending, only `order[i]` gets a key, strictly between its
 *   neighbours.
 * - Otherwise each run of `order` records that no outside record splits is rekeyed on its own, inside the keys of
 *   the outside records around it: the run that `order[i]` joins (after `order[i - 1]`, or before `order[1]`),
 *   and every run whose keys are not strictly ascending. Outside records keep their keys unless the two around a
 *   run share one key, so no key fits between them: then the records that hold that key are rekeyed too, in order.
 */
export function rekeyOrder<T extends { sortKey: string }>(order: readonly T[], i: number, outside: Iterable<T>, compare: (a: T, b: T) => number): Map<T, string> {
	const moved = order[i]!;
	const others = order.filter((_, n) => n !== i);
	if (others.every((t, n) => n === 0 || others[n - 1]!.sortKey < t.sortKey)) {
		return new Map([[moved, keyBetween(i > 0 ? order[i - 1]!.sortKey : null, i < order.length - 1 ? order[i + 1]!.sortKey : null)]]);
	}
	// Every record in its order after the move: the outside ones by `compare`, each other record of `order` after
	// the outside ones that sort before it, and `moved` next to its neighbour in `order`.
	const fixed = [...outside].sort(compare);
	const seq: T[] = [];
	let f = 0;
	for (const t of others) {
		while (f < fixed.length && compare(fixed[f]!, t) < 0) seq.push(fixed[f++]!);
		seq.push(t);
	}
	while (f < fixed.length) seq.push(fixed[f++]!);
	seq.splice(i > 0 ? seq.indexOf(order[i - 1]!) + 1 : seq.indexOf(order[1]!), 0, moved);

	const keys = new Map<T, string>();
	const keyOf = (t: T) => keys.get(t) ?? t.sortKey;
	const before = (a: T, b: T) => (keys.has(a) || keys.has(b) ? keyOf(a) < keyOf(b) : compare(a, b) < 0);
	const inOrder = new Set(order);
	for (let start = 0; start < seq.length; ) {
		if (!inOrder.has(seq[start]!)) {
			start++;
			continue;
		}
		let end = start;
		while (end < seq.length && inOrder.has(seq[end]!)) end++;
		let fits = (start === 0 || before(seq[start - 1]!, seq[start]!)) && (end === seq.length || before(seq[end - 1]!, seq[end]!));
		for (let n = start; fits && n < end; n++) fits = seq[n] !== moved && (n === start || keyOf(seq[n - 1]!) < keyOf(seq[n]!));
		if (fits) {
			start = end;
			continue;
		}
		let lo = start > 0 ? keyOf(seq[start - 1]!) : null;
		let hi = end < seq.length ? keyOf(seq[end]!) : null;
		if (lo !== null && hi !== null && lo >= hi) {
			// No key between the two outside records: take in every record next to them that holds such a key.
			const [low, high] = [hi, lo];
			while (start > 0 && keyOf(seq[start - 1]!) >= low) start--;
			while (end < seq.length && keyOf(seq[end]!) <= high) end++;
			lo = start > 0 ? keyOf(seq[start - 1]!) : null;
			hi = end < seq.length ? keyOf(seq[end]!) : null;
		}
		let key = lo;
		for (let n = start; n < end; n++) keys.set(seq[n]!, (key = keyBetween(key, hi)));
		start = end;
	}
	for (const [t, key] of keys) if (key === t.sortKey) keys.delete(t);
	return keys;
}
