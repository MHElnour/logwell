import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	EMPTY_UNRELEASED,
	bumpType,
	buildIndex,
	lintReleases,
	lintUnreleased,
	parseRelease,
	preCheck,
	renderEntries,
	renderRelease,
	resolveBump,
	stripComments,
	verify,
	versionStage,
} from "../../scripts/release-check.mjs";

const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "release-check.mjs");

// An unreleased.md whose header comment holds an example bullet: it must never count as an entry.
const unreleased = (sections: string) => `# Unreleased\n\n<!--\nRules\n- (#12) Fixed a thing. Thanks to @user for reporting.\n-->\n\n${sections}`;
const release = (version: string, date: string, body: string) => `# ${version}\n\nReleased ${date}.\n\n${body}`;
const rel010 = release("0.1.0", "2026-01-01", "## Added\n\n- First thing\n");

const dirs: string[] = [];
function project(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "release-check-"));
	dirs.push(root);
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(join(root, name, ".."), { recursive: true });
		writeFileSync(join(root, name), content);
	}
	return root;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const json = (o: unknown) => `${JSON.stringify(o, null, "\t")}\n`;
const read = (root: string, name: string) => readFileSync(join(root, name), "utf8");
/** A project at `version` with unreleased.md = `un` and the 0.1.0 release file plus its index. */
const baseFiles = (version: string, un: string, extra: Record<string, string> = {}) => ({
	"docs/releases/unreleased.md": un,
	"docs/releases/0.1.0.md": rel010,
	"docs/releases/README.md": buildIndex([{ version: "0.1.0", date: "2026-01-01" }]),
	"manifest.json": json({ id: "x", version, minAppVersion: "1.13.0" }),
	"package.json": json({ name: "x", version }),
	"versions.json": json({ "0.1.0": "1.13.0" }),
	...extra,
});

describe("stripComments", () => {
	it("removes single and multi-line comments", () => {
		expect(stripComments("a<!-- x -->b<!--\n- y\n-->c")).toBe("abc");
	});
});

