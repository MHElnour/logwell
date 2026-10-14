import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source-level guards for the parsing layer that ESLint does not check: iOS-safe regex and no network. The layer
// imports and the chrono date accessor are lint rules (eslint.config.mjs).

const ROOT = join(import.meta.dirname, "../../src/parsing");

function sources(dir: string): { file: string; text: string }[] {
	const out: { file: string; text: string }[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...sources(p));
		else if (name.endsWith(".ts")) out.push({ file: p, text: readFileSync(p, "utf8") });
	}
	return out;
}

const FILES = sources(ROOT);

describe("src/parsing source rules", () => {
	it("has source files to scan", () => {
		expect(FILES.length).toBeGreaterThanOrEqual(3);
	});

	it("uses no regex lookbehind or named group syntax (iOS)", () => {
		for (const f of FILES) expect(f.text, f.file).not.toContain("(?<");
	});

	it("makes no network calls", () => {
		for (const f of FILES) {
			expect(f.text, f.file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|requestUrl|node:https?|from\s+["']https?["']/);
		}
	});
});
