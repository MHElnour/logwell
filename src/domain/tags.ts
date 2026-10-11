import { DomainError } from "./errors";
import type { Tag } from "./types";

// Key = NFC-normalized, trimmed, lowercased. Allowed characters are
// letters, digits, "-", "_" and "/".
const TAG_KEY_RE = /^[\p{L}\p{N}_/-]+$/u;

export function normalizeTagKey(raw: string): string {
	return tagDisplayName(raw).toLowerCase();
}

export function isValidTagKey(key: string): boolean {
	return TAG_KEY_RE.test(key);
}

/** Normalizes and validates; throws InvalidTag with a user-facing message. */
export function requireTagKey(raw: string): string {
	const key = normalizeTagKey(raw);
	if (!isValidTagKey(key)) {
		throw new DomainError(
			"InvalidTag",
			"Tags may contain only letters, digits, '-', '_' and '/'.",
		);
	}
	return key;
}

export const TAG_DEPTH_MESSAGE = "Tags can be nested one level deep, like work/calls.";

/**
 * A NEW key has at most one "/" (counted as characters, so "a//b" is refused). Keys already
 * in a file may be deeper and keep working, so callers check this only when they would create the tag.
 */
export function hasAllowedTagDepth(key: string): boolean {
	let slashes = 0;
	for (const ch of key) if (ch === "/" && ++slashes > 1) return false;
	return true;
}

/** Throws InvalidTag with a user-facing message when a new key is nested too deep. */
export function requireTagDepth(key: string): void {
	if (!hasAllowedTagDepth(key)) throw new DomainError("InvalidTag", TAG_DEPTH_MESSAGE);
}

/** The display name keeps the user's casing from the first creation. */
export function tagDisplayName(raw: string): string {
	return raw.normalize("NFC").trim().replace(/^@/, "");
}

// Parent tags. A "/" in a key makes a path: `programming/go` sits under `programming`.

/**
 * The segments of a key. A key with an empty segment ("a//b", "/a", "a/") is not a path:
 * it stays one flat segment, so it never gets a parent.
 */
export function tagPath(key: string): string[] {
	const parts = key.split("/");
	return parts.some((p) => p === "") ? [key] : parts;
}

/** The node keys on the way to `key`, itself last: `a/b/c` gives `a`, `a/b`, `a/b/c`. */
export function tagPrefixes(key: string): string[] {
	const path = tagPath(key);
	return path.map((_, i) => path.slice(0, i + 1).join("/"));
}

/** True for `parentKey` itself and for every descendant: `programming/go` is under `programming`, `programmingx` is not. */
export function isUnderTag(key: string, parentKey: string): boolean {
	// A cheap text test first: a key under `parentKey` is `parentKey` or starts with `parentKey/`.
	if (key !== parentKey && (key.length <= parentKey.length || !key.startsWith(parentKey) || key[parentKey.length] !== "/")) return false;
	// Compare path segments, not text, so a key with an empty segment ("a//b", "a/") agrees with the tree: it has no parent.
	const parent = tagPath(parentKey);
	const path = tagPath(key);
	return path.length >= parent.length && parent.every((segment, i) => path[i] === segment);
}

/** Whether a tag exists at `key` or under it: as a record, or as the path prefix of one (a parent). */
export function hasTagOrChild(keys: Iterable<string>, key: string): boolean {
	for (const k of keys) if (isUnderTag(k, key)) return true;
	return false;
}

export interface TagNode {
	key: string;
	/** The last path segment, in the user's casing. */
	name: string;
	/** The tag record; null for an implicit parent (a path prefix that is not a tag). */
	tag: Tag | null;
	/** Open tasks under this key, taken from the caller's counts (descendants included). */
	count: number;
	children: TagNode[];
}

/** The display segments of a tag: its display name split like its key, or the key's own segments. */
function displaySegments(tag: Tag, path: string[]): string[] {
	const parts = tag.displayName.split("/");
	return parts.length === path.length ? parts : path;
}

