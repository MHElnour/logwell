#!/usr/bin/env node
// The whole Quick Add repeat grammar grid, on demand. The unit suite runs a sample of it
// (tests/parsing/repeat-grammar.test.ts); this script bundles src with esbuild and runs every case of the grid
// (tests/parsing/repeat-grammar-grid.ts): environments × repeat forms × titles × separators × followers.
//
//   node scripts/parser-oracle.mjs                  run the grid against the working tree (npm run test:parser-grid)
//   node scripts/parser-oracle.mjs --compare <ref>  also read every grid input with the parser at <ref> (a branch,
//                                                   tag or commit, like main) and list the inputs that read differently
//
// Exits 1 when a grid case fails. The comparison only reports: a change meant to alter readings shows them there.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
		nodePaths: [join(root, "node_modules")],
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

try {
	const here = await bundle(
		"grid",
		`export * from "./tests/parsing/repeat-grammar-grid.ts";
		export { at, makeCtx } from "./tests/parsing/helpers.ts";
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
	}
	process.exitCode = failures.length > 0 ? 1 : 0;
} finally {
	rmSync(work, { recursive: true, force: true });
}
