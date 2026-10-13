import { sanitizeNoteName } from "../domain/notes";
import { type NoteDoc, type StoredNoteBase, baseDoc, docFromTickTick, isChecklist, isEmptyDoc, mergeDocs, readNote, sameDoc, storedBase, writeNote } from "../domain/ticktick/noteText";
import type { TtTask } from "../domain/ticktick/types";
import { type ID, type SyncLink, syncLinkId } from "../domain/types";
import type { NotePort } from "./ports";
import type { AppStore } from "./store";
import type { TaskService } from "./TaskService";
import type { Tx } from "./tx";

// Description notes the TickTick sync creates and keeps in step with TickTick's text. Runs
// inside a sync, after the pull is written and linked and before the push. The only code that writes a user's note
// text, and only a note the sync created while its link says so (`noteBySync`).
//
// Rules:
// - Nothing happens while the setting is off; a task whose note the user linked is never read, written or sent.
// - A synced task with TickTick text (`content`; for a checklist `desc` or an item) and no note gets one (in the note
//   folder, named after the task like any description note). A task whose sync note was unlinked or deleted (`noteBase` kept, `noteBySync` false)
//   never gets a new one.
// - A note is read only when its file changed since this session last read or wrote it (its modification time), or
//   on its first sync in a session. TickTick's text is compared with the base every sync (no I/O).
// - A task whose kind changed in TickTick (normal and checklist): the note, the base and TickTick's text are all read
//   as the new kind (a checklist's tick-box lines become items, or items become text lines), so TickTick's change
//   merges with the note's like any edit and nothing of either side is lost.
// - The merge is three-way against the link's `noteBase`/`noteItems`. When the note is written, the base becomes
//   TickTick's text at once (its own links command, before any push), so a push that fails is sent again by the next
//   sync and a merge is never marked twice. The base becomes the pushed text once TickTick confirms it.
// - Every note write is a compare-and-swap through `vault.process`, after checking that the link still owns the note
//   at that path: an edit that landed after the read is kept, and the next sync merges it.
// - Identity: a sync note with no file at its path at a sync is let go (never recreated), unless the task's link
//   moved meanwhile (a rename the link follows; checked again inside the command that lets it go). A sync
//   note this session saw deleted (the host reports vault changes through `edited`) whose path got a file again
//   within `REPLACED_WITHIN_MS` (an atomic replace by a file sync tool), or again with no create seen, is the same
//   note. A file created at that path later than that is another file: the sync note is let go, the file untouched.

/** The description-note side of the sync: the vault and the two settings it reads. */
export interface SyncNotesDeps {
	port: NotePort;
	/** The `tickTickNotes` setting. */
	enabled(): boolean;
	/** The description note folder (`noteFolder`). */
	folder(): string;
}

/** A note change to send up: the merged doc and TickTick's text it was merged with (re-checked before sending). */
export interface NotePush {
	logwellId: ID;
	ttId: string;
	doc: NoteDoc;
	pulled: NoteDoc;
	checklist: boolean;
	/** The note's path when it was read: the push is sent only while the link still owns that note. */
	path: string;
}

/** A create at a sync note's path this soon after its delete is the same note (an atomic replace). */
export const REPLACED_WITHIN_MS = 5_000;

/** A `SyncResult` warning: a note could not be read or written (a vault error); the rest of the sync went on. */
export const TICKTICK_NOTE_WARNING = "A description note could not be read or written; it is tried again at the next sync.";

interface SeenNote {
	path: string;
	mtime: number;
	text: string;
	checklist: boolean;
	ours: NoteDoc;
}

interface Pairing {
	logwellId: ID;
	ttId: string;
}

/**
 * Errors the vault threw while the note step read, wrote or created a note: the only ones it turns into a warning
 * that skips that note. Any other error (a bug) fails the sync like anywhere else.
 */
const vaultErrors = new WeakSet<Error>();

/** Runs one vault call, marking what it throws as a vault error. */
async function fromVault<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (err) {
		if (err instanceof Error) vaultErrors.add(err);
		throw err;
	}
}

function isVaultError(err: unknown): err is Error {
	return err instanceof Error && vaultErrors.has(err);
}

/** A link's fields without the note's items, for a write that sets the note fields anew. */
function withoutItems(link: SyncLink): SyncLink {
	const { noteItems: _items, ...rest } = link;
	return rest;
}

/** Whether the link still owns the note at `path` (the user may have unlinked it while the sync worked). */
export function ownsNote(store: AppStore, id: ID, path: string): boolean {
	const state = store.state;
	return state.syncLinks.get(syncLinkId("task", id))?.noteBySync === true && state.tasks.get(id)?.descriptionNote?.path === path;
}

