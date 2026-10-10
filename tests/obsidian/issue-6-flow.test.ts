import { describe, expect, it, vi } from "vitest";
import type { PendingTrash } from "../../src/app/SyncService";
import { TICKTICK_TRASH_LABEL } from "../../src/app/SyncService";
import { TickTickError } from "../../src/app/ports";
import type { LinkOption } from "../../src/app/tickTickLink";
import { syncLinkId } from "../../src/domain/types";
import { ConfirmationPrompter, type LinkFlowDeps, type PrompterDeps, NOT_READY_TEXT, linkListFlow, unlinkListFlow } from "../../src/obsidian/tickTickFlow";
import { type SyncHarness, linkedList, syncHarness } from "../app/sync-harness";

// The steps around the dialogs, with scripted answers and the real engine.

type Pick = Parameters<LinkFlowDeps["pick"]>[0];

function flowDeps(s: SyncHarness, over: Partial<LinkFlowDeps> = {}) {
	const picks: Pick[] = [];
	const previews: Parameters<LinkFlowDeps["preview"]>[0][] = [];
	const notices: string[] = [];
	const errors: unknown[] = [];
	const answers: { pick: (LinkOption | null)[]; preview: ("sync" | "back" | null)[] } = { pick: [], preview: [] };
	const linked = vi.fn<LinkFlowDeps["linked"]>();
	const deps: LinkFlowDeps = {
		state: () => s.h.app.store.state,
		ready: () => true,
		api: {
			listProjects: () => s.tt.listProjects(),
			getProjectData: (id) => s.tt.getProjectData(id),
			createProject: (p) => s.tt.createProject(p),
		},
		sync: s.sync,
		index: s.h.app.tasks.lists,
		created: new Map(),
		pick: async (d) => {
			picks.push(d);
			return answers.pick.shift() ?? null;
		},
		preview: async (d) => {
			previews.push(d);
			return answers.preview.shift() ?? null;
		},
		notify: (m) => notices.push(m),
		error: (e) => errors.push(e),
		linked,
		...over,
	};
	return { deps, picks, previews, notices, errors, answers, linked };
}

const optionFor = async (d: Pick, key: string): Promise<LinkOption> => (await d.load()).find((o) => o.key === key)!;

async function setup() {
	const s = await syncHarness();
	const list = await s.h.app.categories.create("Work");
	return { s, list };
}

