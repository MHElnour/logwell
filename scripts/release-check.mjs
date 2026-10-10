#!/usr/bin/env node
// Release checks and the version-bump step. Node only, no dependencies.
// See docs/development/releasing.md.
//
// Release notes live in docs/releases/: `unreleased.md` collects the entries, and every version gets its
// own `<version>.md`. `README.md` there is the generated index.
//
//   node scripts/release-check.mjs pre [patch|minor|major|<x.y.z>]   npm "preversion"
//   node scripts/release-check.mjs version <newVersion>              npm "version"
//   node scripts/release-check.mjs verify <tag>                      CI, prints the release notes
//   node scripts/release-check.mjs lint                              CI, light check of unreleased.md and the index
//   node scripts/release-check.mjs index                             rewrites docs/releases/README.md
//
// How the `pre` stage learns the bump type (first match wins):
//   1. an explicit CLI argument (patch, minor, major or an exact version);
//   2. npm's `npm_new_version` against `npm_old_version` (npm sets both during
//      preversion; checked on npm 12) or, failing that, the version in package.json;
//   3. otherwise the bump rule is skipped with a note. The structure checks still run.
// `npm_config_argv` is not used: npm 7+ no longer sets it.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED_HEADINGS = ["Added", "Changed", "Fixed", "Removed", "Security"];
// A patch release may only carry these; Added, Changed and Removed need a minor bump.
export const PATCH_HEADINGS = ["Fixed", "Security"];
export const RELEASES_DIR = "docs/releases";
export const UNRELEASED_FILE = `${RELEASES_DIR}/unreleased.md`;
export const INDEX_FILE = `${RELEASES_DIR}/README.md`;

/** unreleased.md as it is after a release (and as the first line of a new project). */
export const EMPTY_UNRELEASED = `# Unreleased

<!--
Changes that are not released yet. \`npm version\` moves the entries into docs/releases/<version>.md and puts this
template back.

Rules
- Every change a user can notice adds a line in the commit that makes it. Tests, refactors and documentation of
  internals are not user-visible: no line.
- Put the line under one of the sections below, and delete nothing: empty sections are fine.
- A patch release (0.x.Y) may contain only Fixed and Security. Added and Changed need a minor release.
- Credit the reporter and name the issue when a change comes from a GitHub issue:
  - (#12) Fixed the calendar showing a task twice on the day it repeats. Thanks to @user for reporting.
- A change that does not come from an issue has no number and no thanks.
- Write for someone who uses the plugin: what they see now, not how the code changed.

Sections: Added, Changed, Fixed, Security (Removed is also accepted, for a minor release).
-->

## Added

## Changed

## Fixed

## Security
`;

const TAG_RE = /^\d+\.\d+\.\d+$/;
const BULLET_RE = /^\s*[-*+]\s+\S/;

export class ReleaseError extends Error {}

function fail(message) {
	throw new ReleaseError(message);
}

