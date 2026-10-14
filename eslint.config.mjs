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

// Date and time code goes through src/domain/time.ts: Luxon, `new Date(` and
// chrono-node's `result.date()` appear nowhere else. The files listed below
// predate the rule; remove a file from its list when its date code moves to
// time.ts, and never add one.
const LUXON_ALLOWED = [
	"src/domain/time.ts",
	"src/domain/calendar.ts",
	"src/app/DataService.ts",
	"src/parsing/dates.ts",
	"src/ui/calendar/format.ts",
	"src/ui/focus/format.ts",
	"src/ui/hooks.ts",
];
const NEW_DATE_ALLOWED = [
	"src/domain/time.ts",
	"src/domain/ports.ts",
];
const TIME_MESSAGE = "Date and time code goes through src/domain/time.ts.";
const noLuxon = [
	{ selector: "ImportDeclaration[source.value=/^luxon/]", message: TIME_MESSAGE },
	{ selector: "ImportExpression[source.value=/^luxon/]", message: TIME_MESSAGE },
];
const noNewDate = [{ selector: "NewExpression[callee.name='Date']", message: TIME_MESSAGE }];
const noChronoDate = [{ selector: "CallExpression[callee.property.name='date'][arguments.length=0]", message: "Never use chrono-node's result.date(); read the parsed components." }];
const SRC = ["src/**/*.ts", "src/**/*.tsx"];
const both = LUXON_ALLOWED.filter((f) => NEW_DATE_ALLOWED.includes(f));
const luxonOnly = LUXON_ALLOWED.filter((f) => !both.includes(f));
const newDateOnly = NEW_DATE_ALLOWED.filter((f) => !both.includes(f));
const timeFences = [
	{ files: SRC, ignores: [...LUXON_ALLOWED, ...NEW_DATE_ALLOWED], rules: { "no-restricted-syntax": ["error", ...noLuxon, ...noNewDate, ...noChronoDate] } },
	{ files: luxonOnly, rules: { "no-restricted-syntax": ["error", ...noNewDate, ...noChronoDate] } },
	{ files: newDateOnly, rules: { "no-restricted-syntax": ["error", ...noLuxon, ...noChronoDate] } },
	{ files: both, rules: { "no-restricted-syntax": ["error", ...noChronoDate] } },
];

export default defineConfig([
	globalIgnores(["main.js", "node_modules/**", "coverage/**", "test-vault/**", "dev-vault/**", ".claude/**", ".obsidian-cache/**", "e2e-tests/**", "wdio.conf.mts", "scripts/**"]),
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
	...timeFences,
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