describe("link a list to TickTick (screens 5 and 6)", () => {
	it("does nothing but say what is missing when sync is not set up on this device", async () => {
		const { s, list } = await setup();
		const t = flowDeps(s, { ready: () => false });
		await linkListFlow(t.deps, list.id);
		expect(t.notices).toEqual([NOT_READY_TEXT]);
		expect(t.picks).toHaveLength(0);
	});

	it("an existing project with tasks on both sides: preview, then the first sync copies both ways", async () => {
		const { s, list } = await setup();
		const project = s.tt.addProject("Work");
		s.tt.add(project.id, { title: "Water the plants" });
		await s.h.app.tasks.create({ title: "Pay rent", categoryId: list.id });
		await s.h.app.tasks.create({ title: "Buy milk", categoryId: list.id });
		const t = flowDeps(s);
		// The dialog hands back one of its own options.
		t.deps.pick = async (d) => {
			t.picks.push(d);
			return optionFor(d, project.id);
		};
		t.answers.preview.push("sync");
		await linkListFlow(t.deps, list.id);
		expect(t.previews).toEqual([{ listName: "Work", projectName: "Work", plan: { listId: list.id, projectId: project.id, toLogwell: 1, toTickTick: 2 } }]);
		expect(t.errors).toEqual([]);
		expect(t.notices).toEqual(["Synced “Work”: 1 in, 2 out."]);
		expect(t.linked).toHaveBeenCalledTimes(1);
		// The first sync counts as this device's latest sync.
		expect(t.linked.mock.calls[0]![0]).toMatchObject({ ok: true, pulled: 1, pushed: 2 });
		expect(s.link("list", list.id)?.ttId).toBe(project.id);
		expect(s.tasks("Water the plants")).toHaveLength(1);
		expect(s.tt.live(project.id).map((x) => x.title).sort()).toEqual(["Buy milk", "Pay rent", "Water the plants"]);
		// A backup was taken first.
		expect((await s.h.app.store.host.listSnapshots()).some((b) => b.kind === "pre-sync")).toBe(true);
	});

	it("the dialog is offered the project with the list's name first", async () => {
		const { s, list } = await setup();
		const project = s.tt.addProject("Work");
		s.tt.addProject("Exercise");
		const t = flowDeps(s);
		await linkListFlow(t.deps, list.id);
		const pick = t.picks[0]!;
		expect(pick.listName).toBe("Work");
		const options = [{ key: "create", disabled: false, label: "Create", detail: "", target: { kind: "create", name: "Work" } }, { key: project.id, disabled: false, label: "Work", detail: "", target: { kind: "existing", projectId: project.id, name: "Work" } }] as LinkOption[];
		expect(pick.initial(options)?.key).toBe(project.id);
	});

	it("dismissing the list dialog changes nothing", async () => {
		const { s, list } = await setup();
		const t = flowDeps(s);
		await linkListFlow(t.deps, list.id);
		expect(t.previews).toHaveLength(0);
		expect(s.h.app.store.state.syncLinks.size).toBe(0);
		expect(s.tt.projects.size).toBe(0);
		expect(t.notices).toEqual([]);
	});

	it("dismissing the preview changes nothing", async () => {
		const { s, list } = await setup();
		const project = s.tt.addProject("Work");
		const t = flowDeps(s);
		t.deps.pick = async (d) => optionFor(d, project.id);
		t.answers.preview.push(null);
		await linkListFlow(t.deps, list.id);
		expect(s.h.app.store.state.syncLinks.size).toBe(0);
		expect(t.linked).not.toHaveBeenCalled();
		expect(t.notices).toEqual([]);
	});

	it("Back returns to the list dialog with the same choice selected", async () => {
		const { s, list } = await setup();
		const project = s.tt.addProject("Study");
		const t = flowDeps(s);
		t.deps.pick = async (d) => {
			t.picks.push(d);
			return optionFor(d, project.id);
		};
		t.answers.preview.push("back", null);
		await linkListFlow(t.deps, list.id);
		expect(t.picks).toHaveLength(2);
		const options = await t.picks[1]!.load();
		expect(t.picks[1]!.initial(options)?.key).toBe(project.id);
		expect(s.h.app.store.state.syncLinks.size).toBe(0);
	});

	it("creating a project: the preview counts only what goes up, and nothing is created in TickTick until Sync", async () => {
		const { s, list } = await setup();
		await s.h.app.tasks.create({ title: "Pay rent", categoryId: list.id });
		await s.h.app.tasks.create({ title: "Buy milk", categoryId: list.id });
		const t = flowDeps(s);
		t.deps.pick = async (d) => optionFor(d, "create");
		t.answers.preview.push("back", null);
		await linkListFlow(t.deps, list.id);
		expect(t.previews.map((p) => p.plan)).toEqual([
			{ toLogwell: 0, toTickTick: 2 },
			{ toLogwell: 0, toTickTick: 2 },
		]);
		expect(s.tt.projects.size).toBe(0);
	});

	it("creating a project, then Sync: the project is made with the list's name and the tasks go up", async () => {
		const { s, list } = await setup();
		await s.h.app.tasks.create({ title: "Pay rent", categoryId: list.id });
		const t = flowDeps(s);
		t.deps.pick = async (d) => optionFor(d, "create");
		t.answers.preview.push("sync");
		await linkListFlow(t.deps, list.id);
		const [project] = [...s.tt.projects.values()];
		expect(project).toMatchObject({ name: "Work", viewMode: "list" });
		expect(s.link("list", list.id)?.ttId).toBe(project!.id);
		expect(s.tt.live(project!.id).map((x) => x.title)).toEqual(["Pay rent"]);
		expect(t.notices).toEqual(["Synced “Work”: 0 in, 1 out."]);
	});

	it("a list over the 999 open tasks is refused before any dialog or project", async () => {
		const { s, list } = await setup();
		const t = flowDeps(s);
		t.deps.index = { tasksOf: (g, l) => s.h.app.tasks.lists.tasksOf(g, l), openCount: () => 1000 };
		await linkListFlow(t.deps, list.id);
		expect(t.picks).toHaveLength(0);
		expect(s.tt.projects.size).toBe(0);
		expect((t.errors[0] as Error).message).toContain("more than 999 open tasks");
	});

	it("a list that got linked while the dialogs were open creates no project", async () => {
		const { s, list } = await setup();
		const t = flowDeps(s);
		t.deps.pick = async (d) => optionFor(d, "create");
		t.deps.preview = async () => {
			// Another device's link arrives meanwhile.
			await s.sync.applyFirstSync(list.id, s.tt.addProject("Other").id);
			return "sync";
		};
		const createProject = vi.spyOn(s.tt, "createProject");
		await linkListFlow(t.deps, list.id);
		expect(createProject).not.toHaveBeenCalled();
		expect((t.errors[0] as Error).message).toBe("This list is already linked to TickTick.");
	});

	it("when the first sync of a created project fails, a retry reuses that project instead of creating another", async () => {
		const { s, list } = await setup();
		await s.h.app.tasks.create({ title: "Pay rent", categoryId: list.id });
		const t = flowDeps(s);
		t.deps.pick = async (d) => optionFor(d, "create");
		t.answers.preview.push("sync", "sync");
		// The first sync cannot read the new project.
		const real = s.tt.createProject.bind(s.tt);
		const createProject = vi.spyOn(s.tt, "createProject").mockImplementation((p) => {
			const made = real(p);
			s.tt.fail("getProjectData", new TickTickError("network", "TickTick: no answer (network error)."));
			return made;
		});
		await linkListFlow(t.deps, list.id);
		expect(s.link("list", list.id)).toBeUndefined();
		expect(s.tt.projects.size).toBe(1);
		expect(t.deps.created.get(list.id)?.name).toBe("Work");
		await linkListFlow(t.deps, list.id);
		expect(createProject).toHaveBeenCalledTimes(1);
		expect(s.tt.projects.size).toBe(1);
		expect(s.link("list", list.id)?.ttId).toBe([...s.tt.projects.keys()][0]);
		expect(t.deps.created.size).toBe(0);
		expect(s.tt.live([...s.tt.projects.keys()][0]!).map((x) => x.title)).toEqual(["Pay rent"]);
	});

	it("a list with sections gets a project that can hold them", async () => {
		const { s, list } = await setup();
		await s.h.app.sections.create(list.id, "Errands");
		const t = flowDeps(s);
		t.deps.pick = async (d) => optionFor(d, "create");
		t.answers.preview.push("sync");
		await linkListFlow(t.deps, list.id);
		expect([...s.tt.projects.values()][0]).toMatchObject({ name: "Work", viewMode: "kanban" });
	});

	it("a note list is refused by the preview step with the engine's message; nothing is written", async () => {
		const { s, list } = await setup();
		const notes = s.tt.addProject("Reading notes", "NOTE");
		const t = flowDeps(s);
		// The dialog greys such a list out, but a stale choice must still be refused.
		t.deps.pick = async (d) => ({ ...(await optionFor(d, notes.id)), disabled: false });
		await linkListFlow(t.deps, list.id);
		expect(t.errors).toHaveLength(1);
		expect((t.errors[0] as Error).message).toBe("A TickTick note list cannot be linked.");
		expect(s.h.app.store.state.syncLinks.size).toBe(0);
		expect(t.linked).not.toHaveBeenCalled();
	});

	it("a TickTick failure while reading the preview is reported once and nothing is written", async () => {
		const { s, list } = await setup();
		const project = s.tt.addProject("Work");
		const t = flowDeps(s);
		t.deps.pick = async (d) => {
			const chosen = await optionFor(d, project.id);
			// The list was read; the preview's read fails.
			s.tt.fail("getProjectData", new TickTickError("rate-limited", "TickTick: too many requests", { retryAfterSec: 30 }));
			return chosen;
		};
		await linkListFlow(t.deps, list.id);
		expect(t.errors).toHaveLength(1);
		expect(s.h.app.store.state.syncLinks.size).toBe(0);
	});

	it("a first sync that fails reports the failure instead of a count", async () => {
		const { s, list } = await setup();
		const project = s.tt.addProject("Work");
		await s.h.app.tasks.create({ title: "Pay rent", categoryId: list.id });
		const t = flowDeps(s);
		t.deps.pick = async (d) => optionFor(d, project.id);
		t.answers.preview.push("sync");
		s.tt.fail("createTask", new TickTickError("unauthorized", "TickTick: the API token was refused"));
		await linkListFlow(t.deps, list.id);
		expect(t.notices.some((n) => n.includes("the API token was refused"))).toBe(true);
		expect(t.notices.some((n) => n.startsWith("Synced"))).toBe(false);
	});
});

