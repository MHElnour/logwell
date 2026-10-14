#!/usr/bin/env node
// The whole Quick Add repeat grammar grid, on demand, and the everyday phrase list. The unit suite runs a sample of
// the grid (tests/parsing/repeat-grammar.test.ts); this script bundles src with esbuild and runs every case of the grid
// (tests/parsing/repeat-grammar-grid.ts): environments × repeat forms × titles × separators × followers.
//
// The everyday phrases (tests/parsing/everyday-phrases.txt: dates, times, ranges, lists, sections, tags, priorities,
// punctuation, quotes, both English locales) are a change detector, not a test of right answers: no expectations are
// stored. Each is read at Wednesday 2026-10-07 10:00 in three zones, in its line's locale (en, or en-GB after a tab),
// against a fixed vault: lists Inbox, Work, Home; section Admin in Work; tag home; no notes.
//
//   node scripts/parser-oracle.mjs                  run the grid against the working tree (npm run test:parser-grid)
//                                                   and read every phrase once; a phrase that throws fails the run
//   node scripts/parser-oracle.mjs --compare <ref>  also read every grid input and every phrase with the parser at
//                                                   <ref> (a branch, tag or commit, like main) and list the ones that
//                                                   read differently; for a phrase, each field that differs (title,
//                                                   scheduled, deadline, planned duration, list, section, priority,
//                                                   repeat, tags, new tags, chips, blocking count)
//
// Exits 1 when a grid case fails or a phrase throws. The comparison only reports: a change meant to alter readings
// shows them there. The phrase count of "read differently" counts readings (a phrase in a zone).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const refAt = args.indexOf("--compare");
const ref = refAt === -1 ? null : args[refAt + 1];
if (refAt !== -1 && (ref === undefined || ref.startsWith("--"))) {
	console.error("usage: node scripts/parser-oracle.mjs [--compare <ref>]");
	process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "logwell-parser-oracle-"));
// The bundle of an old ref lives in a temp folder, so packages come from the node_modules of this checkout, or of the
// checkout a worktree sits in.
const nodePaths = [];
for (let dir = root; dirname(dir) !== dir; dir = dirname(dir)) nodePaths.push(join(dir, "node_modules"));
// vitest's `expect` stays outside the bundle, loaded from this checkout's node_modules.
const vitest = import.meta.resolve("vitest");
const externalVitest = { name: "vitest", setup: (b) => b.onResolve({ filter: /^vitest$/ }, () => ({ path: vitest, external: true })) };

async function bundle(name, contents) {
	const outfile = join(work, `${name}.mjs`);
	await build({
		stdin: { contents, resolveDir: root, loader: "ts", sourcefile: `${name}.ts` },
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node20",
		outfile,
		nodePaths,
		plugins: [externalVitest],
		logLevel: "error",
	});
	return import(pathToFileURL(outfile).href);
}

/** A reading that compares across versions: chip ids are left out, and blocking chips are named by kind and text. */
function reading(r) {
	const chips = r.chips.map(({ id: _id, span: _span, ...c }) => c);
	const blocking = r.blocking.map((id) => {
		const c = r.chips.find((x) => x.id === id);
		return c === undefined ? id : `${c.kind}|${c.text}`;
	});
	return JSON.stringify({ title: r.title, fields: r.fields, chips, blocking });
}

/** The phrase list: `{ input, locale }` per line. Blank lines and lines starting "# " are skipped (a phrase may start with #). */
function readPhrases() {
	return readFileSync(join(root, "tests/parsing/everyday-phrases.txt"), "utf8")
		.split("\n")
		.filter((l) => l !== "" && !l.startsWith("# "))
		.map((l) => {
			const [input, locale = "en"] = l.split("\t");
			return { input, locale };
		});
}

/** The vault the phrases are read against: lists Inbox, Work, Home; section Admin in Work; tag home; no notes. */
const VAULT = {
	categories: [
		{ id: "cat-inbox", name: "Inbox" },
		{ id: "cat-work", name: "Work" },
		{ id: "cat-home", name: "Home" },
	],
	sections: [{ id: "sec-admin", categoryId: "cat-work", name: "Admin" }],
	tags: [{ key: "home", displayName: "Home" }],
};

