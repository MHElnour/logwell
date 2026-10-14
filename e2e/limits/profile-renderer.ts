// The renderer side of the profiling spec (profile.e2e.ts): plain JavaScript installed into Obsidian's window with
// `browser.execute(PROFILE_SRC)` and called as `window.__prof.<method>(...)`. Like renderer.ts it is a string, so the
// e2e runner's TypeScript transform does not touch code that runs in another process.
//
// It does two things for one phase (open, save, view):
//  1. a V8 CPU profile of the renderer, 100 us sampling. Obsidian's renderer has no node `inspector` ("initialized
//     without a V8::Inspector"), so the spec attaches a CDP Profiler session from the WebDriver side and this code
//     starts and stops the profile with console.profile()/console.profileEnd(), which delivers the profile to that
//     session as Profiler.consoleProfileFinished, with the window starting and ending inside the renderer;
//  2. manual spans and marks. The live instances and the prototypes of the classes the session built are wrapped
//     (the source is untouched): each wrapped call records start and end with performance.now().
//
// Nothing is wrapped before `warmup()` has opened a small database once: the session, store, services, gateways and
// view only exist as objects then, and their prototypes are what the wraps patch.

export const PROFILE_SRC = `
const P = {
	mode: "none", // "console": console.profile() here; "outer": the spec starts and stops the profile around the call; "none"
	recording: false,
	spans: [],
	marks: [],
	longtasks: [],
	updates: [],
	wrapped: [],
	modifyRef: null,
	updateHook: "not installed",
	po: null,
	t0: 0,
};
const now = () => performance.now();
const span = (n, s, e, extra) => { if (P.recording) P.spans.push(extra === undefined ? { n, s, e } : { n, s, e, x: extra }); };
const mark = (n) => { if (P.recording) P.marks.push({ n, t: now() }); };
const plugin = () => window.app.plugins.plugins.logwell;
const frame = () => new Promise((resolve) => {
	let done = false;
	const finish = () => { if (!done) { done = true; resolve(); } };
	requestAnimationFrame(finish);
	setTimeout(finish, 1000);
});
const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };
const shown = (el) => el !== null && el !== undefined && el.getClientRects().length > 0;
const appRoot = () => Array.from(document.querySelectorAll(".cp-app")).find(shown) || null;
const q = (sel) => {
	const root = appRoot();
	return root === null ? null : Array.from(root.querySelectorAll(sel)).find(shown) || null;
};
const textOf = (el) => (el === null ? null : (el.textContent || "").trim());
// waitFor polls once per animation frame. Each condition check is timed: it reads layout (getClientRects), so the
// span shows how much forced layout and style recalculation the check pulled in.
const waitFor = async (cond, timeoutMs, what) => {
	const start = now();
	for (;;) {
		let ok = false;
		const s = now();
		try { ok = !!cond(); } catch (e) { ok = false; }
		span("poll: condition check (forces layout)", s, now());
		if (ok) return;
		if (now() - start > timeoutMs) throw new Error("timed out after " + Math.round(now() - start) + " ms waiting for " + what);
		await frame();
	}
};

// -- wrapping --------------------------------------------------------------------------------------------------------

/** Wraps obj[key] (own or inherited) so each call is recorded as a span. Idempotent. label may be a function of the arguments. */
function wrapFn(obj, key, label) {
	const orig = obj[key];
	if (typeof orig !== "function" || orig.__prof === true) return false;
	const w = function (...args) {
		const name = typeof label === "function" ? label(args) : label;
		const s = now();
		let r;
		try { r = orig.apply(this, args); } catch (e) { span(name, s, now()); throw e; }
		if (r !== null && r !== undefined && typeof r.then === "function") {
			return r.then((v) => { span(name, s, now()); return v; }, (e) => { span(name, s, now()); throw e; });
		}
		span(name, s, now());
		return r;
	};
	w.__prof = true;
	obj[key] = w;
	P.wrapped.push(label === undefined ? key : typeof label === "string" ? label : key);
	return true;
}
const wrapAll = (obj, names, prefix) => { for (const k of names) wrapFn(obj, k, prefix + k); };

/**
 * Counts and locates component updates: wraps Component.prototype.setState and forceUpdate (reached through a mounted
 * component instance; the hooks' state setters call setState). Records when, which kind, and the top of the call stack.
 */
function wrapComponentUpdates(view) {
	const rootEl = view && view.contentEl ? view.contentEl.querySelector(".checkpoint-root") : null;
	if (!rootEl) return "no root element";
	let found = null;
	const seen = new Set();
	const visit = (vnode, depth) => {
		if (found !== null || !vnode || typeof vnode !== "object" || seen.has(vnode) || depth > 60) return;
		seen.add(vnode);
		if (vnode.__c) { found = vnode.__c; return; }
		const kids = vnode.__k;
		if (Array.isArray(kids)) for (const k of kids) visit(k, depth + 1);
	};
	visit(rootEl.__k && !Array.isArray(rootEl.__k) ? rootEl.__k : { __k: rootEl.__k }, 0);
	if (found === null) return "no component found (property names differ?)";
	const proto = Object.getPrototypeOf(found);
	for (const kind of ["setState", "forceUpdate"]) {
		const orig = proto[kind];
		if (typeof orig !== "function" || orig.__upd === true) continue;
		const w = function (...args) {
			if (P.recording && P.updates.length < 400) {
				const stack = String(new Error().stack || "").split("\\n").slice(2, 9).map((l) => l.trim());
				P.updates.push({ t: now(), kind, comp: this && this.constructor && this.constructor.name, stack });
			}
			return orig.apply(this, args);
		};
		w.__upd = true;
		proto[kind] = w;
	}
	return "ok";
}

function installWraps(session, view) {
	const store = session.store;
	const app = session.app;
	const vault = window.app.vault;
	const p = plugin();
	// plugin entry points (instance properties shadow the prototype methods)
	wrapAll(p, ["setActiveDatabase", "ready", "openApp"], "plugin.");
	wrapAll(Object.getPrototypeOf(session), ["open"], "session.");
	// persistence
	wrapAll(Object.getPrototypeOf(store), ["open", "openNow", "saveNow", "snapshotIfDue", "applyExternal", "handleExternalChange", "handleExternalNow", "flush", "commit", "serialize", "replaceData"], "store.");
	wrapFn(Object.getPrototypeOf(store), "emit", (a) => "store.emit:" + (a[0] && a[0].type));
	wrapAll(Object.getPrototypeOf(store.deps.file), ["read", "write"], "dbfile.");
	wrapAll(Object.getPrototypeOf(store.deps.local), ["setLastWritten", "getLastWritten"], "local.");
	if (store.backups !== null && store.backups !== undefined) {
		const b = store.backups;
		wrapAll(Object.getPrototypeOf(b), ["writeSnapshot", "appendJournal", "resetJournal", "readJournal", "listSnapshots", "hasDailySnapshot", "prune", "headerOf"], "backups.");
		wrapAll(Object.getPrototypeOf(b.fs), ["read", "write", "append", "exists", "list", "remove", "mkdir"], "adapter.");
	}
	// Obsidian's own file API (live instances)
	wrapAll(vault.adapter, ["read", "write", "append", "exists", "list", "mkdir", "remove", "rmdir", "stat"], "obs.adapter.");
	wrapAll(vault, ["read", "cachedRead"], "obs.vault.");
	if (!vault.process.__prof) {
		const orig = vault.process;
		const w = function (file, fn, opts) {
			const s = now();
			const inner = (data) => {
				const cs = now();
				try { return fn(data); } finally { span("obs.vault.process: our callback (compare)", cs, now(), data.length); }
			};
			return orig.call(this, file, inner, opts).then((v) => { span("obs.vault.process (total)", s, now()); return v; }, (e) => { span("obs.vault.process (total)", s, now()); throw e; });
		};
		w.__prof = true;
		vault.process = w;
	}
	wrapAll(window.app, ["saveLocalStorage"], "obs.app.");
	// event bus, services, view
	const busProto = Object.getPrototypeOf(app.store.bus);
	wrapFn(busProto, "emit", (a) => "bus.emit:" + a[0]);
	if (busProto.emit.__chg !== true) {
		const inner = busProto.emit;
		const w = function (ev, payload) {
			const r = inner.call(this, ev, payload);
			if (P.recording && ev === "changed") onChangedEmitted();
			return r;
		};
		w.__chg = true;
		w.__prof = true;
		busProto.emit = w;
	}
	wrapAll(Object.getPrototypeOf(app.tasks), ["complete", "purgeExpired"], "tasks.");
	wrapAll(Object.getPrototypeOf(app.noteRenames), ["resumeRenames", "flushRenames"], "noteRenames.");
	wrapAll(Object.getPrototypeOf(app.recurrence), ["endExhaustedSeries"], "recurrence.");
	wrapAll(Object.getPrototypeOf(app.focus), ["open"], "focus.");
	wrapAll(Object.getPrototypeOf(app.store), ["run"], "appstore.");
	if (view !== null && view !== undefined) wrapAll(Object.getPrototypeOf(view), ["renderApp"], "view.");
	P.updateHook = wrapComponentUpdates(view);
	return P.wrapped.length;
}

// After "changed", the Preact re-render is queued as a microtask by the listeners. A microtask queued right after
// the emit therefore runs after the diff: its mark closes the render (JS) part; the two frames after it are layout and paint.
function onChangedEmitted() {
	mark("changed: listeners returned");
	Promise.resolve().then(() => {
		mark("changed: render microtasks done");
		requestAnimationFrame(() => { mark("changed: frame 1"); requestAnimationFrame(() => mark("changed: frame 2")); });
	});
}

// -- phases -----------------------------------------------------------------------------------------------------------

async function begin(name, profile) {
	P.spans = [];
	P.marks = [];
	P.longtasks = [];
	P.updates = [];
	P.recording = false;
	try {
		P.po = new PerformanceObserver((list) => { for (const e of list.getEntries()) P.longtasks.push({ s: e.startTime, d: e.duration }); });
		P.po.observe({ entryTypes: ["longtask"] });
	} catch (e) { P.po = null; }
	if (P.modifyRef === null) P.modifyRef = window.app.vault.on("modify", (f) => { if (f.path.endsWith(".cpbase")) mark("obsidian vault 'modify' event: " + f.path); });
	const heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
	if (profile && P.mode === "console") console.profile(name);
	P.recording = true;
	P.t0 = now();
	return heap0;
}

async function end(name, dir, profile, heap0, extra) {
	const t1 = now();
	P.recording = false;
	if (profile && P.mode === "console") console.profileEnd(name);
	if (P.po !== null) { for (const e of P.po.takeRecords()) P.longtasks.push({ s: e.startTime, d: e.duration }); P.po.disconnect(); P.po = null; }
	const out = {
		name,
		profiled: profile && P.mode === "console",
		t0: P.t0,
		t1,
		heapBefore: heap0,
		heapAfter: performance.memory ? performance.memory.usedJSHeapSize : 0,
		domNodes: document.querySelectorAll("*").length,
		taskRows: document.querySelectorAll(".cp-app .cp-task-row").length,
		updates: P.updates,
		spans: P.spans,
		marks: P.marks,
		longtasks: P.longtasks,
		...extra,
	};
	window.require("fs").writeFileSync(dir + "/" + name + ".manual.json", JSON.stringify(out));
	return { totalMs: t1 - P.t0, marks: P.marks.map((m) => ({ n: m.n, ms: m.t - P.t0 })), spanCount: P.spans.length, longtasks: P.longtasks.length };
}

window.__prof = {
	setMode(mode) { P.mode = mode; return mode; },

	/** Opens a small database once so the session objects exist, wraps their prototypes, and closes it again. */
	async warmup(path, timeoutMs) {
		const p = plugin();
		await p.setActiveDatabase(path);
		const session = await p.ready();
		if (session === null || session === undefined) throw new Error("no session after ready()");
		await p.openApp("today");
		await waitFor(() => q(".cp-rail") !== null && q(".cp-task-list") !== null, timeoutMs, "the warm-up view");
		await frames(2);
		const leaf = window.app.workspace.getLeavesOfType("checkpoint-app")[0];
		const count = installWraps(session, leaf ? leaf.view : null);
		window.app.workspace.detachLeavesOfType("checkpoint-app");
		await p.setActiveDatabase("");
		await frames(2);
		return { wraps: count, updateHook: P.updateHook };
	},

	async cleanup() {
		window.app.workspace.detachLeavesOfType("checkpoint-app");
		await plugin().setActiveDatabase("");
		if (P.modifyRef !== null) { window.app.vault.offref(P.modifyRef); P.modifyRef = null; }
		return true;
	},

	/** open: setActiveDatabase, ready, openApp("today"), first rendered Today view with its rail, two frames. */
	async open(name, path, dir, profile, timeoutMs) {
		const p = plugin();
		const heap0 = await begin(name, profile);
		const t0 = P.t0;
		// A cheap structural check on every DOM mutation batch finds when the view appeared, without forcing layout.
		let domMarked = false;
		const mo = new MutationObserver(() => {
			if (domMarked) return;
			const title = document.querySelector(".cp-app .cp-tasks .cp-main-title");
			if (title && (title.textContent || "").trim() === "Today" && document.querySelector(".cp-app .cp-task-list")) {
				domMarked = true;
				mark("DOM has the Today view (mutation observer)");
				requestAnimationFrame(() => { mark("open: frame 1 after DOM"); requestAnimationFrame(() => mark("open: frame 2 after DOM")); });
			}
		});
		mo.observe(document.body, { childList: true, subtree: true, characterData: true });
		await p.setActiveDatabase(path);
		mark("setActiveDatabase resolved");
		const session = await p.ready();
		if (session === null || session === undefined) throw new Error("no session after ready()");
		mark("ready resolved");
		await p.openApp("today");
		mark("openApp resolved");
		await waitFor(() => q(".cp-rail") !== null && textOf(q(".cp-tasks .cp-main-title")) === "Today" && q(".cp-task-list") !== null, timeoutMs, "the first rendered view");
		mark("poll: view found (visible)");
		await frames(2);
		mark("two frames after poll");
		const total = now() - t0;
		mo.disconnect();
		const store = session.app.store;
		const extra = { tasks: store.state.tasks.size, readOnly: store.readOnlyState !== null, isDirty: session.store.isDirty };
		const r = await end(name, dir, profile, heap0, extra);
		return { ...r, measuredMs: total, ...extra };
	},

	/** save: complete one task through the app service, flush until isDirty is false (the harness definition). */
	async save(name, id, dir, profile, timeoutMs) {
		const session = plugin().session;
		const heap0 = await begin(name, profile);
		const t0 = P.t0;
		const res = await session.app.tasks.complete(id);
		if (res.kind !== "done") throw new Error("complete did not finish: " + res.kind);
		mark("complete() resolved");
		for (let tries = 0; session.store.isDirty; tries++) {
			if (now() - t0 > timeoutMs || tries > 20) throw new Error("the save did not reach the file");
			await session.store.flush();
			mark("flush() resolved");
		}
		mark("isDirty false (the save-time definition)");
		const measured = now() - t0;
		await frames(2);
		mark("two frames after the save");
		const r = await end(name, dir, profile, heap0, { taskId: id });
		return { ...r, measuredMs: measured };
	},

	/** view: click a sidebar item, wait for its title and list, then two frames (the harness definition). */
	async view(name, label, dir, profile, timeoutMs) {
		const btn = Array.from(appRoot().querySelectorAll(".cp-sidebar .cp-sidebar-item")).find((b) => textOf(b.querySelector(".cp-sidebar-label")) === label);
		if (!btn) throw new Error("sidebar item not found: " + label);
		const heap0 = await begin(name, profile);
		const t0 = P.t0;
		let domMarked = false;
		const mo = new MutationObserver(() => {
			if (domMarked) return;
			const title = document.querySelector(".cp-app .cp-tasks .cp-main-title");
			if (title && (title.textContent || "").trim() === label && document.querySelector(".cp-app .cp-task-list")) { domMarked = true; mark("DOM shows " + label + " (mutation observer)"); }
		});
		mo.observe(document.body, { childList: true, subtree: true, characterData: true });
		const cs = now();
		btn.click();
		span("click handler (sync)", cs, now());
		mark("click returned");
		await Promise.resolve();
		mark("microtask 1");
		await Promise.resolve();
		mark("microtask 2");
		requestAnimationFrame(() => { mark("view: frame 1 after click"); requestAnimationFrame(() => mark("view: frame 2 after click")); });
		await waitFor(() => textOf(q(".cp-tasks .cp-main-title")) === label && (q(".cp-task-list") !== null || q(".cp-board") !== null), timeoutMs, "view " + label);
		mark("poll: view found (visible)");
		await frames(2);
		mark("two frames after poll");
		const measured = now() - t0;
		mo.disconnect();
		const rows = document.querySelectorAll(".cp-app .cp-task-row").length;
		const r = await end(name, dir, profile, heap0, { label, rows });
		return { ...r, measuredMs: measured, rows };
	},

	/** Reference timings of pure calls on the live store: serialize (warm cache), string equality. */
	reference() {
		const s = plugin().session.store;
		const out = {};
		let t = now();
		const text = s.serialize();
		out.serializeMs = now() - t;
		t = now();
		const text2 = s.serialize();
		out.serializeAgainMs = now() - t;
		t = now();
		out.equal = text === text2;
		out.compareMs = now() - t;
		out.chars = text.length;
		t = now();
		JSON.parse(text);
		out.jsonParseMs = now() - t;
		return out;
	},

	async dbState() {
		const s = plugin().session;
		return { dirty: s.store.isDirty, readOnly: s.store.readOnlyState !== null, tasks: s.app.store.state.tasks.size };
	},
};
return true;
`;
