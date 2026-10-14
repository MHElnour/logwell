import { DomainError } from "./errors";
import type { Tag } from "./types";

// Key = NFC-normalized, trimmed, lowercased. Allowed characters are
// letters, digits, "-", "_" and "/".
const TAG_KEY_RE = /^[\p{L}\p{N}_/-]+$/u;

export function normalizeTagKey(raw: string): string {
	return tagDisplayName(raw).toLowerCase();
}

/** The key of a tag named `leaf` (already a key segment) under the tag key `parent`, or at the top for null. */
export function childTagKey(parent: string | null, leaf: string): string {
	return parent === null ? leaf : `${parent}/${leaf}`;
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

/** The longest name a NEW tag may have, in UTF-16 code units (the dialog input's `maxlength`). Stored names keep any length. */
export const TAG_NAME_MAX = 64;
export const TAG_LENGTH_MESSAGE = `Use at most ${TAG_NAME_MAX} characters.`;
/** Tags nest one level deep, so a tag with children stays at the top (the Edit tag dialog's locked Parent). */
export const TAG_WITH_CHILDREN_MESSAGE = "A tag with child tags has no parent.";
/** A key with an empty segment (`a//b`, older files only) is one flat tag: under a parent it would not be a path. */
export const TAG_FLAT_PARENT_MESSAGE = 'A tag with "/" in its name has no parent.';

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

/** The path prefixes of `key`, itself last: `a/b/c` gives `a`, `a/b`, `a/b/c`. */
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

export interface TagNode {
	key: string;
	/** The last path segment, in the user's casing. */
	name: string;
	/** The tag record: every node is a tag. */
	tag: Tag;
	/** Open tasks under this key, taken from the caller's counts (descendants included). */
	count: number;
	children: TagNode[];
}

/** A tag's display name split into one part per key segment, or null when it splits differently (an older file). */
export function tagDisplaySegments(tag: Tag): string[] | null {
	const parts = tag.displayName.split("/");
	return parts.length === tagPath(tag.key).length ? parts : null;
}

/** The display segments of a tag: its display name split like its key, or the key's own segments. */
function displaySegments(tag: Tag, path: string[]): string[] {
	return tagDisplaySegments(tag) ?? path;
}

/** A tag's own name in its casing (`Calls` for `Home/Calls`): the Edit tag dialog's name. A flat key keeps its whole name. */
export function tagDisplayLeaf(tag: Tag): string {
	const path = tagPath(tag.key);
	if (path.length === 1) return tag.displayName;
	return displaySegments(tag, path)[path.length - 1]!;
}

/**
 * The tag records as a tree: each tag under its parent's record. A child whose parent has no record (a broken file)
 * shows at the top rather than not at all. Siblings sort by name.
 */
export function tagTree(tags: Iterable<Tag>, counts: ReadonlyMap<string, number>): TagNode[] {
	const nodes = new Map<string, TagNode>();
	for (const tag of tags) {
		// A key with an empty segment (an older file) is named by its key: its display name splits differently.
		const path = tagPath(tag.key);
		nodes.set(tag.key, { key: tag.key, name: displaySegments(tag, path)[path.length - 1]!, tag, count: counts.get(tag.key) ?? 0, children: [] });
	}
	const roots: TagNode[] = [];
	for (const node of nodes.values()) {
		const path = tagPath(node.key);
		const parent = path.length > 1 ? nodes.get(path.slice(0, -1).join("/")) : undefined;
		(parent?.children ?? roots).push(node);
	}
	const sort = (list: TagNode[]) => {
		list.sort((a, b) => a.name.localeCompare(b.name));
		for (const n of list) sort(n.children);
	};
	sort(roots);
	return roots;
}

/** The full display name of a tag key: its record's, or the key when there is no record. */
export function tagDisplayPath(tags: ReadonlyMap<string, Tag>, key: string): string {
	return tags.get(key)?.displayName ?? key;
}

// A tag NAME (the last segment of its key: `calls` in `home/calls`) is used once, whatever its parent.
// Keys are lowercase, so names compare case-insensitively. Duplicates already in a file keep working; the oldest tag owns
// the name. A tag never repeats its parent's name.

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

/** The tag names in use: each tag record by its name. */
export class TagNames {
	/** Tag key -> its record's `createdAt`: what the tag owns its name by. */
	private readonly since = new Map<string, string>();
	/** Name -> the tag keys that use it (more than one only for duplicates already in a file). */
	private readonly byName = new Map<string, Set<string>>();

	static of(tags: Iterable<{ key: string; createdAt?: string }>): TagNames {
		const names = new TagNames();
		for (const t of tags) names.add(t.key, t.createdAt ?? "");
		return names;
	}

	/** Adds a tag key under its name. */
	add(key: string, createdAt = ""): void {
		const name = tagLeaf(key);
		this.since.set(key, createdAt);
		let set = this.byName.get(name);
		if (set === undefined) this.byName.set(name, (set = new Set()));
		set.add(key);
	}

	clone(): TagNames {
		const copy = new TagNames();
		for (const [k, v] of this.since) copy.since.set(k, v);
		for (const [k, v] of this.byName) copy.byName.set(k, new Set(v));
		return copy;
	}

	/** Whether the key is a tag. */
	has(key: string): boolean {
		return this.since.has(key);
	}

	/** How many tags use a name (more than one only for duplicates already in a file). */
	count(name: string): number {
		return this.byName.get(name)?.size ?? 0;
	}

	/** The tag that owns a name: the oldest of those that use it (then the smaller key); undefined when unused. */
	owner(name: string): string | undefined {
		const set = this.byName.get(name);
		if (set === undefined) return undefined;
		const age = (key: string): string => this.since.get(key)!;
		let best: string | undefined;
		for (const key of set) {
			if (best === undefined) best = key;
			else {
				const a = age(key);
				const b = age(best);
				if (a < b || (a === b && key < best)) best = key;
			}
		}
		return best;
	}

	/**
	 * Whether a new key, or the missing parent created with it, has a name longer than `TAG_NAME_MAX`. Existing tags
	 * keep any length.
	 */
	tooLong(key: string): boolean {
		const path = tagPath(key);
		return tagPrefixes(key).some((prefix, i) => !this.since.has(prefix) && path[i]!.length > TAG_NAME_MAX);
	}

	/**
	 * The existing tag whose name a new key would use again, or null. A missing parent is created with the key, so its
	 * name is checked too; an existing parent is not.
	 */
	clash(key: string): string | null {
		const path = tagPath(key);
		const prefixes = tagPrefixes(key);
		for (let i = 0; i < prefixes.length; i++) {
			const prefix = prefixes[i]!;
			if (this.since.has(prefix)) continue;
			for (const other of this.byName.get(path[i]!) ?? []) if (other !== prefix) return other;
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
 * What a typed tag name stands for (Quick Add `@tag`, the tag field, the `tag:` filter of a task block): the tag key,
 * or null. An exact key wins; else a name alone (`calls`) finds the tag that owns it, the oldest when older files use
 * it twice. A path that is no tag (`work/calls`) finds nothing.
 */
export function resolveTagName(names: TagNames, typed: string): string | null {
	const key = normalizeTagKey(typed);
	if (key === "") return null;
	if (names.has(key)) return key;
	return tagPath(key).length === 1 ? (names.owner(key) ?? null) : null;
}

/**
 * `resolveTagName` over a typed list (the `tag:` filter of a task block): the keys in typed order with a repeated key
 * dropped, or the first typed name that is no tag, as typed.
 */
export function resolveTagNames(names: TagNames, typed: readonly string[]): { keys: string[] } | { unknown: string } {
	const keys: string[] = [];
	for (const name of typed) {
		const key = resolveTagName(names, name);
		if (key === null) return { unknown: name };
		if (!keys.includes(key)) keys.push(key);
	}
	return { keys };
}

/**
 * How a tag is shown: its own name (`Calls` for `home/calls`), in the casing it was created with. A name that more than
 * one tag uses (older files only) shows the full path, so each label still finds its own tag (`resolveTagName`).
 * Not for exports, which keep the full path.
 */
export function tagLabel(tags: ReadonlyMap<string, Tag>, key: string): string {
	const path = tagPath(key);
	const names = tagNamesOf(tags);
	const record = tags.get(key);
	if (record === undefined || path.length === 1 || names.count(path[path.length - 1]!) > 1) return tagDisplayPath(tags, key);
	return tagDisplayLeaf(record);
}

/** Every tag with its label, sorted by label: the order of a tag menu or list, which shows labels. */
export function tagsByLabel(tags: ReadonlyMap<string, Tag>): { tag: Tag; label: string }[] {
	return [...tags.values()].map((tag) => ({ tag, label: tagLabel(tags, tag.key) })).sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * `The name "Calls" is already used by another tag.`: the name only, in the existing tag's casing. It reads no memoized
 * names, because `tags` may be the working map of a write that is still changing.
 */
export function tagNameClashMessage(tags: ReadonlyMap<string, Tag>, existingKey: string): string {
	const record = tags.get(existingKey);
	const name = record === undefined ? tagLeaf(existingKey) : tagDisplayLeaf(record);
	return `The name "${name}" is already used by another tag.`;
}

/**
 * Why a new key cannot be created (it repeats its parent's name, a new name is longer than 64 characters, or its name
 * is taken), or null. `keepLength` skips the length rule, for a stored name that is kept as it is.
 */
export function tagNameRefusal(tags: ReadonlyMap<string, Tag>, key: string, keepLength = false): string | null {
	if (hasRepeatedTagName(key)) return TAG_REPEAT_MESSAGE;
	const names = TagNames.of(tags.values());
	if (!keepLength && names.tooLong(key)) return TAG_LENGTH_MESSAGE;
	const clash = names.clash(key);
	return clash === null ? null : tagNameClashMessage(tags, clash);
}

/** Throws InvalidTag when a new key would use a name another tag already has, or its parent's. */
export function requireUniqueTagName(tags: ReadonlyMap<string, Tag>, key: string): void {
	const refusal = tagNameRefusal(tags, key);
	if (refusal !== null) throw new DomainError("InvalidTag", refusal);
}

// The name typed in the New tag and Edit tag dialogs: one word of letters, digits, "-" and "_".

/** What the New tag and Edit tag dialogs say for an empty name. */
export const TAG_NAME_EMPTY_MESSAGE = "Enter a name.";

const TAG_NAME_RE = /^[\p{L}\p{N}_-]+$/u;

/**
 * The first problem of a typed tag name, or null: empty, spaces, "/" (unless `allowPath`, for the tag field), a
 * leading "@", other characters, then more than 64 characters (per segment with a path).
 */
export function tagNameTextProblem(typed: string, allowPath = false): string | null {
	const name = typed.normalize("NFC").trim();
	if (name === "") return TAG_NAME_EMPTY_MESSAGE;
	if (/\s/u.test(name)) return "Use one word: spaces are not allowed. Try a hyphen, like phone-calls.";
	if (!allowPath && name.includes("/")) return 'Pick a parent below instead of typing "/".';
	if (name.startsWith("@")) return 'Leave out the "@"; it is added for you.';
	if (!(allowPath ? TAG_KEY_RE : TAG_NAME_RE).test(name)) return "Only letters, digits, hyphens (-) and underscores (_) are allowed.";
	if (name.split("/").some((segment) => segment.length > TAG_NAME_MAX)) return TAG_LENGTH_MESSAGE;
	return null;
}

/**
 * Why `name` under `parent` (a top-level tag key, or null) cannot be saved, or null: the one check of the New tag and
 * Edit tag dialogs and of `TagService.add` and `edit`. `except` is the key of the tag being edited: it and its children
 * leave the names in use, so its own name is allowed, and each child keeps its name under the new one. An unchanged
 * stored name skips the text and length rules, so a name from an older file is never refused.
 */
export function newTagProblem(tags: ReadonlyMap<string, Tag>, name: string, parent: string | null, except: string | null = null): string | null {
	const leaf = normalizeTagKey(name);
	const own = except !== null && leaf === tagLeaf(except);
	if (!own) {
		const text = tagNameTextProblem(name);
		if (text !== null) return text;
	}
	const key = childTagKey(parent, leaf);
	// The same key (a new casing or color only): the tree's names do not change, so even an older duplicate is kept.
	if (key === except) return null;
	let pool = tags;
	if (except !== null) {
		const remaining = new Map<string, Tag>();
		for (const [k, t] of tags) {
			if (!isUnderTag(k, except)) remaining.set(k, t);
			// A child keeps its name under the new one: `home/calls` cannot become `calls/calls`.
			else if (k !== except && hasRepeatedTagName(key + k.slice(except.length))) return tagNameClashMessage(tags, k);
		}
		pool = remaining;
	}
	// A tag already at this key: the name is in use (a rename never merges two tags).
	if (pool.has(key)) return tagNameClashMessage(pool, key);
	return tagNameRefusal(pool, key, own);
}
