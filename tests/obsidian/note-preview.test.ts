// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component, MarkdownRenderer, TFile } from "obsidian";
import { ViewHost } from "../../src/obsidian/host";

// The description note preview in the details pane (ViewHost.renderNote): a read or render that fails
// leaves no render child on the view, and the caller gets the error.

afterEach(() => {
	vi.unstubAllGlobals();
	delete (MarkdownRenderer as { render?: unknown }).render;
});

function setup(read: () => Promise<string>) {
	vi.stubGlobal("createDiv", () => document.createElement("div"));
	const children = new Set<Component>();
	const view = {
		addChild: (c: Component) => {
			children.add(c);
			return c;
		},
		removeChild: (c: Component) => void children.delete(c),
	};
	const file = Object.assign(new TFile(), { path: "Plan.md" });
	const plugin = { app: { vault: { getFileByPath: () => file, cachedRead: read } } };
	const host = new ViewHost(plugin as never, {} as never, view as never);
	return { host, children };
}

describe("note preview", () => {
	it("#134: a note that cannot be read rejects and leaves no render child behind", async () => {
		const { host, children } = setup(() => Promise.reject(new Error("EIO")));
		const el = document.createElement("div");
		await expect(host.renderNote("Plan.md", el)).rejects.toThrow("EIO");
		expect(children.size).toBe(0);
	});

	it("#134: a render that throws leaves no render child behind either", async () => {
		const { host, children } = setup(() => Promise.resolve("text"));
		(MarkdownRenderer as unknown as { render: () => Promise<void> }).render = () => Promise.reject(new Error("bad markdown"));
		const el = document.createElement("div");
		await expect(host.renderNote("Plan.md", el)).rejects.toThrow("bad markdown");
		expect(children.size).toBe(0);
	});
});
