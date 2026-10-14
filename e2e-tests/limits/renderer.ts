// The renderer side of the limits harness: plain JavaScript, installed into Obsidian's window with
// `browser.execute(RENDERER_SRC)` and called as `window.__limits.<method>(...)`. It is a string on purpose: the
// e2e runner's TypeScript transform must not touch code that runs in another process, and every timing here is
// taken with `performance.now()` in the renderer, so WebDriver round trips never count.
//
// Rules shared by every step:
//  - the clock starts right before the action (a click, or `setActiveDatabase`);
//  - it stops two animation frames after the expected DOM has appeared, so the layout and the first paint of the
//    render are inside the time (the first frame callback runs before that frame is painted, the second after);
//  - a step waits at most `timeoutMs`, then throws (the harness calls that row broke).
// The two-frame wait is a floor of roughly 17-33 ms on every step. Query helpers only see the visible app view,
// because background tabs keep hidden copies.

export const RENDERER_SRC = `
const L = { rafFallbacks: 0 };
const frame = () => new Promise((resolve) => {
	let done = false;
	const finish = () => { if (!done) { done = true; resolve(); } };
	requestAnimationFrame(finish);
	// A window that is hidden stops animation frames; do not hang on it, but count it so the result is flagged.
	setTimeout(() => { if (!done) { L.rafFallbacks++; finish(); } }, 1000);
});
const frames = async (n) => { for (let i = 0; i < n; i++) await frame(); };
const shown = (el) => el !== null && el !== undefined && el.getClientRects().length > 0;
const appRoot = () => Array.from(document.querySelectorAll(".cp-app")).find(shown) || null;
const q = (sel) => {
	const root = appRoot();
	return root === null ? null : Array.from(root.querySelectorAll(sel)).find(shown) || null;
};
const textOf = (el) => (el === null ? null : (el.textContent || "").trim());
const waitFor = async (cond, timeoutMs, what) => {
	const start = performance.now();
	for (;;) {
		let ok = false;
		try { ok = !!cond(); } catch (e) { ok = false; }
		if (ok) return;
		if (performance.now() - start > timeoutMs) throw new Error("timed out after " + Math.round(performance.now() - start) + " ms waiting for " + what);
		await frame();
	}
};
const timed = async (what, timeoutMs, action, cond) => {
	const t0 = performance.now();
	action();
	// Preact re-renders in a microtask after the click handler.
	await Promise.resolve();
	await Promise.resolve();
	await waitFor(cond, timeoutMs, what);
	await frames(2);
	return performance.now() - t0;
};
const need = (el, what) => { if (el === null || el === undefined) throw new Error("not found: " + what); return el; };
const plugin = () => window.app.plugins.plugins.logwell;

const RAIL_ROOT = { Tasks: ".cp-tasks", Calendar: ".cp-calendar", Habits: ".cp-habits", Focus: ".cp-focus", Matrix: ".cp-matrix" };

window.__limits = {
	/** Closes the database and the app tabs, so memory does not pile up between rows. */
	async cleanup() {
		const p = plugin();
		window.app.workspace.detachLeavesOfType("checkpoint-app");
		await p.setActiveDatabase("");
		return true;
	},

	async prepareWindow() {
		window.app.workspace.leftSplit.collapse();
		window.app.workspace.rightSplit.collapse();
		let how = "none";
		try {
			window.require("@electron/remote").getCurrentWindow().setSize(1400, 900);
			how = "electron remote";
		} catch (e) {
			how = "unavailable: " + String(e && e.message ? e.message : e);
		}
		return how;
	},

	size() {
		return { w: window.innerWidth, h: window.innerHeight };
	},

	async fileIndexed(path, timeoutMs) {
		const start = performance.now();
		while (window.app.vault.getFileByPath(path) === null) {
			if (performance.now() - start > timeoutMs) throw new Error("Obsidian did not index " + path);
			await new Promise((r) => setTimeout(r, 50));
		}
		return true;
	},

	/** open_ms: setActiveDatabase until ready() and the first rendered Today view with its rail. */
	async open(path, timeoutMs) {
		const p = plugin();
		L.rafFallbacks = 0;
		const t0 = performance.now();
		await p.setActiveDatabase(path);
		const session = await p.ready();
		if (session === null || session === undefined) throw new Error("no session after ready()");
		const readyMs = performance.now() - t0;
		await p.openApp("today");
		await waitFor(
			() => q(".cp-rail") !== null && textOf(q(".cp-tasks .cp-main-title")) === "Today" && q(".cp-task-list") !== null,
			timeoutMs,
			"the first rendered view",
		);
		await frames(2);
		const ms = performance.now() - t0;
		const store = session.app.store;
		return {
			ms,
			readyMs,
			tasks: store.state.tasks.size,
			readOnly: store.readOnlyState !== null,
			rafFallbacks: L.rafFallbacks,
		};
	},

	/** save_ms: complete tasks through the app service and wait until the file write is done. */
	async save(ids, timeoutMs) {
		const session = plugin().session;
		const times = [];
		for (const id of ids) {
			const t0 = performance.now();
			const r = await session.app.tasks.complete(id);
			if (r.kind !== "done") throw new Error("complete did not finish: " + r.kind);
			// flush() resolving is not enough: the write may have failed and been re-queued (isDirty).
			for (let tries = 0; session.store.isDirty; tries++) {
				if (performance.now() - t0 > timeoutMs || tries > 20) throw new Error("the save did not reach the file");
				await session.store.flush();
			}
			if (session.store.readOnlyState !== null) throw new Error("the store went read-only");
			times.push(performance.now() - t0);
		}
		return times;
	},

	/** One timed view step. kind: sidebar | mode | rail | cal | select | popoverOpen | popover. */
	async step(kind, arg, timeoutMs) {
		L.rafFallbacks = 0;
		let ms;
		switch (kind) {
			case "sidebar": {
				const btn = need(
					Array.from(appRoot().querySelectorAll(".cp-sidebar .cp-sidebar-item")).find((b) => textOf(b.querySelector(".cp-sidebar-label")) === arg),
					"sidebar item " + arg,
				);
				ms = await timed("view " + arg, timeoutMs, () => btn.click(), () =>
					textOf(q(".cp-tasks .cp-main-title")) === arg && (q(".cp-task-list") !== null || q(".cp-board") !== null));
				break;
			}
			case "mode": {
				const btn = need(Array.from(appRoot().querySelectorAll(".cp-mode-button")).find((b) => textOf(b) === arg), "mode button " + arg);
				ms = await timed("mode " + arg, timeoutMs, () => btn.click(), () =>
					btn.getAttribute("aria-pressed") === "true" && (arg === "Board" ? q(".cp-board") !== null : q(".cp-task-list") !== null));
				break;
			}
			case "rail": {
				const btn = need(appRoot().querySelector('.cp-rail button[aria-label="' + arg + '"]'), "rail button " + arg);
				const root = need(RAIL_ROOT[arg], "root of " + arg);
				ms = await timed("section " + arg, timeoutMs, () => btn.click(), () => q(root) !== null);
				break;
			}
			case "cal": {
				const btn = need(Array.from(appRoot().querySelectorAll(".cp-cal-mode-btn")).find((b) => textOf(b) === arg), "calendar mode " + arg);
				ms = await timed("calendar " + arg, timeoutMs, () => btn.click(), () =>
					btn.getAttribute("aria-pressed") === "true" && q(arg === "Month" ? ".cp-cal-month" : ".cp-cal-week") !== null);
				break;
			}
			case "select": {
				const row = need(
					Array.from(appRoot().querySelectorAll('.cp-task-row[data-task-id="' + arg + '"]')).find(shown) || null,
					"task row " + arg,
				);
				ms = await timed("details of " + arg, timeoutMs, () => row.click(), () =>
					q('.cp-task-row.is-selected[data-task-id="' + arg + '"]') !== null && q(".cp-details-pane .cp-details:not(.cp-empty-state)") !== null);
				break;
			}
			case "popoverOpen": {
				const btn = need(q('.cp-qa-tool[data-tool="more"]'), "the add bar more button");
				ms = await timed("more popover", timeoutMs, () => btn.click(), () => q(".cp-more-pop") !== null);
				break;
			}
			case "popover": {
				const row = need(q('.cp-more-pop .cp-pop-row[data-row="' + arg + '"]'), "popover row " + arg);
				ms = await timed("popover " + arg, timeoutMs, () => row.click(), () => q(".cp-more-pop .cp-pop-choices") !== null);
				break;
			}
			default:
				throw new Error("unknown step " + kind);
		}
		return { ms, rafFallbacks: L.rafFallbacks };
	},
};
return true;
`;
