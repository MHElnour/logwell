// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type PendingTrash, TICKTICK_TRASH_LABEL } from "../../src/app/SyncService";
import { TickTickError } from "../../src/app/ports";
import type { LinkOption } from "../../src/app/tickTickLink";
import { syncLinkId } from "../../src/domain/types";
import { ConfirmationPrompter, type LinkFlowDeps, linkListFlow, NOT_READY_TEXT, type PrompterDeps, unlinkListFlow } from "../../src/obsidian/tickTickFlow";
import { linkedList, type SyncHarness, syncHarness } from "../app/sync-harness";
import { buildLinkForm, buildMissingForm, buildPreviewForm, missingTitle } from "../../src/obsidian/tickTickDialogs";

describe("linking and unlinking", () => {
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
});

describe("dialog forms", () => {
	// The dialogs' forms are plain DOM, tested without Obsidian's Modal.

	beforeAll(() => {
		(HTMLElement.prototype as unknown as { createEl: unknown }).createEl = function (this: HTMLElement, tag: string, o: { cls?: string; attr?: Record<string, string> } = {}) {
			const node = this.ownerDocument.createElement(tag);
			if (o.cls !== undefined) node.className = o.cls;
			for (const [k, v] of Object.entries(o.attr ?? {})) node.setAttribute(k, v);
			this.appendChild(node);
			return node;
		};
	});
	afterEach(() => document.body.replaceChildren());

	const settle = async () => {
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	};
	const box = () => {
		const c = document.createElement("div");
		document.body.appendChild(c);
		return c;
	};
	const text = (c: HTMLElement, sel: string) => c.querySelector(sel)?.textContent;
	const button = (c: HTMLElement, label: string) => [...c.querySelectorAll("button")].find((b) => b.textContent === label)!;

	const option = (key: string, label: string, over: Partial<LinkOption> = {}): LinkOption => ({
		key,
		label,
		detail: "",
		disabled: false,
		target: key === "create" ? { kind: "create", name: "Work" } : { kind: "existing", projectId: key, name: label },
		...over,
	});
	const OPTIONS = [
		option("create", "Create “Work” in TickTick", { detail: "new, empty" }),
		option("inbox", "Inbox", { detail: "Linked to Inbox", disabled: true }),
		option("p1", "Work"),
		option("p2", "Exercise"),
		option("p3", "Reading notes", { detail: "Note list: can't sync", disabled: true }),
		option("p4", "Study"),
	];

	function link(load: () => Promise<LinkOption[]> = async () => OPTIONS, initial = (o: readonly LinkOption[]) => o.find((x) => x.key === "p1")) {
		const c = box();
		const onContinue = vi.fn();
		const onCancel = vi.fn();
		const form = buildLinkForm(c, { listName: "Work", load, initial, onContinue, onCancel });
		const rows = () => [...c.querySelectorAll<HTMLElement>('[role="option"]')];
		return { c, form, onContinue, onCancel, rows };
	}

	describe("link dialog (screen 5)", () => {
		it("shows a loading line, then the lists with the initial one selected", async () => {
			let resolve!: (o: LinkOption[]) => void;
			const t = link(() => new Promise((r) => (resolve = r)));
			expect(text(t.c, ".cp-tt-status")).toBe("Loading your TickTick lists…");
			expect(t.c.querySelector<HTMLElement>('[role="listbox"]')!.hidden).toBe(true);
			expect(button(t.c, "Continue").disabled).toBe(true);
			resolve(OPTIONS);
			await settle();
			expect(t.c.querySelector<HTMLElement>(".cp-tt-status")!.hidden).toBe(true);
			expect(t.rows().map((r) => r.querySelector(".cp-tt-option-name")!.textContent)).toEqual(OPTIONS.map((o) => o.label));
			expect(t.rows().map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "false", "true", "false", "false", "false"]);
			expect(button(t.c, "Continue").disabled).toBe(false);
		});

		it("marks lists that cannot be chosen: a linked list and a note list, with their reason", async () => {
			const t = link();
			await settle();
			const [, inbox, , , notes] = t.rows();
			expect(inbox!.getAttribute("aria-disabled")).toBe("true");
			expect(inbox!.textContent).toContain("Linked to Inbox");
			expect(notes!.getAttribute("aria-disabled")).toBe("true");
			expect(notes!.textContent).toContain("Note list: can't sync");
			notes!.click();
			expect(notes!.getAttribute("aria-selected")).toBe("false");
			expect(t.rows()[2]!.getAttribute("aria-selected")).toBe("true");
		});

		it("a click selects, Continue passes the selected option", async () => {
			const t = link();
			await settle();
			t.rows()[0]!.click();
			button(t.c, "Continue").click();
			expect(t.onContinue).toHaveBeenCalledWith(OPTIONS[0]);
		});

		it("Arrow keys move over the lists and skip the ones that cannot be chosen; Enter continues", async () => {
			const t = link();
			await settle();
			const key = (row: HTMLElement, k: string) => row.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
			key(t.rows()[2]!, "ArrowDown");
			expect(t.rows()[3]!.getAttribute("aria-selected")).toBe("true");
			key(t.rows()[3]!, "ArrowDown");
			// "Reading notes" is skipped.
			expect(t.rows()[5]!.getAttribute("aria-selected")).toBe("true");
			key(t.rows()[5]!, "ArrowDown");
			expect(t.rows()[5]!.getAttribute("aria-selected")).toBe("true");
			key(t.rows()[5]!, "ArrowUp");
			key(t.rows()[3]!, "ArrowUp");
			key(t.rows()[2]!, "ArrowUp");
			// "Inbox" is skipped on the way to "Create".
			expect(t.rows()[0]!.getAttribute("aria-selected")).toBe("true");
			key(t.rows()[0]!, "Enter");
			expect(t.onContinue).toHaveBeenCalledWith(OPTIONS[0]);
		});

		it("only the selected row is a tab stop", async () => {
			const t = link();
			await settle();
			expect(t.rows().map((r) => r.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1]);
		});

		it("says the 999 and 99 limits, and what is not synced", async () => {
			const t = link();
			await settle();
			expect(text(t.c, ".cp-tt-warn")).toContain("at most 999 open tasks");
			expect(text(t.c, ".cp-tt-warn")).toContain("99 on its free plan");
			expect(t.c.textContent).toContain("Repeating tasks and TickTick notes are not synced.");
			expect(t.c.textContent).toContain("A tag name can be used only once, whatever its parent (TickTick allows one tag per name).");
		});

		it("advises changing synced tasks in one place", async () => {
			const t = link();
			await settle();
			expect(t.c.textContent).toContain("Tip: make changes to synced tasks in one place, like TickTick, and they show up on both sides.");
		});

		it("shows the error of a failed load, keeps Continue off and still cancels", async () => {
			const t = link(() => Promise.reject(new Error("TickTick: the API token was refused")));
			await settle();
			expect(text(t.c, '[role="alert"]')).toBe("TickTick: the API token was refused");
			expect(button(t.c, "Continue").disabled).toBe(true);
			button(t.c, "Cancel").click();
			expect(t.onCancel).toHaveBeenCalled();
		});

		it("names its listbox by a visible-text label, not an aria-label", async () => {
			const t = link();
			await settle();
			const list = t.c.querySelector('[role="listbox"]')!;
			expect(list.hasAttribute("aria-label")).toBe(false);
			expect(t.c.querySelector(`#${list.getAttribute("aria-labelledby")}`)!.textContent).toBe("TickTick lists");
		});

		it("starts on the first usable list when none is suggested", async () => {
			const t = link(async () => [option("inbox", "Inbox", { disabled: true }), option("p1", "Home")], () => undefined);
			await settle();
			expect(button(t.c, "Continue").disabled).toBe(true);
			expect(t.rows()[1]!.tabIndex).toBe(0);
			t.rows()[1]!.click();
			expect(button(t.c, "Continue").disabled).toBe(false);
		});
	});

	describe("first-sync preview (screen 6)", () => {
		function preview(plan: { toLogwell: number; toTickTick: number }) {
			const c = box();
			const onSync = vi.fn();
			const onBack = vi.fn();
			buildPreviewForm(c, { listName: "Work", projectName: "Work", plan, onSync, onBack });
			return { c, onSync, onBack };
		}

		it("shows both counts and warns about duplicates when both sides have tasks", () => {
			const t = preview({ toLogwell: 18, toTickTick: 5 });
			expect([...t.c.querySelectorAll(".cp-tt-count")].map((e) => e.textContent)).toEqual(["18open tasks come to Logwell", "5open tasks go to TickTick"]);
			expect(t.c.textContent).toContain("Both lists already have tasks. They are not matched");
			expect(text(t.c, ".cp-tt-warn")).toBe("Tasks that exist on both sides will appear twice. Delete the copy you don't want; the delete syncs.");
			expect(t.c.textContent).toContain("A backup is taken first");
		});

		it.each([
			[0, 7],
			[7, 0],
			[0, 0],
		])("has no duplicate warning when a side is empty (%i in, %i out)", (toLogwell, toTickTick) => {
			const t = preview({ toLogwell, toTickTick });
			expect(t.c.querySelector(".cp-tt-warn")).toBeNull();
			expect(t.c.textContent).not.toContain("Both lists already have tasks");
		});

		it("uses the singular for one task", () => {
			const t = preview({ toLogwell: 1, toTickTick: 1 });
			expect([...t.c.querySelectorAll(".cp-tt-count span")].map((e) => e.textContent)).toEqual(["open task comes to Logwell", "open task goes to TickTick"]);
		});

		it("Sync and Back call back", () => {
			const t = preview({ toLogwell: 1, toTickTick: 2 });
			button(t.c, "Sync").click();
			button(t.c, "Back").click();
			expect(t.onSync).toHaveBeenCalledTimes(1);
			expect(t.onBack).toHaveBeenCalledTimes(1);
		});
	});

	describe("tasks missing from TickTick (screens 8 and 9)", () => {
		const many: PendingTrash = {
			listId: "L",
			reason: "many",
			tasks: ["Call the bank", "Book the dentist", "Send the report", "Buy printer paper", "Renew the parking permit", "Order new chairs", "Plan the team lunch"].map((title, i) => ({ id: `t${i}`, title })),
		};
		const emptied: PendingTrash = { listId: "L", reason: "emptied", tasks: Array.from({ length: 23 }, (_, i) => ({ id: `e${i}`, title: `Task ${i}` })) };

		function form(pending: PendingTrash) {
			const c = box();
			const onChoose = vi.fn();
			buildMissingForm(c, { pending, listName: "Work", onChoose });
			return { c, onChoose };
		}

		it("titles the question", () => {
			expect(missingTitle(many, "Work")).toBe("7 tasks were removed from Work in TickTick");
			expect(missingTitle({ ...many, tasks: many.tasks.slice(0, 5) }, "Work")).toBe("5 tasks were removed from Work in TickTick");
			expect(missingTitle(emptied, "Work")).toBe("Work is empty in TickTick");
		});

		it("lists the titles of 5 or more removed tasks", () => {
			const t = form(many);
			expect([...t.c.querySelectorAll(".cp-tt-titles li")].map((li) => li.textContent)).toEqual(many.tasks.map((x) => x.title));
			expect(t.c.textContent).toContain("Move them to Trash in Logwell too?");
		});

		it("Move to Trash and Keep report their choice", () => {
			const t = form(many);
			button(t.c, "Move to Trash").click();
			button(t.c, "Keep").click();
			expect(t.onChoose.mock.calls).toEqual([["trash"], ["keep"]]);
		});

		it("an emptied list asks about all of its tasks and says Keep also unlinks", () => {
			const t = form(emptied);
			expect(t.c.textContent).toContain("It had 23 tasks at the last sync. Move all 23 to Trash in Logwell?");
			expect(t.c.textContent).toContain("Keep keeps them in Logwell and unlinks the list, so nothing is deleted.");
			expect(t.c.querySelector(".cp-tt-titles")).toBeNull();
		});

		it("the titles list is a keyboard stop so a long list can scroll", () => {
			expect(form(many).c.querySelector(".cp-tt-titles")!.getAttribute("tabindex")).toBe("0");
		});
	});
});