export class SyncNotes {
	/** What this session last read or wrote of each sync note: read again only when the file changed. */
	private readonly seen = new Map<ID, SeenNote>();
	/** The paths of `seen`, for `edited`. */
	private readonly byPath = new Map<string, ID>();
	/** Sync notes seen deleted from the vault this session: the path, when, and whether a file came back too late. */
	private readonly gone = new Map<ID, { path: string; at: number; late: boolean }>();
	/** Notes made whose link could not be written (the store turned read-only): reused, never made twice. */
	private readonly made = new Map<ID, string>();

	constructor(
		readonly deps: SyncNotesDeps,
		private readonly store: AppStore,
		private readonly tasks: TaskService,
		private readonly labels: { content: string; links: string },
	) {}

	private remember(id: ID, path: string, mtime: number | null, text: string, checklist: boolean): SeenNote {
		const note: SeenNote = { path, mtime: mtime ?? Number.NaN, text, checklist, ours: readNote(text, checklist) };
		this.forget(id);
		this.seen.set(id, note);
		this.byPath.set(path, id);
		return note;
	}

	private forget(id: ID): void {
		const old = this.seen.get(id);
		if (old !== undefined && this.byPath.get(old.path) === id) this.byPath.delete(old.path);
		this.seen.delete(id);
	}

	/**
	 * A vault change at `path` (modify, create, delete, rename). Whether it is an edit of a note the sync keeps in step
	 * (seen this session), made since the sync last read or wrote it: the sync's own writes are not. Lets the host push
	 * it soon, like a task edit. A sync note that is gone is remembered as deleted.
	 */
	edited(path: string): boolean {
		if (!this.deps.enabled()) return false;
		const mtime = this.deps.port.modifiedAt(path);
		const now = this.store.clock.now().getTime();
		if (mtime !== null) {
			for (const [goneId, g] of this.gone) {
				if (g.path !== path) continue;
				// A file at a deleted sync note's path: soon after, the same note (replaced); later, another file.
				if (now - g.at <= REPLACED_WITHIN_MS) this.gone.delete(goneId);
				else g.late = true;
				return !g.late;
			}
		}
		const id = this.byPath.get(path);
		if (id === undefined) return false;
		if (mtime === null) {
			this.gone.set(id, { path, at: now, late: false });
			this.forget(id);
			return false;
		}
		return mtime !== this.seen.get(id)?.mtime;
	}