describe("unlink (SYNC-02)", () => {
	it("removes the link, keeps every task on both sides and says so", async () => {
		const s = await syncHarness();
		const { listId, projectId } = await linkedList(s);
		await s.h.app.tasks.create({ title: "Pay rent", categoryId: listId });
		await s.sync.sync();
		const t = flowDeps(s);
		await unlinkListFlow(t.deps, listId);
		expect(s.link("list", listId)).toBeUndefined();
		expect(s.tasks("Pay rent")).toHaveLength(1);
		expect(s.tt.live(projectId)).toHaveLength(1);
		expect(t.notices).toEqual(["Work is no longer synced with TickTick. Its tasks stay on both sides."]);
		expect(t.linked).toHaveBeenCalledWith(null);
	});
});

describe("tasks missing from TickTick (screens 8 and 9)", () => {
	async function withTasks(n: number) {
		const s = await syncHarness();
		const { listId, projectId } = await linkedList(s);
		const ids: string[] = [];
		for (let i = 1; i <= n; i++) ids.push((await s.h.app.tasks.create({ title: `Errand ${i}`, categoryId: listId })).task.id);
		await s.sync.sync();
		s.tick();
		return { s, listId, projectId, ids };
	}

	function prompter(s: SyncHarness, answers: ("trash" | "keep" | null)[], sync: PrompterDeps["sync"] = s.sync) {
		const asked: { pending: PendingTrash; listName: string }[] = [];
		const undo: [string, string][] = [];
		/** Each notice's Undo button, bound the way the session binds it. */
		const undoButtons: (() => Promise<boolean>)[] = [];
		const notices: string[] = [];
		const errors: unknown[] = [];
		const p = new ConfirmationPrompter({
			state: () => s.h.app.store.state,
			sync,
			undoMark: () => s.h.app.store.undoMark(),
			ask: async (pending, listName) => {
				asked.push({ pending, listName });
				return answers.shift() ?? null;
			},
			notifyUndo: (m, l, mark) => {
				undo.push([m, l]);
				undoButtons.push(s.h.app.store.undoFor(mark, l));
			},
			notify: (m) => notices.push(m),
			error: (e) => errors.push(e),
		});
		return { p, asked, undo, undoButtons, notices, errors };
	}
	const settle = () => new Promise((r) => setTimeout(r, 0));

	it("Move to Trash moves the listed tasks, in one undo step, with an Undo notice", async () => {
		const { s, ids, listId } = await withTasks(6);
		for (const id of ids.slice(0, 5)) s.tt.remove(s.link("task", id)!.ttId);
		const r = await s.sync.sync();
		const t = prompter(s, ["trash"]);
		t.p.handle(r.needsConfirmation);
		await settle();
		expect(t.asked).toHaveLength(1);
		expect(t.asked[0]!.listName).toBe("Work");
		expect(t.asked[0]!.pending).toMatchObject({ listId, reason: "many" });
		expect(s.h.app.store.state.tasks.size).toBe(1);
		expect(t.undo).toEqual([["Moved 5 tasks to Trash.", TICKTICK_TRASH_LABEL]]);
		expect(await t.undoButtons[0]!()).toBe(true);
		expect(s.h.app.store.state.tasks.size).toBe(6);
	});

	it("two Move to Trash writes: the first notice's Undo does not undo the second (#39)", async () => {
		const { s, ids } = await withTasks(6);
		const size = () => s.h.app.store.state.tasks.size;
		for (const id of ids.slice(0, 5)) s.tt.remove(s.link("task", id)!.ttId);
		const t = prompter(s, ["trash", "trash"]);
		t.p.handle((await s.sync.sync()).needsConfirmation);
		await settle();
		expect(size()).toBe(1);
		s.tt.remove(s.link("task", ids[5]!)!.ttId);
		s.tick();
		t.p.handle((await s.sync.sync()).needsConfirmation);
		await settle();
		expect(size()).toBe(0);
		expect(t.undo.map(([, label]) => label)).toEqual([TICKTICK_TRASH_LABEL, TICKTICK_TRASH_LABEL]);

		await expect(t.undoButtons[0]!()).rejects.toMatchObject({ code: "UndoConflict" });
		expect(size()).toBe(0);
		await expect(t.undoButtons[1]!()).resolves.toBe(true);
		expect(size()).toBe(1);
	});

	it("Move to Trash that waits while another change is made keeps a working Undo (#39)", async () => {
		const { s, ids } = await withTasks(6);
		for (const id of ids.slice(0, 5)) s.tt.remove(s.link("task", id)!.ttId);
		// The trash write waits (behind a running sync); meanwhile the user edits the remaining task.
		const sync: PrompterDeps["sync"] = {
			trashMissing: async (listId, taskIds) => {
				await s.h.app.tasks.update(ids[5]!, { title: "Errand 6, today" });
				return s.sync.trashMissing(listId, taskIds);
			},
			keepMissing: (...args) => s.sync.keepMissing(...args),
		};
		const t = prompter(s, ["trash"], sync);
		t.p.handle((await s.sync.sync()).needsConfirmation);
		await settle();
		expect(s.h.app.store.state.tasks.size).toBe(1);
		await expect(t.undoButtons[0]!()).resolves.toBe(true);
		expect(s.h.app.store.state.tasks.size).toBe(6);
		expect(s.h.app.store.state.tasks.get(ids[5]!)?.title).toBe("Errand 6, today");
	});

	it("Keep leaves the tasks in Logwell, marks them Not synced (localOnly) and never sends them again", async () => {
		const { s, ids, projectId } = await withTasks(6);
		for (const id of ids.slice(0, 5)) s.tt.remove(s.link("task", id)!.ttId);
		const r = await s.sync.sync();
		const t = prompter(s, ["keep"]);
		t.p.handle(r.needsConfirmation);
		await settle();
		expect(s.h.app.store.state.tasks.size).toBe(6);
		for (const id of ids.slice(0, 5)) expect(s.h.app.store.state.syncLinks.get(syncLinkId("task", id))?.mode).toBe("localOnly");
		expect(t.undo).toEqual([]);
		expect(t.notices).toEqual(["Kept 5 tasks in Logwell only. They are not synced."]);
		s.tick();
		await s.sync.sync();
		expect(s.tt.live(projectId)).toHaveLength(1);
		expect(s.h.app.store.state.tasks.size).toBe(6);
	});

	it("Keep on an emptied list unlinks the list and keeps every task", async () => {
		const { s, ids, listId } = await withTasks(2);
		for (const id of ids) s.tt.remove(s.link("task", id)!.ttId);
		const r = await s.sync.sync();
		expect(r.needsConfirmation[0]).toMatchObject({ reason: "emptied" });
		const t = prompter(s, ["keep"]);
		t.p.handle(r.needsConfirmation);
		await settle();
		expect(s.link("list", listId)).toBeUndefined();
		expect(s.h.app.store.state.tasks.size).toBe(2);
		expect(t.notices).toEqual(["Kept 2 tasks. Work is no longer synced with TickTick."]);
	});

	it("Move to Trash on an emptied list trashes all of its tasks", async () => {
		const { s, ids } = await withTasks(2);
		for (const id of ids) s.tt.remove(s.link("task", id)!.ttId);
		const r = await s.sync.sync();
		const t = prompter(s, ["trash"]);
		t.p.handle(r.needsConfirmation);
		await settle();
		expect(s.h.app.store.state.tasks.size).toBe(0);
		expect(t.undo[0]![0]).toBe("Moved 2 tasks to Trash.");
	});

	it("closing the dialog decides nothing and does not ask again for the same set", async () => {
		const { s, ids } = await withTasks(6);
		for (const id of ids.slice(0, 5)) s.tt.remove(s.link("task", id)!.ttId);
		const r = await s.sync.sync();
		const t = prompter(s, [null, null]);
		t.p.handle(r.needsConfirmation);
		await settle();
		expect(t.asked).toHaveLength(1);
		expect(s.h.app.store.state.tasks.size).toBe(6);
		// The next pull reports the same tasks again.
		s.tick();
		t.p.handle((await s.sync.sync()).needsConfirmation);
		await settle();
		expect(t.asked).toHaveLength(1);
		// Once it is settled, the same tasks missing again are a new question.
		t.p.handle([]);
		t.p.handle(r.needsConfirmation);
		await settle();
		expect(t.asked).toHaveLength(2);
	});

	it("a changed set is asked again", async () => {
		const { s, ids } = await withTasks(7);
		for (const id of ids.slice(0, 5)) s.tt.remove(s.link("task", id)!.ttId);
		const t = prompter(s, [null, null]);
		t.p.handle((await s.sync.sync()).needsConfirmation);
		await settle();
		s.tt.remove(s.link("task", ids[5]!)!.ttId);
		s.tick();
		t.p.handle((await s.sync.sync()).needsConfirmation);
		await settle();
		expect(t.asked.map((a) => a.pending.tasks.length)).toEqual([5, 6]);
	});

	it("asks one dialog at a time, and skips a question a later sync already settled", async () => {
		const { s, ids, listId } = await withTasks(6);
		for (const id of ids.slice(0, 5)) s.tt.remove(s.link("task", id)!.ttId);
		const first = (await s.sync.sync()).needsConfirmation;
		let release!: (v: "keep") => void;
		const open = new Promise<"keep">((r) => (release = r));
		const asked: string[] = [];
		const p = new ConfirmationPrompter({
			state: () => s.h.app.store.state,
			sync: s.sync,
			ask: (pending) => {
				asked.push(pending.reason);
				return asked.length === 1 ? open : Promise.resolve("trash");
			},
			undoMark: () => s.h.app.store.undoMark(),
			notifyUndo: () => undefined,
			notify: () => undefined,
			error: () => undefined,
		});
		const emptied: PendingTrash = { listId, reason: "emptied", tasks: first[0]!.tasks };
		p.handle([first[0]!, emptied]);
		await settle();
		// Only the first is open.
		expect(asked).toEqual(["many"]);
		// A later sync no longer reports the second question.
		p.handle([first[0]!]);
		release("keep");
		await settle();
		expect(asked).toEqual(["many"]);
	});

	it("a task that came back while the dialog was open is neither trashed nor kept as missing", async () => {
		const { s, ids, listId } = await withTasks(6);
		for (const id of ids.slice(0, 5)) s.tt.remove(s.link("task", id)!.ttId);
		const pending = (await s.sync.sync()).needsConfirmation;
		let answer!: (v: "trash") => void;
		const asked: PendingTrash[] = [];
		const p = new ConfirmationPrompter({
			state: () => s.h.app.store.state,
			sync: s.sync,
			ask: (pend) => {
				asked.push(pend);
				return new Promise<"trash">((r) => (answer = r));
			},
			undoMark: () => s.h.app.store.undoMark(),
			notifyUndo: () => undefined,
			notify: () => undefined,
			error: () => undefined,
		});
		p.handle(pending);
		await settle();
		// While the dialog is open, a later sync no longer reports the first task as missing.
		const [back, ...rest] = pending[0]!.tasks;
		p.handle([{ ...pending[0]!, tasks: rest }]);
		answer("trash");
		await settle();
		const state = s.h.app.store.state;
		expect(state.tasks.get(back!.id)).toBeDefined();
		expect(rest.every((t) => state.tasks.get(t.id) === undefined)).toBe(true);
		expect(s.link("task", back!.id)).toBeDefined();
		// The changed set is not asked a second time: its tasks are gone.
		expect(asked).toHaveLength(1);
		expect(listId).toBeDefined();
	});

	it("a list deleted meanwhile is not asked about", async () => {
		const { s, ids, listId } = await withTasks(6);
		for (const id of ids.slice(0, 5)) s.tt.remove(s.link("task", id)!.ttId);
		const pending = (await s.sync.sync()).needsConfirmation;
		await s.h.app.categories.delete(listId);
		const t = prompter(s, ["trash"]);
		t.p.handle(pending);
		await settle();
		expect(t.asked).toHaveLength(0);
	});

	it("an error from the engine is reported and the next question still comes", async () => {
		const { s, ids, listId } = await withTasks(6);
		for (const id of ids.slice(0, 5)) s.tt.remove(s.link("task", id)!.ttId);
		const pending = (await s.sync.sync()).needsConfirmation;
		const t = prompter(s, ["trash", "keep"]);
		vi.spyOn(s.sync, "trashMissing").mockRejectedValueOnce(new Error("read-only"));
		const second: PendingTrash = { listId, reason: "many", tasks: pending[0]!.tasks.slice(0, 2) };
		t.p.handle([pending[0]!, second]);
		await settle();
		expect(t.errors).toHaveLength(1);
		expect(t.asked).toHaveLength(2);
	});
});