describe("preCheck", () => {
	it("passes with a bullet under an allowed heading", () => {
		expect(preCheck(unreleased("## Added\n\n- A thing\n"), "minor").headings).toEqual(["Added"]);
	});
	it("fails when the sections have no bullets or the file is empty", () => {
		expect(() => preCheck(unreleased("## Added\n\n## Fixed\n\n"), "minor")).toThrow(/no entries/);
		expect(() => preCheck("", "minor")).toThrow(/no entries/);
	});
	it("does not count the example bullets in the header comment", () => {
		expect(() => preCheck(EMPTY_UNRELEASED, "minor")).toThrow(/no entries/);
		expect(() => preCheck(unreleased(""), "patch")).toThrow(/no entries/);
	});
	it("names the file in the error", () => {
		expect(() => preCheck("", "minor")).toThrow(/docs\/releases\/unreleased\.md has no entries/);
	});
	it("fails on an unknown heading", () => {
		expect(() => preCheck(unreleased("## Misc\n\n- x\n"), "minor")).toThrow(/unknown heading "## Misc"/);
	});
	it("fails on entries outside a heading", () => {
		expect(() => preCheck(unreleased("- loose\n"), "minor")).toThrow(/outside a ## heading/);
	});
	it("rejects Added, Changed and Removed on a patch bump", () => {
		for (const h of ["Added", "Changed", "Removed"]) {
			expect(() => preCheck(unreleased(`## ${h}\n\n- x\n`), "patch")).toThrow(/patch release may only list Fixed and Security/);
		}
	});
	it("allows Fixed and Security on a patch bump", () => {
		expect(preCheck(unreleased("## Fixed\n\n- a\n\n## Security\n\n- b\n"), "patch").headings).toEqual(["Fixed", "Security"]);
	});
	it("ignores empty Added headings on a patch bump", () => {
		expect(() => preCheck(unreleased("## Added\n\n## Fixed\n\n- a\n"), "patch")).not.toThrow();
	});
	it("allows anything on a minor bump and checks structure only when the bump is unknown", () => {
		expect(() => preCheck(unreleased("## Removed\n\n- a\n"), "minor")).not.toThrow();
		expect(() => preCheck(unreleased("## Changed\n\n- a\n"), null)).not.toThrow();
	});
	it("accepts an entry that credits an issue and its reporter", () => {
		expect(() => preCheck(unreleased("## Fixed\n\n- (#12) Fixed a bug. Thanks to @someone for reporting.\n"), "patch")).not.toThrow();
	});
});

describe("bump detection", () => {
	it("compares versions", () => {
		expect(bumpType("0.1.0", "0.1.1")).toBe("patch");
		expect(bumpType("0.1.4", "0.2.0")).toBe("minor");
		expect(bumpType("0.9.0", "1.0.0")).toBe("major");
		expect(bumpType("0.2.0", "0.1.0")).toBeNull();
	});
	it("prefers the CLI argument, then npm_new_version, then gives up", () => {
		expect(resolveBump("minor", { npm_new_version: "0.1.1" }, "0.1.0")).toBe("minor");
		expect(resolveBump("0.2.0", {}, "0.1.0")).toBe("minor");
		expect(resolveBump(undefined, { npm_new_version: "0.1.1", npm_old_version: "0.1.0" }, "0.1.0")).toBe("patch");
		expect(resolveBump(undefined, { npm_new_version: "0.3.0" }, "0.2.5")).toBe("minor");
		expect(resolveBump(undefined, {}, "0.1.0")).toBeNull();
		expect(() => resolveBump("banana", {}, "0.1.0")).toThrow(/Cannot read/);
	});
});

describe("the empty template", () => {
	it("is well formed, has the four sections and states the rules", () => {
		expect(() => lintUnreleased(EMPTY_UNRELEASED)).not.toThrow();
		for (const h of ["Added", "Changed", "Fixed", "Security"]) expect(EMPTY_UNRELEASED).toContain(`\n## ${h}\n`);
		expect(EMPTY_UNRELEASED).toContain("Thanks to @");
		expect(EMPTY_UNRELEASED).toContain("(#12)");
		expect(EMPTY_UNRELEASED).toContain("A patch release");
	});
});

describe("renderEntries, renderRelease and parseRelease", () => {
	it("keeps only the sections with entries, entries verbatim, in order", () => {
		const text = unreleased("## Added\n\n## Changed\n\n- A\n- B wraps\n  onto a second line\n\n## Fixed\n\n- (#3) C. Thanks to @u for reporting.\n\n## Security\n");
		expect(renderEntries(text)).toBe("## Changed\n\n- A\n- B wraps\n  onto a second line\n\n## Fixed\n\n- (#3) C. Thanks to @u for reporting.\n");
	});
	it("leaves out the header comment", () => {
		expect(renderEntries(unreleased("## Added\n\n- A\n"))).not.toContain("Rules");
	});
	it("writes the title, the date and the entries, and reads them back", () => {
		const text = renderRelease("0.7.0", "2026-10-08", "## Added\n\n- A\n");
		expect(text).toBe("# 0.7.0\n\nReleased 2026-10-08.\n\n## Added\n\n- A\n");
		expect(parseRelease(text)).toEqual({ version: "0.7.0", date: "2026-10-08", body: "## Added\n\n- A" });
	});
	it("returns null for a file without the title and date lines", () => {
		expect(parseRelease("## Added\n\n- A\n")).toBeNull();
		expect(parseRelease("# 0.7.0\n\n## Added\n")).toBeNull();
	});
});

describe("buildIndex", () => {
	it("lists the versions newest first, comparing numbers and not text", () => {
		const text = buildIndex([
			{ version: "0.9.0", date: "2026-02-01" },
			{ version: "0.10.0", date: "2026-03-01" },
			{ version: "0.2.1", date: "2026-01-20" },
		]);
		const lines = text.split("\n").filter((l) => l.startsWith("- ["));
		expect(lines).toEqual(["- [0.10.0](0.10.0.md): 2026-03-01", "- [0.9.0](0.9.0.md): 2026-02-01", "- [0.2.1](0.2.1.md): 2026-01-20"]);
		expect(text).toContain("[Unreleased](unreleased.md)");
	});
});

describe("the version stage", () => {
	const un = unreleased("## Added\n\n## Fixed\n\n- (#7) A thing. Thanks to @sam for reporting.\n\n## Changed\n\n- Another\n");

	it("writes the release file, resets unreleased.md, regenerates the index, bumps the manifest and stages the files", () => {
		const root = project(baseFiles("0.1.0", un));
		execFileSync("git", ["init", "-q"], { cwd: root });
		versionStage(root, "0.2.0", { date: "2026-10-03" });
		expect(read(root, "docs/releases/0.2.0.md")).toBe(
			"# 0.2.0\n\nReleased 2026-10-03.\n\n## Fixed\n\n- (#7) A thing. Thanks to @sam for reporting.\n\n## Changed\n\n- Another\n",
		);
		expect(read(root, "docs/releases/unreleased.md")).toBe(EMPTY_UNRELEASED);
		const index = read(root, "docs/releases/README.md");
		expect(index.split("\n").filter((l) => l.startsWith("- ["))).toEqual(["- [0.2.0](0.2.0.md): 2026-10-03", "- [0.1.0](0.1.0.md): 2026-01-01"]);
		expect((JSON.parse(read(root, "manifest.json")) as { version: string }).version).toBe("0.2.0");
		expect(JSON.parse(read(root, "versions.json"))).toEqual({ "0.1.0": "1.13.0", "0.2.0": "1.13.0" });
		const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8" }).trim().split("\n");
		expect(staged.sort()).toEqual(
			["docs/releases/0.2.0.md", "docs/releases/README.md", "docs/releases/unreleased.md", "manifest.json", "versions.json"].sort(),
		);
	});

	it("leaves the project as it was after a release: lint passes and the next release needs new entries", () => {
		const root = project(baseFiles("0.1.0", un));
		versionStage(root, "0.2.0", { date: "2026-10-03", git: false });
		expect(() => lintReleases(root)).not.toThrow();
		expect(() => preCheck(read(root, "docs/releases/unreleased.md"), "minor")).toThrow(/no entries/);
	});

	it("rejects a bad version", () => {
		const root = project(baseFiles("0.1.0", un));
		expect(() => versionStage(root, "v0.2.0", { git: false })).toThrow(/not a plain x\.y\.z/);
	});

	it("writes nothing when unreleased.md has no entries, an unknown heading or is missing", () => {
		for (const text of [EMPTY_UNRELEASED, unreleased("## Misc\n\n- x\n"), null]) {
			const files = baseFiles("0.1.0", text ?? "");
			const root = project(files);
			if (text === null) rmSync(join(root, "docs/releases/unreleased.md"));
			expect(() => versionStage(root, "0.2.0", { git: false })).toThrow();
			expect(existsSync(join(root, "docs/releases/0.2.0.md"))).toBe(false);
			expect((JSON.parse(read(root, "manifest.json")) as { version: string }).version).toBe("0.1.0");
			expect(JSON.parse(read(root, "versions.json"))).toEqual({ "0.1.0": "1.13.0" });
		}
	});

	it("refuses to overwrite an existing release file", () => {
		const root = project(baseFiles("0.1.0", un, { "docs/releases/0.2.0.md": release("0.2.0", "2026-02-02", "## Added\n\n- old\n") }));
		expect(() => versionStage(root, "0.2.0", { git: false })).toThrow(/0\.2\.0\.md already exists/);
		expect(read(root, "docs/releases/unreleased.md")).toBe(un);
		expect(read(root, "docs/releases/0.2.0.md")).toContain("- old");
	});
});

describe("verify", () => {
	const rel020 = release("0.2.0", "2026-10-03", "## Added\n\n- A thing\n- Another\n");
	const files = (over: Record<string, string> = {}) => ({
		...baseFiles("0.2.0", EMPTY_UNRELEASED),
		"docs/releases/0.2.0.md": rel020,
		"versions.json": json({ "0.1.0": "1.13.0", "0.2.0": "1.13.0" }),
		...over,
	});

	it("returns the entries of the release file as release notes, without the title and date", () => {
		expect(verify(project(files()), "0.2.0")).toBe("## Added\n\n- A thing\n- Another\n");
	});
	it("fails on a tag with a v prefix or a bad shape", () => {
		expect(() => verify(project(files()), "v0.2.0")).toThrow(/no "v" prefix/);
		expect(() => verify(project(files()), "0.2")).toThrow(/no "v" prefix/);
	});
	it("fails when the tag differs from manifest.json", () => {
		expect(() => verify(project(files({ "manifest.json": json({ version: "0.1.0" }) })), "0.2.0")).toThrow(/manifest\.json version 0\.1\.0/);
	});
	it("fails when the tag differs from package.json", () => {
		expect(() => verify(project(files({ "package.json": json({ version: "0.1.0" }) })), "0.2.0")).toThrow(/package\.json version 0\.1\.0/);
	});
	it("fails when versions.json lacks the tag", () => {
		expect(() => verify(project(files({ "versions.json": json({ "0.1.0": "1.13.0" }) })), "0.2.0")).toThrow(/versions\.json has no entry/);
	});
	it("fails when there is no release file for the tag", () => {
		const root = project(files());
		rmSync(join(root, "docs/releases/0.2.0.md"));
		expect(() => verify(root, "0.2.0")).toThrow(/docs\/releases\/0\.2\.0\.md is missing/);
	});
	it("fails when the release file has no bullet", () => {
		const empty = release("0.2.0", "2026-10-03", "## Added\n\n");
		expect(() => verify(project(files({ "docs/releases/0.2.0.md": empty })), "0.2.0")).toThrow(/has no entries/);
	});
	it("fails when the release file lacks the title and date lines or has another version in its title", () => {
		expect(() => verify(project(files({ "docs/releases/0.2.0.md": "## Added\n\n- x\n" })), "0.2.0")).toThrow(/must start with "# 0\.2\.0"/);
		expect(() => verify(project(files({ "docs/releases/0.2.0.md": release("0.3.0", "2026-10-03", "## Added\n\n- x\n") })), "0.2.0")).toThrow(/title "# 0\.3\.0"/);
	});
	it("does not mistake 0.2.0 for 0.2.1", () => {
		expect(() => verify(project(files()), "0.2.1")).toThrow();
	});
});

describe("lintReleases", () => {
	it("passes with an empty unreleased.md and a current index", () => {
		expect(() => lintReleases(project(baseFiles("0.1.0", EMPTY_UNRELEASED)))).not.toThrow();
	});
	it("fails on an unknown heading in unreleased.md", () => {
		expect(() => lintReleases(project(baseFiles("0.1.0", unreleased("## Stuff\n\n- x\n"))))).toThrow(/unknown heading/);
	});
	it("fails when unreleased.md is missing", () => {
		const root = project(baseFiles("0.1.0", ""));
		rmSync(join(root, "docs/releases/unreleased.md"));
		expect(() => lintReleases(root)).toThrow(/unreleased\.md is missing/);
	});
	it("fails when the index does not list a release file", () => {
		const root = project(baseFiles("0.1.0", EMPTY_UNRELEASED, { "docs/releases/0.2.0.md": release("0.2.0", "2026-02-02", "## Added\n\n- x\n") }));
		expect(() => lintReleases(root)).toThrow(/README\.md is out of date/);
	});
	it("fails on a release file without the title and date lines", () => {
		expect(() => lintReleases(project(baseFiles("0.1.0", EMPTY_UNRELEASED, { "docs/releases/0.2.0.md": "## Added\n\n- x\n" })))).toThrow(/must start with/);
	});
});

describe("command line", () => {
	// The script resolves its project root from its own location, so run a copy inside a temp project.
	const cli = (files: Record<string, string>, args: string[], env: Record<string, string> = {}, git = false) => {
		const root = project({ ...files, "scripts/release-check.mjs": readFileSync(SCRIPT, "utf8") });
		if (git) execFileSync("git", ["init", "-q"], { cwd: root });
		const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_")));
		return { root, ...spawnSync(process.execPath, [join(root, "scripts", "release-check.mjs"), ...args], { cwd: root, encoding: "utf8", env: { ...cleanEnv, ...env } }) };
	};

	it("the real repo's release notes pass lint", () => {
		expect(spawnSync(process.execPath, [SCRIPT, "lint"], { encoding: "utf8" }).status).toBe(0);
	});
	it("the real repo's index lists every release file, newest first", () => {
		const index = readFileSync(join(import.meta.dirname, "..", "..", "docs", "releases", "README.md"), "utf8");
		const versions = index.split("\n").filter((l) => l.startsWith("- [")).map((l) => /^- \[([^\]]+)\]/.exec(l)?.[1]);
		const current = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version: string }).version;
		// Before the first release the index is empty and the version is 0.0.0.
		if (versions.length === 0) {
			expect(current).toBe("0.0.0");
			return;
		}
		expect(versions[0]).toBe(current);
		expect(versions.at(-1)).toBe("0.1.0");
	});
	it("pre exits 1 with a message on an empty unreleased.md", () => {
		const r = cli(baseFiles("0.1.0", EMPTY_UNRELEASED), ["pre", "minor"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("release-check: docs/releases/unreleased.md has no entries");
	});
	it("pre reads the bump from npm_new_version", () => {
		const files = baseFiles("0.1.0", unreleased("## Added\n\n- x\n"));
		const r = cli(files, ["pre"], { npm_old_version: "0.1.0", npm_new_version: "0.1.1" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("patch release may only list Fixed and Security");
		expect(cli(files, ["pre"], { npm_old_version: "0.1.0", npm_new_version: "0.2.0" }).status).toBe(0);
	});
	it("pre refuses a version whose release file already exists", () => {
		const files = baseFiles("0.1.0", unreleased("## Fixed\n\n- x\n"), { "docs/releases/0.1.1.md": release("0.1.1", "2026-01-02", "## Fixed\n\n- y\n") });
		const r = cli(files, ["pre"], { npm_old_version: "0.1.0", npm_new_version: "0.1.1" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("0.1.1.md already exists");
	});
	it("verify prints the notes on stdout", () => {
		const r = cli(baseFiles("0.1.0", EMPTY_UNRELEASED), ["verify", "0.1.0"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("## Added\n\n- First thing\n");
	});
	it("index rewrites the README from the release files", () => {
		const r = cli(baseFiles("0.1.0", EMPTY_UNRELEASED, { "docs/releases/README.md": "stale\n" }), ["index"]);
		expect(r.status).toBe(0);
		expect(readFileSync(join(r.root, "docs/releases/README.md"), "utf8")).toBe(buildIndex([{ version: "0.1.0", date: "2026-01-01" }]));
	});
	it("version works end to end", () => {
		const r = cli(baseFiles("0.1.0", unreleased("## Fixed\n\n- (#4) y. Thanks to @z for reporting.\n")), ["version", "0.1.1"], {}, true);
		expect(r.status).toBe(0);
		expect(existsSync(join(r.root, "docs/releases/0.1.1.md"))).toBe(true);
		expect(readFileSync(join(r.root, "docs/releases/unreleased.md"), "utf8")).toBe(EMPTY_UNRELEASED);
	});
	it("verify exits 1 for a v-prefixed tag; an unknown stage prints usage", () => {
		expect(cli(baseFiles("0.1.0", EMPTY_UNRELEASED), ["verify", "v0.1.0"]).status).toBe(1);
		const r = cli(baseFiles("0.1.0", EMPTY_UNRELEASED), ["bogus"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("Usage");
	});
});
