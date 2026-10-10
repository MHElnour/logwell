import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// Layer rule (plan §4.6, DATA-05): the pure layers never import Obsidian or
// the layers above them. app/ and persistence/ talk to Obsidian through ports.
const pureLayerImports = {
	paths: [{ name: "obsidian", message: "Pure layers must not import obsidian (plan §4.6, DATA-05)." }],
	patterns: [
		{ group: ["obsidian/*"], message: "Pure layers must not import obsidian (plan §4.6, DATA-05)." },
		{ group: ["**/obsidian/**", "**/ui/**"], message: "Pure layers must not depend on the Obsidian or UI layers." },
	],
};

export default defineConfig([
	globalIgnores(["main.js", "node_modules/**", "coverage/**", "test-vault/**", "dev-vault/**", ".obsidian-cache/**", "e2e/**", "wdio.conf.mts", "scripts/**"]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs", "esbuild.config.mjs"],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		rules: {
			"obsidianmd/ui/sentence-case": ["warn", { enforceCamelCaseLower: true, brands: ["Logwell", "Checkpoint", "Obsidian Sync", "Git", "TickTick"] }],
		},
	},
	{
		files: ["src/domain/**/*.ts", "src/parsing/**/*.ts", "src/persistence/**/*.ts", "src/app/**/*.ts"],
		rules: {
			"no-restricted-imports": ["error", pureLayerImports],
		},
	},
	{
		// src/ui talks to Obsidian only through UiHost, so it never imports obsidian itself.
		files: ["src/ui/**/*.ts", "src/ui/**/*.tsx"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					paths: [{ name: "obsidian", message: "src/ui must not import obsidian; use UiHost." }],
					patterns: [{ group: ["obsidian/*"], message: "src/ui must not import obsidian; use UiHost." }],
				},
			],
		},
	},
	{
		files: ["src/domain/**/*.ts", "src/parsing/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					...pureLayerImports,
					patterns: [
						...pureLayerImports.patterns,
						{
							group: ["**/persistence/**", "**/app/**"],
							message: "domain/ and parsing/ sit below persistence/ and app/.",
						},
					],
				},
			],
		},
	},
	{
		files: ["esbuild.config.mjs"],
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
			"import/no-extraneous-dependencies": "off",
		},
	},
	{
		files: ["tests/**/*.ts", "tests/**/*.tsx", "vitest.config.ts"],
		rules: {
			"import/no-extraneous-dependencies": "off",
			// Tests run in Node or happy-dom, where Obsidian's DOM helpers do not exist.
			"obsidianmd/prefer-create-el": "off",
			"obsidianmd/prefer-window-timers": "off",
		},
	},
]);