/** One phrase's reading as a text per field, so two parsers compare field by field. A throw is its own field. */
function phraseFields(helpers, parse, p, zone) {
	const nameOf = (id, list) => (id === undefined ? "-" : (list.find((x) => x.id === id)?.name ?? id));
	const spec = (d) => (d === undefined ? "-" : JSON.stringify(d));
	let r;
	try {
		const now = helpers.at(zone, helpers.WEDNESDAY);
		r = parse(p.input, { ...helpers.makeCtx({ zone, locale: p.locale, now, ...VAULT }), resolveNote: () => [] });
	} catch (e) {
		return { threw: String(e?.message ?? e).split("\n")[0] };
	}
	const f = r.fields;
	return {
		title: JSON.stringify(r.title),
		scheduled: spec(f.scheduled),
		deadline: spec(f.deadline),
		"planned duration": String(f.plannedDurationMin ?? "-"),
		list: nameOf(f.categoryId, VAULT.categories),
		section: nameOf(f.sectionId, VAULT.sections),
		priority: String(f.priority ?? "-"),
		repeat: f.recurrence === undefined ? "-" : JSON.stringify(f.recurrence),
		tags: JSON.stringify(f.tagKeys),
		"new tags": JSON.stringify(f.newTags),
		chips: r.chips.map((c) => `${c.kind}:${c.status}:${c.text}`).join(", ") || "-",
		blocking: String(r.blocking.length),
	};
}

try {
	const here = await bundle(
		"grid",
		`export * from "./tests/parsing/repeat-grammar-grid.ts";
		export { at, makeCtx, WEDNESDAY, ZONES } from "./tests/parsing/helpers.ts";
		export { parseQuickAdd } from "./src/parsing/index.ts";`,
	);
	const started = performance.now();
	let total = 0;
	const failures = [];
	for (const c of here.gridCases()) {
		total++;
		try {
			here.check(c.env, c.title, c.form, c.sep, c.follower);
		} catch (e) {
			failures.push(`${JSON.stringify(c.input)} in ${c.env.name}: ${String(e.message).split("\n")[0]}`);
		}
	}
	const ms = Math.round(performance.now() - started);
	console.log(`grid: ${total} cases, ${total - failures.length} passed, ${failures.length} failed (${ms} ms)`);
	for (const f of failures.slice(0, 50)) console.log(`  FAIL ${f}`);
	if (failures.length > 50) console.log(`  … and ${failures.length - 50} more`);

	const phrases = readPhrases();
	const readings = phrases.flatMap((p) => here.ZONES.map((zone) => ({ p, zone })));
	const threw = [];
	for (const { p, zone } of readings) {
		const out = phraseFields(here, here.parseQuickAdd, p, zone);
		if (out.threw !== undefined) threw.push(`${JSON.stringify(p.input)} [${p.locale}] in ${zone}: ${out.threw}`);
	}
	if (ref === null) {
		console.log(`phrases: ${phrases.length} inputs × ${here.ZONES.length} zones, ${threw.length} threw`);
		for (const t of threw) console.log(`  THREW ${t}`);
	}

	if (ref !== null) {
		const old = join(work, "ref");
		mkdirSync(old);
		const tar = execFileSync("git", ["archive", "--format=tar", ref, "src"], { cwd: root, maxBuffer: 1 << 28 });
		execFileSync("tar", ["-x", "-C", old], { input: tar });
		const then = await bundle("ref", `export { parseQuickAdd } from ${JSON.stringify(join(old, "src/parsing/index.ts"))};`);
		let differ = 0;
		let compared = 0;
		for (const c of here.gridCases()) {
			compared++;
			const ctx = () => here.makeCtx({ zone: c.env.zone, locale: c.env.locale, now: here.at(c.env.zone, c.env.now) });
			const a = reading(then.parseQuickAdd(c.input, ctx()));
			const b = reading(here.parseQuickAdd(c.input, ctx()));
			if (a === b) continue;
			differ++;
			if (differ <= 50) console.log(`\n${JSON.stringify(c.input)} in ${c.env.name}\n  ${ref}: ${a}\n  here: ${b}`);
		}
		console.log(`\ncompare with ${ref}: ${compared} inputs, ${differ} read differently${differ > 50 ? " (first 50 shown)" : ""}`);

		let phrasesDiffer = 0;
		for (const { p, zone } of readings) {
			const a = phraseFields(here, then.parseQuickAdd, p, zone);
			const b = phraseFields(here, here.parseQuickAdd, p, zone);
			const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
			if (changed.length === 0) continue;
			phrasesDiffer++;
			console.log(`\n${JSON.stringify(p.input)} [${p.locale}] in ${zone}`);
			for (const k of changed) console.log(`  ${k}: ${ref} ${a[k] ?? "-"} | here ${b[k] ?? "-"}`);
		}
		console.log(`\nphrases: ${phrases.length} inputs × ${here.ZONES.length} zones, ${phrasesDiffer} read differently`);
		for (const t of threw) console.log(`  THREW ${t}`);
	}
	process.exitCode = failures.length > 0 || threw.length > 0 ? 1 : 0;
} finally {
	rmSync(work, { recursive: true, force: true });
}