/** Remove `<!-- ... -->` comments (the template's examples must not count as entries). */
export function stripComments(text) {
	return text.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Parse a notes file into its `## ` groups: { heading, bullets, lines }. `lines` are the group's body lines
 * with the blank edges trimmed. `stray` counts entries that sit before the first `## ` heading.
 */
export function parseGroups(text) {
	const groups = [];
	let current = null;
	let stray = 0;
	for (const line of stripComments(text).split("\n")) {
		const h = /^##\s+(\S.*?)\s*$/.exec(line);
		if (h) {
			current = { heading: h[1], bullets: 0, lines: [] };
			groups.push(current);
		} else if (current) {
			current.lines.push(line);
			if (BULLET_RE.test(line)) current.bullets++;
		} else if (BULLET_RE.test(line)) {
			stray++;
		}
	}
	for (const g of groups) {
		while (g.lines.length > 0 && g.lines[0].trim() === "") g.lines.shift();
		while (g.lines.length > 0 && g.lines[g.lines.length - 1].trim() === "") g.lines.pop();
	}
	return { groups, stray };
}

function checkHeadings(groups, stray, where) {
	for (const g of groups) {
		if (!ALLOWED_HEADINGS.includes(g.heading)) {
			fail(`${where}: unknown heading "## ${g.heading}". Allowed: ${ALLOWED_HEADINGS.map((h) => `## ${h}`).join(", ")}.`);
		}
	}
	if (stray > 0) fail(`${where}: ${stray} entr${stray === 1 ? "y sits" : "ies sit"} outside a ## heading. Put each under one of: ${ALLOWED_HEADINGS.join(", ")}.`);
}

/** The bump between two x.y.z versions: "major", "minor", "patch", or null when not an increase. */
export function bumpType(oldV, newV) {
	if (!TAG_RE.test(oldV) || !TAG_RE.test(newV)) return null;
	const [a, b] = [oldV, newV].map((v) => v.split(".").map(Number));
	if (b[0] > a[0]) return "major";
	if (b[0] === a[0] && b[1] > a[1]) return "minor";
	if (b[0] === a[0] && b[1] === a[1] && b[2] > a[2]) return "patch";
	return null;
}

/** Resolve the bump from a CLI arg, else the npm lifecycle environment. Returns "patch" | "minor" | "major" | null. */
export function resolveBump(arg, env, currentVersion) {
	if (arg === "patch" || arg === "minor" || arg === "major") return arg;
	if (arg !== undefined && arg !== "") {
		const t = bumpType(currentVersion, arg);
		if (!t) fail(`Cannot read "${arg}" as a bump. Use patch, minor, major or a version above ${currentVersion}.`);
		return t;
	}
	if (env.npm_new_version) return bumpType(env.npm_old_version || currentVersion, env.npm_new_version);
	return null;
}

/** The guard before a version bump: unreleased.md needs entries, and a patch may only carry Fixed and Security. */
export function preCheck(unreleased, bump) {
	const { groups, stray } = parseGroups(unreleased);
	checkHeadings(groups, stray, UNRELEASED_FILE);
	const withEntries = groups.filter((g) => g.bullets > 0);
	if (withEntries.length === 0) {
		fail(`${UNRELEASED_FILE} has no entries. Add at least one bullet under Added, Changed, Fixed, Removed or Security before releasing.`);
	}
	if (bump === "patch") {
		const bad = withEntries.filter((g) => !PATCH_HEADINGS.includes(g.heading)).map((g) => g.heading);
		if (bad.length > 0) {
			fail(`A patch release may only list Fixed and Security, but ${UNRELEASED_FILE} has entries under ${bad.join(", ")}. Run \`npm version minor\` instead.`);
		}
	}
	return { bump, headings: withEntries.map((g) => g.heading) };
}

/** The light CI check: unreleased.md only has known headings and no loose entries (it may be empty). */
export function lintUnreleased(unreleased) {
	const { groups, stray } = parseGroups(unreleased);
	checkHeadings(groups, stray, UNRELEASED_FILE);
}

/** The groups that have entries, as `## Heading` blocks, entries verbatim. Empty groups are dropped. */
export function renderEntries(unreleased) {
	const { groups } = parseGroups(unreleased);
	return groups
		.filter((g) => g.bullets > 0)
		.map((g) => `## ${g.heading}\n\n${g.lines.join("\n")}\n`)
		.join("\n");
}

/** A release file: title, date line, then the entries. */
export function renderRelease(version, date, entries) {
	return `# ${version}\n\nReleased ${date}.\n\n${entries.trim()}\n`;
}

/** Split a release file into { version, date, body }. Returns null when it does not have the title and date lines. */
export function parseRelease(text) {
	const m = /^# (\d+\.\d+\.\d+)\s*\n\s*\nReleased (\d{4}-\d{2}-\d{2})\.\s*\n/.exec(text);
	if (!m) return null;
	return { version: m[1], date: m[2], body: text.slice(m[0].length).trim() };
}

function compareVersions(a, b) {
	const [x, y] = [a, b].map((v) => v.split(".").map(Number));
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
}

/** The generated docs/releases/README.md. `releases` is [{ version, date }] in any order. */
export function buildIndex(releases) {
	const lines = [...releases].sort((a, b) => compareVersions(b.version, a.version)).map((r) => `- [${r.version}](${r.version}.md): ${r.date}`);
	return `# Release notes

One file per version, newest first. What is not released yet is in [Unreleased](unreleased.md).

<!-- This list is generated by \`npm version\` (node scripts/release-check.mjs index). Do not edit it by hand. -->

${lines.join("\n")}
`;
}

/** Read every docs/releases/<x.y.z>.md. */
export function readReleases(root) {
	const dir = join(root, RELEASES_DIR);
	const out = [];
	for (const name of readdirSync(dir)) {
		const m = /^(\d+\.\d+\.\d+)\.md$/.exec(name);
		if (!m) continue;
		const parsed = parseRelease(readFileSync(join(dir, name), "utf8"));
		if (!parsed) fail(`${RELEASES_DIR}/${name} must start with "# ${m[1]}", a blank line and "Released YYYY-MM-DD.".`);
		if (parsed.version !== m[1]) fail(`${RELEASES_DIR}/${name} has the title "# ${parsed.version}".`);
		out.push({ version: parsed.version, date: parsed.date });
	}
	return out;
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		fail(`Cannot read ${path}: ${e.message}`);
	}
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function readText(root, rel) {
	const path = join(root, rel);
	if (!existsSync(path)) fail(`${rel} is missing.`);
	return readFileSync(path, "utf8");
}

function today() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Rewrite docs/releases/README.md from the release files. */
export function writeIndex(root) {
	writeFileSync(join(root, INDEX_FILE), buildIndex(readReleases(root)));
}

/**
 * The `version` step: unreleased.md becomes docs/releases/<version>.md, unreleased.md goes back to the empty
 * template, the index is regenerated, manifest.json and versions.json get the version. Nothing is written
 * unless every check passes first. package.json is bumped and staged by npm itself.
 */
export function versionStage(root, version, { date = today(), git = true } = {}) {
	if (!TAG_RE.test(version)) fail(`"${version}" is not a plain x.y.z version.`);
	const manifestPath = join(root, "manifest.json");
	const versionsPath = join(root, "versions.json");
	const releasePath = join(root, RELEASES_DIR, `${version}.md`);
	const manifest = readJson(manifestPath);
	const versions = readJson(versionsPath);
	const unreleased = readText(root, UNRELEASED_FILE);
	preCheck(unreleased, null);
	if (existsSync(releasePath)) fail(`${RELEASES_DIR}/${version}.md already exists.`);
	const release = renderRelease(version, date, renderEntries(unreleased));
	manifest.version = version;
	versions[version] = manifest.minAppVersion;
	writeFileSync(releasePath, release);
	writeFileSync(join(root, UNRELEASED_FILE), EMPTY_UNRELEASED);
	writeIndex(root);
	writeJson(manifestPath, manifest);
	writeJson(versionsPath, versions);
	if (git) {
		const files = [`${RELEASES_DIR}/${version}.md`, UNRELEASED_FILE, INDEX_FILE, "manifest.json", "versions.json"];
		execFileSync("git", ["add", ...files], { cwd: root, stdio: "inherit" });
	}
}

/** Returns the release notes (the entries of docs/releases/<tag>.md) for the tag, or throws. */
export function verify(root, tag) {
	if (!TAG_RE.test(tag)) fail(`Tag "${tag}" must look like 1.2.3, with no "v" prefix.`);
	const manifest = readJson(join(root, "manifest.json"));
	const pkg = readJson(join(root, "package.json"));
	const versions = readJson(join(root, "versions.json"));
	if (manifest.version !== tag) fail(`Tag ${tag} does not match manifest.json version ${manifest.version}.`);
	if (pkg.version !== tag) fail(`Tag ${tag} does not match package.json version ${pkg.version}.`);
	if (!Object.hasOwn(versions, tag)) fail(`versions.json has no entry for ${tag}.`);
	const rel = `${RELEASES_DIR}/${tag}.md`;
	const parsed = parseRelease(readText(root, rel));
	if (!parsed) fail(`${rel} must start with "# ${tag}", a blank line and "Released YYYY-MM-DD.".`);
	if (parsed.version !== tag) fail(`${rel} has the title "# ${parsed.version}".`);
	if (!parsed.body.split("\n").some((l) => BULLET_RE.test(l))) fail(`${rel} has no entries.`);
	return `${parsed.body}\n`;
}

/** The CI check: unreleased.md is well formed, and the index lists exactly the release files. */
export function lintReleases(root) {
	lintUnreleased(readText(root, UNRELEASED_FILE));
	const expected = buildIndex(readReleases(root));
	if (readText(root, INDEX_FILE) !== expected) fail(`${INDEX_FILE} is out of date. Run \`node scripts/release-check.mjs index\` and commit it.`);
}

export function main(argv, env, root) {
	const [stage, arg] = argv;
	switch (stage) {
		case "pre": {
			const pkg = readJson(join(root, "package.json"));
			const bump = resolveBump(arg, env, pkg.version);
			const result = preCheck(readText(root, UNRELEASED_FILE), bump);
			if (env.npm_new_version && existsSync(join(root, RELEASES_DIR, `${env.npm_new_version}.md`))) {
				fail(`${RELEASES_DIR}/${env.npm_new_version}.md already exists.`);
			}
			const note = bump ? `${bump} bump` : "bump type unknown, so the patch rule was skipped";
			console.error(`release-check: ok (${note}; entries under ${result.headings.join(", ")})`);
			return;
		}
		case "version":
			if (!arg) fail("Usage: release-check.mjs version <newVersion>");
			versionStage(root, arg);
			console.error(`release-check: ${RELEASES_DIR}/${arg}.md written, unreleased.md reset, index, manifest.json and versions.json updated for ${arg}`);
			return;
		case "verify":
			if (!arg) fail("Usage: release-check.mjs verify <tag>");
			process.stdout.write(verify(root, arg));
			return;
		case "lint":
			lintReleases(root);
			console.error("release-check: docs/releases ok");
			return;
		case "index":
			writeIndex(root);
			console.error(`release-check: ${INDEX_FILE} written`);
			return;
		default:
			fail("Usage: release-check.mjs pre [bump] | version <v> | verify <tag> | lint | index");
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	try {
		main(process.argv.slice(2), process.env, resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), ".."));
	} catch (e) {
		if (!(e instanceof ReleaseError)) throw e;
		console.error(`release-check: ${e.message}`);
		process.exit(1);
	}
}
