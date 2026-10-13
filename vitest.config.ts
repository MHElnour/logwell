import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The timed files run in their own project, one file at a time (`npm test` runs it after the unit project), so the rest
// of the suite does not load the machine while they compare times measured in the same run.
const timed = [
	"tests/perf/**/*.test.ts",
	"tests/perf/**/*.test.tsx",
	"tests/ui/performance.test.tsx",
];

export default defineConfig({
	oxc: {
		jsx: { runtime: "automatic", importSource: "preact" },
	},
	resolve: {
		// The obsidian package ships types only; tests that load src/main.ts get a stub.
		alias: { obsidian: fileURLToPath(new URL("./tests/app/obsidian-stub.ts", import.meta.url)) },
	},
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: "unit",
					include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
					exclude: ["**/node_modules/**", ...timed],
					environment: "node",
				},
			},
			{
				extends: true,
				test: {
					name: "perf",
					include: timed,
					environment: "node",
					fileParallelism: false,
				},
			},
		],
	},
});
