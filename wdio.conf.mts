import * as fs from "node:fs";
import * as path from "node:path";

// End-to-end tests run a real, sandboxed Obsidian (downloaded into
// .obsidian-cache/) against a copy of test-vault/. They never touch the
// user's own Obsidian config or vaults.
export const config: WebdriverIO.Config = {
	runner: "local",
	framework: "mocha",
	specs: ["./e2e-tests/specs/**/*.e2e.ts"],
	maxInstances: 1,

	capabilities: [
		{
			browserName: "obsidian",
			// Pinned (2026-10-05): "latest" downloaded each new Obsidian release on its own,
			// which made the first run after a release slow and showed a new-binary prompt.
			// Bump both together on purpose, and run the full suite after a bump.
			browserVersion: "1.14.4",
			"wdio:obsidianOptions": {
				installerVersion: "1.14.4",
				plugins: ["."],
				vault: "test-vault",
			},
		},
	],

	services: ["obsidian"],
	reporters: ["obsidian"],
	cacheDir: path.resolve(".obsidian-cache"),

	mochaOpts: {
		ui: "bdd",
		timeout: 60000,
	},
	logLevel: "warn",

	// test-vault/.obsidian/ is gitignored, so a fresh clone has none. Write the
	// config the suite needs (e2e-tests/vault-config/) into it before Obsidian copies
	// the vault. The written files win over any local ones of the same name.
	onPrepare() {
		fs.cpSync(
			path.resolve("e2e-tests/vault-config"),
			path.resolve("test-vault/.obsidian"),
			{ recursive: true, force: true },
		);
		// Named logwell-data.json here because .gitignore ignores data.json.
		const plugin = path.resolve("test-vault/.obsidian/plugins/logwell");
		fs.mkdirSync(plugin, { recursive: true });
		fs.renameSync(path.resolve("test-vault/.obsidian/logwell-data.json"), path.join(plugin, "data.json"));
	},
};