/** The tag list as a tree, with an implicit node for every path prefix that is not a tag. Siblings sort by name. */
export function tagTree(tags: Iterable<Tag>, counts: ReadonlyMap<string, number>): TagNode[] {
	const nodes = new Map<string, TagNode>();
	const roots: TagNode[] = [];
	const sorted = [...tags].sort((a, b) => a.displayName.localeCompare(b.displayName));
	for (const tag of sorted) {
		const path = tagPath(tag.key);
		const names = displaySegments(tag, path);
		let siblings = roots;
		const prefixes = tagPrefixes(tag.key);
		prefixes.forEach((key, i) => {
			let node = nodes.get(key);
			if (node === undefined) {
				node = { key, name: names[i]!, tag: null, count: counts.get(key) ?? 0, children: [] };
				nodes.set(key, node);
				siblings.push(node);
			}
			if (i === prefixes.length - 1) {
				node.tag = tag;
				node.name = names[i]!;
			}
			siblings = node.children;
		});
	}
	const sort = (list: TagNode[]) => {
		list.sort((a, b) => a.name.localeCompare(b.name));
		for (const n of list) sort(n.children);
	};
	sort(roots);
	return roots;
}

/** The full display name of a tag key: its record's, or for an implicit parent the prefix of a descendant's. */
export function tagDisplayPath(tags: ReadonlyMap<string, Tag>, key: string): string {
	const record = tags.get(key);
	if (record !== undefined) return record.displayName;
	const prefix = tagPath(key).length;
	for (const t of [...tags.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))) {
		if (!isUnderTag(t.key, key)) continue;
		return displaySegments(t, tagPath(t.key)).slice(0, prefix).join("/");
	}
	return key;
}

// A tag NAME (the last segment of its key: `calls` in `home/calls`) is used once, whatever its parent.
// Keys are lowercase, so names compare case-insensitively. An implicit parent (a path prefix with no record) is a name
// too. Duplicates already in a file keep working; the oldest tag owns the name. A tag never repeats its parent's name.

export const TAG_REPEAT_MESSAGE = "A tag can't have the same name as its parent.";

/** Whether a key uses one name twice in its path (`calls/calls`). */
export function hasRepeatedTagName(key: string): boolean {
	const path = tagPath(key);
	return new Set(path).size !== path.length;
}

/** The name of a key: its last path segment (a key with an empty segment is one flat segment). */
export function tagLeaf(key: string): string {
	const path = tagPath(key);
	return path[path.length - 1]!;
}

/** The tag names in use: each node of the tag tree (records and implicit parents) by its name. */
export class TagNames {
	/** Node key -> the oldest `createdAt` of its record and the records under it: what the node owns its name by. */
	private readonly nodes = new Map<string, string>();
	/** Name -> the node keys that use it (more than one only for duplicates already in a file). */
	private readonly byName = new Map<string, Set<string>>();

	static of(tags: Iterable<{ key: string; createdAt?: string }>): TagNames {
		const names = new TagNames();
		for (const t of tags) names.add(t.key, t.createdAt ?? "");
		return names;
	}

	/** Adds a tag key and its parent nodes. */
	add(key: string, createdAt = ""): void {
		const path = tagPath(key);
		tagPrefixes(key).forEach((node, i) => {
			const since = this.nodes.get(node);
			if (since === undefined || createdAt < since) this.nodes.set(node, createdAt);
			let set = this.byName.get(path[i]!);
			if (set === undefined) this.byName.set(path[i]!, (set = new Set()));
			set.add(node);
		});
	}

	clone(): TagNames {
		const copy = new TagNames();
		for (const [k, v] of this.nodes) copy.nodes.set(k, v);
		for (const [k, v] of this.byName) copy.byName.set(k, new Set(v));
		return copy;
	}

	/** Whether the key is a node of the tree (a tag or an implicit parent). */
	has(key: string): boolean {
		return this.nodes.has(key);
	}

	/** How many nodes use a name (more than one only for duplicates already in a file). */
	count(name: string): number {
		return this.byName.get(name)?.size ?? 0;
	}

