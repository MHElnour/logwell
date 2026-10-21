import { describe, expect, it, vi } from "vitest";
import { CheckpointSettingTab } from "../../src/obsidian/SettingTab";
import { addGitAttributesLine, gitSyncNeeded, gitSyncRow, type GitSyncFiles } from "../../src/obsidian/gitSync";

// The "Git sync" row of the settings tab: shown only in a vault that Git tracks and whose .gitattributes lacks the
// database line. The row is data (a definition with a render callback), driven here with a fake Setting.

const LINE = "*.cpbase merge=binary -text";

/** The vault root as the adapter sees it: dotfiles that the vault index does not list, by path. */
class FakeRoot implements GitSyncFiles {
	writes: string[] = [];
	constructor(readonly files = new Map<string, string>()) {}
	exists(path: string) {
		return Promise.resolve(this.files.has(path));
	}
	read(path: string) {
		const text = this.files.get(path);
		return text === undefined ? Promise.reject(new Error(`missing ${path}`)) : Promise.resolve(text);
	}
	write(path: string, data: string) {
		this.writes.push(path);
		this.files.set(path, data);
		return Promise.resolve();
	}
	process(path: string, fn: (data: string) => string) {
		this.writes.push(path);
		const next = fn(this.files.get(path) ?? "");
		this.files.set(path, next);
		return Promise.resolve(next);
	}
}

const rootWith = (files: Record<string, string>) => new FakeRoot(new Map(Object.entries(files)));

class FakeSetting {
	button = { text: "", disabled: false, click: (): void => undefined };
	addButton(cb: (b: unknown) => unknown) {
		const b = {
			setButtonText: (x: string) => ((this.button.text = x), b),
			setDisabled: (d: boolean) => ((this.button.disabled = d), b),
			onClick: (f: () => void) => ((this.button.click = f), b),
		};
		cb(b);
		return this;
	}
}

type Row = { name: string; desc: string; visible: () => boolean; render: (s: never, g: never) => void };