	/**
	 * The note step of one sync over the pulled pairs (each linked before this runs). Writes notes and their links;
	 * returns what to push. `stopped` is checked before each vault write. `warn` reports a vault error, which skips
	 * only that note.
	 */
	async run(pairs: readonly Pairing[], seen: ReadonlyMap<string, TtTask>, lists: ReadonlySet<ID>, stopped: () => boolean, warn: () => void): Promise<NotePush[]> {
		if (!this.deps.enabled()) return [];
		const state = this.store.state;
		const creates: { id: ID; title: string; doc: NoteDoc; checklist: boolean }[] = [];
		const work: { id: ID; link: SyncLink; path: string; tt: TtTask }[] = [];
		/** Links that let go of their note: the task and the note's path (the command checks it is still that path). */
		const detach: { id: ID; path: string | null }[] = [];
		for (const pair of pairs) {
			const t = state.tasks.get(pair.logwellId);
			if (t === undefined || t.recurrence !== null || !lists.has(t.categoryId)) continue;
			const link = state.syncLinks.get(syncLinkId("task", t.id));
			if (link === undefined || link.ttId !== pair.ttId || link.pendingDelete === true || (link.mode ?? "sync") !== "sync") continue;
			const tt = seen.get(pair.ttId);
			if (tt === undefined) continue;
			if (link.noteBySync) {
				// Unlinked without the sync knowing (a hand-edited database): the sync lets go of it.
				if (t.descriptionNote === null) detach.push({ id: t.id, path: null });
				else work.push({ id: t.id, link, path: t.descriptionNote.path, tt });
			} else if (link.noteBase === undefined && t.descriptionNote === null) {
				const doc = docFromTickTick(tt);
				if (!isEmptyDoc(doc)) creates.push({ id: t.id, title: t.title, doc, checklist: isChecklist(tt) });
			}
		}

		const port = this.deps.port;
		const pushes: NotePush[] = [];
		/** Links whose base becomes TickTick's text now (the note was written, or both sides made the same change). */
		const rebased: { id: ID; base: StoredNoteBase }[] = [];
		for (const w of work) {
			if (stopped()) break;
			try {
				const checklist = isChecklist(w.tt);
				const gone = this.gone.get(w.id);
				const mtime = port.modifiedAt(w.path);
				if (mtime === null) {
					// Renamed while the sync ran: the link follows it, the next sync reads it there.
					if (!ownsNote(this.store, w.id, w.path)) continue;
					// Deleted (or moved out of the vault): the sync stops writing it and never makes it again.
					detach.push({ id: w.id, path: w.path });
					this.forget(w.id);
					continue;
				}
				this.gone.delete(w.id);
				if (gone !== undefined && gone.path === w.path && gone.late) {
					// Another file now has its path: never taken over.
					detach.push({ id: w.id, path: w.path });
					this.forget(w.id);
					continue;
				}
				let note = this.seen.get(w.id);
				if (note === undefined || note.path !== w.path || note.mtime !== mtime || note.checklist !== checklist) {
					const text = note !== undefined && note.path === w.path && note.mtime === mtime ? note.text : await fromVault(() => port.read(w.path));
					if (text === null) {
						if (ownsNote(this.store, w.id, w.path)) detach.push({ id: w.id, path: w.path });
						this.forget(w.id);
						continue;
					}
					note = this.remember(w.id, w.path, mtime, text, checklist);
				}
				const theirs = docFromTickTick(w.tt);
				const base = baseDoc(w.link, checklist);
				if (sameDoc(theirs, base) && sameDoc(note.ours, base)) {
					// The kind changed and nothing else: the base is stored as the new kind.
					if ((w.link.noteItems !== undefined) !== checklist) rebased.push({ id: w.id, base: storedBase(theirs, checklist) });
					continue;
				}
				const merged = mergeDocs(base, note.ours, theirs);
				if (!sameDoc(note.ours, merged)) {
					const next = writeNote(note.text, checklist, merged);
					if (stopped()) break;
					// The user may have unlinked the note, or linked another, while the sync read it.
					if (!ownsNote(this.store, w.id, w.path)) continue;
					if (!(await fromVault(() => port.replaceText(w.path, note.text, next)))) {
						// Edited since it was read: kept as it is, merged by the next sync.
						this.forget(w.id);
						continue;
					}
					this.remember(w.id, w.path, port.modifiedAt(w.path), next, checklist);
					rebased.push({ id: w.id, base: storedBase(theirs, checklist) });
				} else if (sameDoc(merged, theirs)) {
					// Both sides made the same change.
					rebased.push({ id: w.id, base: storedBase(theirs, checklist) });
				}
				if (!sameDoc(merged, theirs)) pushes.push({ logwellId: w.id, ttId: w.tt.id, doc: merged, pulled: theirs, checklist, path: w.path });
			} catch (err) {
				if (!isVaultError(err)) throw err;
				console.debug("Logwell: a TickTick description note could not be synced.", err.message);
				this.forget(w.id);
				warn();
			}
		}

		if (detach.length > 0 || rebased.length > 0) {
			await this.store.run(
				this.labels.links,
				(tx) => {
					for (const d of detach) {
						// A rename applied meanwhile moved the link: not a deletion.
						if ((tx.get("tasks", d.id)?.descriptionNote?.path ?? null) !== d.path) continue;
						this.putNote(tx, d.id, (l) => ({ ...withoutItems(l), noteBySync: false, noteBase: "" }));
					}
					for (const r of rebased) this.putNote(tx, r.id, (l) => ({ ...withoutItems(l), ...r.base }));
				},
				{ undoable: false },
			);
		}

		if (creates.length > 0 && this.store.readOnlyState === null) {
			const made: { id: ID; path: string; base: StoredNoteBase }[] = [];
			for (const c of creates) {
				if (stopped()) break;
				try {
					const content = writeNote("", c.checklist, c.doc);
					let path = this.made.get(c.id);
					if (path !== undefined && !port.exists(path)) path = undefined;
					if (path === undefined) {
						path = await fromVault(() => port.createNote(this.deps.folder(), sanitizeNoteName(c.title), content));
						this.made.set(c.id, path);
						this.remember(c.id, path, port.modifiedAt(path), content, c.checklist);
					}
					made.push({ id: c.id, path, base: storedBase(c.doc, c.checklist) });
				} catch (err) {
					if (!isVaultError(err)) throw err;
					console.debug("Logwell: a TickTick description note could not be created.", err.message);
					warn();
				}
			}
			if (made.length > 0) {
				await this.store.run(
					this.labels.content,
					(tx) => {
						for (const m of made) {
							const t = tx.get("tasks", m.id);
							const link = tx.get("syncLinks", syncLinkId("task", m.id));
							// The user linked a note meanwhile, or the task is gone: the made note stays as it is, unlinked.
							if (t === undefined || t.descriptionNote !== null || link === undefined || link.noteBySync || link.noteBase !== undefined) continue;
							this.tasks.linkNoteIn(tx, m.id, m.path);
							tx.put("syncLinks", { ...withoutItems(link), noteBySync: true, ...m.base, modifiedAt: tx.now });
						}
					},
					{ undoable: false },
				);
				for (const m of made) this.made.delete(m.id);
			}
		}
		return pushes;
	}

	/** Rewrites the note fields of a link that still says the sync owns its note. */
	private putNote(tx: Tx, id: ID, next: (link: SyncLink) => SyncLink): void {
		const link = tx.get("syncLinks", syncLinkId("task", id));
		if (link === undefined || !link.noteBySync) return;
		tx.put("syncLinks", { ...next(link), modifiedAt: tx.now });
	}
}
