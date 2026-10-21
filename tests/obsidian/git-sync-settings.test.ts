import { describe, expect, it, vi } from "vitest";
import { CheckpointSettingTab } from "../../src/obsidian/SettingTab";
import { GIT_ATTRIBUTES_LINE, addGitAttributesLine, gitAttributesAddition, gitSyncNeeded, gitSyncRow, hasGitAttributesLine, type GitSyncFiles } from "../../src/obsidian/gitSync";

// The "Git sync" row of the settings tab: shown only in a vault that Git tracks and whose .gitattributes lacks the
// database line. The row is data (a definition with a render callback), driven here with a fake Setting.

const LINE = "*.cpbase merge=binary -text";

/** The vault root as the adapter sees it: dotfiles that the vault index does not list, by path. */
class FakeRoot implements GitSyncFiles {
	appends: string[] = [];
	reads = 0;
	constructor(readonly files = new Map<string, string>()) {}
	exists(path: string) {
		return Promise.resolve(this.files.has(path));
	}
	read(path: string) {
		this.reads++;
		const text = this.files.get(path);
		return text === undefined ? Promise.reject(new Error(`missing ${path}`)) : Promise.resolve(text);
	}
	append(path: string, data: string) {
		this.appends.push(path);
		this.files.set(path, (this.files.get(path) ?? "") + data);
		return Promise.resolve();
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

function setup(root: GitSyncFiles) {
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

describe("#224: the .gitattributes line", () => {
	it("is the line that keeps Git from merging the database line by line", () => {
		expect(GIT_ATTRIBUTES_LINE).toBe(LINE);
	});

	it.each([
		["the exact line", `${LINE}\n`, true],
		["the line without a final newline", LINE, true],
		["the line with spaces around it", `  ${LINE}\t\n`, true],
		["the line among other lines, with CRLF", `*.md text\r\n${LINE}\r\n*.png binary\r\n`, true],
		["no file content", "", false],
		["other lines only", "*.md text\n", false],
		["the line commented out", `# ${LINE}\n`, false],
		["a different rule for cpbase", "*.cpbase merge=union\n", false],
		["the line with a trailing word", `${LINE} diff\n`, false],
	])("recognizes %s", (_name, content, expected) => {
		expect(hasGitAttributesLine(content)).toBe(expected);
	});

	it.each([
		["a missing file", "", `${LINE}\n`],
		["a file that ends in a newline", "*.md text\n", `${LINE}\n`],
		["a file without a final newline", "*.md text", `\n${LINE}\n`],
		["a file with CRLF line ends and no final one", "*.md text\r\n*.png binary", `\r\n${LINE}\r\n`],
		["a file with CRLF line ends and a final one", "*.md text\r\n", `${LINE}\r\n`],
		["other lines, odd spacing and blank lines", "# keep\n\n*.md   text \n\n", `${LINE}\n`],
		["a file that holds the line already", `*.md text\n  ${LINE}\n`, ""],
	])("adds to %s only the line, after a line break when needed", (_name, before, addition) => {
		expect(gitAttributesAddition(before)).toBe(addition);
		expect(hasGitAttributesLine(before + addition)).toBe(true);
	});
});

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

	it("is checked again each time the tab shows, not only once: a git init or a pulled .gitattributes changes the row", async () => {
		const root = rootWith({});
		const t = setup(root);
		expect(t.shown()).toBe(false);
		await settle();

		// `git init` after the first display; the next display runs its own check.
		root.files.set(".git", "");
		expect(t.shown()).toBe(false);
		await settle();
		expect(t.refresh).toHaveBeenCalledTimes(1);
		expect(t.shown()).toBe(true);
		await settle();

		// A pull brings the line in.
		root.files.set(".gitattributes", `${LINE}\n`);
		expect(t.shown()).toBe(true);
		await settle();
		expect(t.shown()).toBe(false);
		expect(t.refresh).toHaveBeenCalledTimes(2);
	});

	it("shares a check that is running instead of reading the files again", async () => {
		const root = rootWith({ ".git": "", ".gitattributes": "*.md text\n" });
		const t = setup(root);
		await Promise.all([t.git.check(), t.git.check(), t.git.check()]);
		expect(root.reads).toBe(1);
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
		["keeps the file's CRLF line ends", "*.md text\r\n", `*.md text\r\n${LINE}\r\n`],
	])("%s, shows the notice once, and the row goes away", async (_name, before, after) => {
		const root = rootWith(before === undefined ? { ".git": "" } : { ".git": "", ".gitattributes": before });
		const t = setup(root);
		await t.git.check();
		expect(t.shown()).toBe(true);
		t.render().button.click();
		await settle();
		expect(root.files.get(".gitattributes")).toBe(after);
		expect(root.appends).toEqual([".gitattributes"]);
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
		expect(root.appends).toEqual([".gitattributes"]);
		expect(root.files.get(".gitattributes")).toBe(`${LINE}\n`);
		expect(t.notices).toEqual(["Added to .gitattributes."]);
	});

	it("writes nothing and says so when a pull brought the line in between the check and the click", async () => {
		const root = rootWith({ ".git": "", ".gitattributes": "*.md text\n" });
		const t = setup(root);
		await t.git.check();
		root.files.set(".gitattributes", `*.md text\n${LINE}\n`);
		t.render().button.click();
		await settle();
		expect(root.files.get(".gitattributes")).toBe(`*.md text\n${LINE}\n`);
		expect(root.appends).toEqual([]);
		expect(t.notices).toEqual(["Git sync is already set up."]);
		expect(t.shown()).toBe(false);
	});

	it("never replaces a .gitattributes that a pull brought in after the file was seen missing", async () => {
		const root = rootWith({ ".git": "" });
		const t = setup(root);
		await t.git.check();
		const pulled = "*.md text\n*.png binary\n";
		const exists = root.exists.bind(root);
		let first = true;
		root.exists = (path: string) => {
			if (path === ".gitattributes" && first) {
				first = false;
				root.files.set(".gitattributes", pulled);
				return Promise.resolve(false);
			}
			return exists(path);
		};
		t.render().button.click();
		await settle();
		expect(root.files.get(".gitattributes")).toBe(`${pulled}${LINE}\n`);
	});

	it("a write that fails is shown, nothing is announced, and the row stays for another try", async () => {
		const root = rootWith({ ".git": "" });
		const failure = new Error("read-only folder");
		root.append = () => Promise.reject(failure);
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

	it("a check that was still reading when the button was used does not bring the row back", async () => {
		const root = rootWith({ ".git": "", ".gitattributes": "*.md text\n" });
		const t = setup(root);
		await t.git.check();
		// The next check reads the old text and resolves only after the line was added.
		let release: () => void = () => undefined;
		const gate = new Promise<void>((r) => (release = r));
		const read = root.read.bind(root);
		let held = true;
		root.read = async (path: string) => {
			const old = await read(path);
			if (held) {
				held = false;
				await gate;
			}
			return old;
		};
		const slow = t.git.check();
		await settle();
		t.render().button.click();
		await settle();
		expect(t.shown()).toBe(false);
		release();
		await slow;
		await settle();
		expect(t.shown()).toBe(false);
		expect(root.files.get(".gitattributes")).toBe(`*.md text\n${LINE}\n`);
	});

	it("addGitAttributesLine tells whether the file changed", async () => {
		const root = rootWith({ ".gitattributes": "*.md text\n" });
		expect(await addGitAttributesLine(root)).toBe(true);
		expect(await addGitAttributesLine(root)).toBe(false);
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