	/**
	 * The node that owns a name: the oldest of those that use it (then the smaller key); undefined when unused. A node
	 * is as old as the older of its record and its oldest child, so giving an implicit parent a record never moves its
	 * name (and stops its children from syncing).
	 */
	owner(name: string): string | undefined {
		const set = this.byName.get(name);
		if (set === undefined) return undefined;
		const since = (key: string): string => this.nodes.get(key)!;
		let best: string | undefined;
		for (const key of set) {
			if (best === undefined) best = key;
			else {
				const a = since(key);
				const b = since(best);
				if (a < b || (a === b && key < best)) best = key;
			}
		}
		return best;
	}

	/** The existing node whose name a new key would use again (checked for the key's new nodes only), or null. */
	clash(key: string): string | null {
		const path = tagPath(key);
		const prefixes = tagPrefixes(key);
		for (let i = 0; i < prefixes.length; i++) {
			const node = prefixes[i]!;
			if (this.nodes.has(node)) continue;
			for (const other of this.byName.get(path[i]!) ?? []) if (other !== node) return other;
		}
		return null;
	}
}

/** The tag names of a tags map, memoized per map (a committed state's maps never change). */
const namesMemo = new WeakMap<ReadonlyMap<string, Tag>, TagNames>();
export function tagNamesOf(tags: ReadonlyMap<string, Tag>): TagNames {
	let names = namesMemo.get(tags);
	if (names === undefined) {
		names = TagNames.of(tags.values());
		namesMemo.set(tags, names);
	}
	return names;
}

/**
 * What a typed tag name stands for (Quick Add `@tag`, the tag field, the `tag:` filter of a task block): the node key,
 * or null. An exact node wins (a tag, or the parent of one); else a name alone (`calls`) finds the node that owns it,
 * the oldest when older files use it twice. A path that is no node (`work/calls`) finds nothing.
 */
export function resolveTagName(names: TagNames, typed: string): string | null {
	const key = normalizeTagKey(typed);
	if (key === "") return null;
	if (names.has(key)) return key;
	return tagPath(key).length === 1 ? (names.owner(key) ?? null) : null;
}

/**
 * How a tag is shown: its own name (`Calls` for `home/calls`), in the casing it was created with. A name that more than
 * one node uses (older files only) shows the full path, so each label still finds its own tag (`resolveTagName`).
 * Not for exports, which keep the full path.
 */
export function tagLabel(tags: ReadonlyMap<string, Tag>, key: string): string {
	const path = tagPath(key);
	const names = tagNamesOf(tags);
	if (path.length === 1 || names.count(path[path.length - 1]!) > 1 || !names.has(key)) return tags.get(key)?.displayName ?? tagDisplayPath(tags, key);
	const record = tags.get(key);
	const shown = record !== undefined ? displaySegments(record, path) : tagDisplayPath(tags, key).split("/");
	return shown[shown.length - 1]!;
}

/** Every tag with its label, sorted by label: the order of a tag menu or list, which shows labels. */
export function tagsByLabel(tags: ReadonlyMap<string, Tag>): { tag: Tag; label: string }[] {
	return [...tags.values()].map((tag) => ({ tag, label: tagLabel(tags, tag.key) })).sort((a, b) => a.label.localeCompare(b.label));
}

/** The existing tag node whose name a new key would repeat, or null. */
export function tagNameClash(keys: Iterable<string>, key: string): string | null {
	const names = new TagNames();
	for (const k of keys) names.add(k);
	return names.clash(key);
}

/** `The name "Calls" is already used by another tag.`, with the existing tag shown as `tagLabel` does. */
export function tagNameClashMessage(tags: ReadonlyMap<string, Tag>, existingKey: string): string {
	return `The name "${tagLabel(tags, existingKey)}" is already used by another tag.`;
}

/** Why a new key cannot be created (its name is taken, or it repeats its parent's), or null. */
export function tagNameRefusal(tags: ReadonlyMap<string, Tag>, key: string): string | null {
	if (hasRepeatedTagName(key)) return TAG_REPEAT_MESSAGE;
	const clash = tagNameClash(tags.keys(), key);
	return clash === null ? null : tagNameClashMessage(tags, clash);
}

/** Throws InvalidTag when a new key would use a name another tag already has, or its parent's. */
export function requireUniqueTagName(tags: ReadonlyMap<string, Tag>, key: string): void {
	const refusal = tagNameRefusal(tags, key);
	if (refusal !== null) throw new DomainError("InvalidTag", refusal);
}