function setup(root: FakeRoot) {
	const notices: string[] = [];
	const errors: unknown[] = [];
	const refresh = vi.fn();
	const git = gitSyncRow({ files: () => root, notify: (m) => notices.push(m), error: (e) => errors.push(e), refresh });
	const row = git.item as unknown as Row;
	const render = () => {
		const s = new FakeSetting();
		row.render(s as never, {} as never);
		return s;
	};
	return { git, row, render, notices, errors, refresh, shown: () => row.visible() };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("#224: when the Git sync row is shown", () => {
	it.each([
		["no .git folder", {}, false],
		["no .git folder, a .gitattributes with other lines", { ".gitattributes": "*.md text\n" }, false],
		["no .git folder, a .gitattributes that holds the line", { ".gitattributes": `${LINE}\n` }, false],
		[".git and no .gitattributes", { ".git": "" }, true],
		[".git and a .gitattributes with other lines", { ".git": "", ".gitattributes": "*.md text\n" }, true],
		[".git and a .gitattributes that only mentions the rule in a comment", { ".git": "", ".gitattributes": `# ${LINE}\n` }, true],
		[".git and a .gitattributes that holds the line", { ".git": "", ".gitattributes": `${LINE}\n` }, false],
		[".git and a .gitattributes that holds the line with spaces and no final newline", { ".git": "", ".gitattributes": `*.md text\n  ${LINE}  ` }, false],
	])("%s", async (_name, files, needed) => {
		expect(await gitSyncNeeded(rootWith(files))).toBe(needed);
		const t = setup(rootWith(files));
		expect(t.shown()).toBe(false);
		await t.git.check();
		expect(t.shown()).toBe(needed);
		expect(t.refresh).toHaveBeenCalledTimes(needed ? 1 : 0);
	});

	it("stays hidden when the vault files cannot be read", async () => {
		const errors: unknown[] = [];
		const broken = gitSyncRow({
			files: () => {
				throw new Error("no adapter");
			},
			notify: () => undefined,
			error: (e) => errors.push(e),
			refresh: () => undefined,
		});
		await broken.check();
		expect((broken.item as unknown as Row).visible()).toBe(false);
		expect(errors).toEqual([]);
	});
});

describe("#224: the Add to .gitattributes button", () => {
	it("says what it does, in sentence case", () => {
		const t = setup(rootWith({ ".git": "" }));
		expect(t.row.name).toBe("Git sync");
		expect(t.row.desc).toBe("Stops Git from merging the database line by line, so a conflict offers Keep mine or Keep theirs.");
		expect(t.render().button.text).toBe("Add to .gitattributes");
	});

	it.each([
		["creates the file when it is missing", undefined, `${LINE}\n`],
		["adds a newline first when the file does not end in one", "*.md text", `*.md text\n${LINE}\n`],
		["keeps every other line byte for byte", "# keep\n\n*.md   text \n", `# keep\n\n*.md   text \n${LINE}\n`],
	])("%s, shows the notice once, and the row goes away", async (_name, before, after) => {
		const root = rootWith(before === undefined ? { ".git": "" } : { ".git": "", ".gitattributes": before });
		const t = setup(root);
		await t.git.check();
		expect(t.shown()).toBe(true);
		const s = t.render();
		s.button.click();
		await settle();
		expect(root.files.get(".gitattributes")).toBe(after);
		expect(root.writes).toEqual([".gitattributes"]);
		expect(t.notices).toEqual(["Added to .gitattributes."]);
		expect(t.shown()).toBe(false);
		expect(t.refresh).toHaveBeenCalledTimes(2);
	});

	it("writes once however often the button is clicked", async () => {
		const root = rootWith({ ".git": "" });
		const t = setup(root);
		await t.git.check();
		const s = t.render();
		s.button.click();
		s.button.click();
		await settle();
		s.button.click();
		await settle();
		expect(root.writes).toEqual([".gitattributes"]);
		expect(root.files.get(".gitattributes")).toBe(`${LINE}\n`);
		expect(t.notices).toEqual(["Added to .gitattributes."]);
	});

	it("does not add the line twice when the file got it between the check and the click", async () => {
		const root = rootWith({ ".git": "", ".gitattributes": "*.md text\n" });
		const t = setup(root);
		await t.git.check();
		root.files.set(".gitattributes", `*.md text\n${LINE}\n`);
		t.render().button.click();
		await settle();
		expect(root.files.get(".gitattributes")).toBe(`*.md text\n${LINE}\n`);
	});

	it("a write that fails is shown, nothing is announced, and the row stays for another try", async () => {
		const root = rootWith({ ".git": "" });
		const failure = new Error("read-only folder");
		root.write = () => Promise.reject(failure);
		const t = setup(root);
		await t.git.check();
		const s = t.render();
		s.button.click();
		await settle();
		expect(t.errors).toEqual([failure]);
		expect(t.notices).toEqual([]);
		expect(t.shown()).toBe(true);
		expect(s.button.disabled).toBe(false);
	});

	it("a check that finished after the button was used does not bring the row back", async () => {
		const root = rootWith({ ".git": "" });
		const t = setup(root);
		await t.git.check();
		const slow = t.git.check();
		t.render().button.click();
		await slow;
		await settle();
		expect(t.shown()).toBe(false);
	});

	it("addGitAttributesLine on an existing file goes through the adapter's atomic process", async () => {
		const root = rootWith({ ".gitattributes": "*.md text\n" });
		await addGitAttributesLine(root);
		expect(root.files.get(".gitattributes")).toBe(`*.md text\n${LINE}\n`);
	});
});

describe("#224: the Git sync row in the settings tab", () => {
	it("is the second row of the Database group, right under the database picker", () => {
		const tab = new CheckpointSettingTab({} as never, {} as never);
		const group = (tab.getSettingDefinitions() as unknown as { heading?: string; items: { name: string }[] }[]).find((g) => g.heading === "Database")!;
		expect(group.items.map((i) => i.name)).toEqual(["Active database", "Git sync", "Create database"]);
	});
});
