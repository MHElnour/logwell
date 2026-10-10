import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	oxc: {
		jsx: { runtime: "automatic", importSource: "preact" },
	},
	resolve: {
		// The obsidian package ships types only; tests that load src/main.ts get a stub.
		alias: { obsidian: fileURLToPath(new URL("./tests/app/obsidian-stub.ts", import.meta.url)) },
	},
	test: {
		include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
		environment: "node",
	},
});
