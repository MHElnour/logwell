import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SourceMap } from "node:module";
import { fileURLToPath } from "node:url";

// Turns the files profile.e2e.ts wrote into tables: .notes/limits/profiles/<phase>.cpuprofile and <phase>.manual.json.
//
//   npx tsx e2e/limits/profile-report.ts [phase ...]
//
// Needs main.js and main.js.map of the SAME unminified build the profile was taken with
// (LOGWELL_PROFILE_BUILD=1 node esbuild.config.mjs production), to name functions by their src file and line.
// Prints to stdout and writes .notes/limits/profiles/report.txt.

const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = `${root}.notes/limits/profiles`;
const ORDER = ["open", "open-plain", "save", "save-plain", "view-inbox", "view-upcoming", "view-today-plain", "view-inbox-plain", "view-upcoming-plain"];

interface CallFrame {
	functionName: string;
	scriptId: string;
	url: string;
	lineNumber: number;
	columnNumber: number;
}
interface ProfileNode {
	id: number;
	callFrame: CallFrame;
	children?: number[];
}
interface Profile {
	nodes: ProfileNode[];
	startTime: number;
	endTime: number;
	samples: number[];
	timeDeltas: number[];
}
interface Manual {
	name: string;
	profiled: boolean;
	t0: number;
	t1: number;
	heapBefore: number;
	heapAfter: number;
	spans: { n: string; s: number; e: number; x?: number }[];
	marks: { n: string; t: number }[];
	longtasks: { s: number; d: number }[];
	updates?: { t: number; kind: string; comp?: string; stack: string[] }[];
	domNodes?: number;
	taskRows?: number;
	[k: string]: unknown;
}

// -- source mapping ----------------------------------------------------------------------------------------------------

const mainJs = existsSync(`${root}main.js`) ? readFileSync(`${root}main.js`, "utf8").split("\n") : [];
const sourceMap = existsSync(`${root}main.js.map`) ? new SourceMap(JSON.parse(readFileSync(`${root}main.js.map`, "utf8"))) : null;

interface Calibration {
	scriptId: string;
	url: string;
	offset: number;
	matched: number;
	tried: number;
}

/** Finds which script is our bundle and how many lines the loader added before it (new Function adds 2). */
function calibrate(profiles: Profile[]): Calibration | null {
	if (mainJs.length === 0) return null;
	const byUrl = new Map<string, Map<number, number>>(); // scriptId -> offset -> matches
	const tried = new Map<string, number>();
	const urlOf = new Map<string, string>();
	for (const profile of profiles) {
		for (const n of profile.nodes) {
			const cf = n.callFrame;
			if (cf.functionName === "" || cf.functionName.startsWith("(")) continue;
			if (cf.url !== "") urlOf.set(cf.scriptId, cf.url);
			tried.set(cf.scriptId, (tried.get(cf.scriptId) ?? 0) + 1);
			for (let off = 0; off <= 4; off++) {
				const line = mainJs[cf.lineNumber - off];
				if (line !== undefined && line.includes(cf.functionName)) {
					const m = byUrl.get(cf.scriptId) ?? new Map<number, number>();
					m.set(off, (m.get(off) ?? 0) + 1);
					byUrl.set(cf.scriptId, m);
				}
			}
		}
	}
	let best: Calibration | null = null;
	for (const [scriptId, offsets] of byUrl) {
		for (const [offset, matched] of offsets) {
			if (best === null || matched > best.matched) best = { scriptId, url: urlOf.get(scriptId) ?? "(no url)", offset, matched, tried: tried.get(scriptId) ?? 0 };
		}
	}
	return best;
}

const fnKey = (cf: CallFrame): string => `${cf.functionName}|${cf.scriptId}|${cf.lineNumber}|${cf.columnNumber}`;

const srcCache = new Map<string, string[]>();
/** Library bundles are minified (preact's `O`, `I`, `q`): read the real function name from the source line the map points at. */
function unmangled(src: string, line: number, fallback: string): string {
	let lines = srcCache.get(src);
	if (lines === undefined) {
		const path = `${root}${src}`;
		lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
		srcCache.set(src, lines);
	}
	const text = lines[line - 1] ?? "";
	const m = /function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(text) ?? /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function|\()/.exec(text);
	return m?.[1] !== undefined ? `${m[1]} [${fallback}]` : fallback;
}

interface Resolved {
	name: string;
	where: string;
	category: string;
}

function categoryOf(source: string): string {
	const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(source);
	if (nm !== null) return `lib: ${nm[1]}`;
	const seg = source.split("/");
	return seg[0] === "src" && seg.length > 2 ? `src/${seg[1]}` : seg[0] === "src" ? "src" : source;
}

function makeResolver(cal: Calibration | null): (cf: CallFrame) => Resolved {
	const cache = new Map<string, Resolved>();
	return (cf) => {
		const key = fnKey(cf);
		const hit = cache.get(key);
		if (hit !== undefined) return hit;
		let r: Resolved;
		const fn = cf.functionName === "" ? "(anonymous)" : cf.functionName;
		if (cf.functionName.startsWith("(")) {
			r = { name: cf.functionName, where: "", category: `native: ${cf.functionName}` };
		} else if (cal !== null && cf.scriptId === cal.scriptId && sourceMap !== null) {
			const e = sourceMap.findEntry(Math.max(0, cf.lineNumber - cal.offset), cf.columnNumber) as { originalSource?: string; originalLine?: number };
			const src = typeof e.originalSource === "string" ? e.originalSource.replace(/^(\.\.\/)+/, "") : "(bundle glue)";
			const line = (e.originalLine ?? 0) + 1;
			r = { name: fn.length <= 2 ? unmangled(src, line, fn) : fn, where: `${src}:${line}`, category: categoryOf(src) };
		} else if (cf.url === "") {
			r = { name: fn, where: "(builtin or native)", category: "builtin / native" };
		} else {
			const file = cf.url.replace(/^.*\//, "");
			r = { name: fn, where: `${file}:${cf.lineNumber + 1}`, category: `other script: ${file}` };
		}
		cache.set(key, r);
		return r;
	};
}

// -- profile math --------------------------------------------------------------------------------------------------------

interface Stats {
	windowMs: number;
	idleMs: number;
	programMs: number;
	gcMs: number;
	activeMs: number;
	self: Map<string, number>;
	total: Map<string, number>;
	byCategory: Map<string, number>;
	nodeSelf: Map<number, number>;
	nodeIncl: Map<number, number>;
	parent: Map<number, number>;
	byId: Map<number, ProfileNode>;
	sampleCount: number;
	/** Per sample: start offset in ms from the start of the phase (the profile starts a moment before it), duration, node. */
	at: number[];
	dur: number[];
	node: number[];
}

function analyze(profile: Profile, resolve: (cf: CallFrame) => Resolved): Stats {
	const byId = new Map<number, ProfileNode>();
	const parent = new Map<number, number>();
	for (const n of profile.nodes) byId.set(n.id, n);
	for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
	const nodeSelf = new Map<number, number>();
	const count = profile.samples.length;
	let sum = 0;
	const at: number[] = [];
	const dur: number[] = [];
	const node: number[] = [];
	const lead = profile.timeDeltas[0] ?? 0;
	for (let i = 0; i < count; i++) {
		// DevTools convention: a sample lasts until the next one.
		const d = i + 1 < count ? (profile.timeDeltas[i + 1] ?? 0) : count > 1 ? sum / (count - 1) : 0;
		sum += profile.timeDeltas[i] ?? 0;
		at.push((sum - lead) / 1000);
		dur.push(d / 1000);
		node.push(profile.samples[i] as number);
		const id = profile.samples[i] as number;
		nodeSelf.set(id, (nodeSelf.get(id) ?? 0) + d / 1000);
	}
	const self = new Map<string, number>();
	const total = new Map<string, number>();
	const byCategory = new Map<string, number>();
	const nodeIncl = new Map<number, number>();
	let idleMs = 0;
	let programMs = 0;
	let gcMs = 0;
	let allMs = 0;
	for (const [id, ms] of nodeSelf) {
		const node = byId.get(id);
		if (node === undefined) continue;
		const cf = node.callFrame;
		allMs += ms;
		if (cf.functionName === "(idle)") idleMs += ms;
		if (cf.functionName === "(program)") programMs += ms;
		if (cf.functionName === "(garbage collector)") gcMs += ms;
		const k = fnKey(cf);
		self.set(k, (self.get(k) ?? 0) + ms);
		const cat = resolve(cf).category;
		byCategory.set(cat, (byCategory.get(cat) ?? 0) + ms);
		const seen = new Set<string>();
		for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
			nodeIncl.set(cur, (nodeIncl.get(cur) ?? 0) + ms);
			const n = byId.get(cur);
			if (n === undefined) break;
			const kk = fnKey(n.callFrame);
			if (!seen.has(kk)) {
				seen.add(kk);
				total.set(kk, (total.get(kk) ?? 0) + ms);
			}
		}
	}
	return {
		windowMs: allMs,
		idleMs,
		programMs,
		gcMs,
		activeMs: allMs - idleMs,
		self,
		total,
		byCategory,
		nodeSelf,
		nodeIncl,
		parent,
		byId,
		sampleCount: count,
		at,
		dur,
		node,
	};
}

// -- printing ------------------------------------------------------------------------------------------------------------

const out: string[] = [];
const log = (s = ""): void => {
	out.push(s);
	console.log(s);
};
const f1 = (n: number): string => n.toFixed(1);

function keyToFrame(k: string): CallFrame {
	const [functionName = "", scriptId = "", line = "0", col = "0"] = k.split("|");
	return { functionName, url: "", lineNumber: Number(line), columnNumber: Number(col), scriptId };
}

function topTable(title: string, map: Map<string, number>, n: number, st: Stats, resolve: (cf: CallFrame) => Resolved): void {
	log(`  ${title}`);
	log(`  ${"ms".padStart(8)} ${"% win".padStart(6)}  function   (file:line in src)`);
	const rows = [...map].filter(([k]) => !k.startsWith("(idle)|") && !k.startsWith("(root)|")).sort((a, b) => b[1] - a[1]).slice(0, n);
	for (const [k, ms] of rows) {
		const r = resolve(keyToFrame(k));
		log(`  ${f1(ms).padStart(8)} ${((100 * ms) / st.windowMs).toFixed(1).padStart(5)}%  ${r.name}   ${r.where}`);
	}
}

interface TreeNode {
	frame: CallFrame;
	incl: number;
	self: number;
	/** Self time of the hidden library frames (preact internals) folded into this node. */
	folded: number;
	kids: Map<string, TreeNode>;
}

/**
 * The top-down tree with preact's own frames folded away (they recurse through every component and bury the path):
 * a visible node's children are the visible frames below it, merged by function.
 */
function printTree(st: Stats, resolve: (cf: CallFrame) => Resolved, minPct: number, maxLines: number): void {
	log(`  Top-down (inclusive ms; preact internals folded into the caller; paths of at least ${minPct}% of the window; same function under the same parent = one line)`);
	const hidden = (n: ProfileNode): boolean => resolve(n.callFrame).category === "lib: preact";
	const mk = (frame: CallFrame): TreeNode => ({ frame, incl: 0, self: 0, folded: 0, kids: new Map() });
	const top = mk({ functionName: "(root)", scriptId: "", url: "", lineNumber: 0, columnNumber: 0 });
	const walk = (id: number, into: TreeNode): void => {
		const node = st.byId.get(id);
		if (node === undefined) return;
		const self = st.nodeSelf.get(id) ?? 0;
		let target = into;
		if (hidden(node)) {
			into.folded += self;
		} else {
			const k = fnKey(node.callFrame);
			let t = into.kids.get(k);
			if (t === undefined) {
				t = mk(node.callFrame);
				into.kids.set(k, t);
			}
			t.self += self;
			target = t;
		}
		for (const c of node.children ?? []) walk(c, target);
	};
	for (const n of st.byId.values()) if (!st.parent.has(n.id)) walk(n.id, top);
	// Inclusive time of a merged node = its own self + folded + its kids.
	const fill = (t: TreeNode): number => {
		let sum = t.self + t.folded;
		for (const k of t.kids.values()) sum += fill(k);
		t.incl = sum;
		return sum;
	};
	fill(top);
	let lines = 0;
	log(`  ${"incl".padStart(8)} ${"self".padStart(7)} ${"+preact".padStart(7)}  call path`);
	const print = (t: TreeNode, depth: number): void => {
		if (lines >= maxLines) return;
		if ((100 * t.incl) / st.windowMs < minPct) return;
		const r = resolve(t.frame);
		log(`  ${f1(t.incl).padStart(8)} ${f1(t.self).padStart(7)} ${f1(t.folded).padStart(7)}  ${"  ".repeat(Math.min(depth, 30))}${r.name}  ${r.where}`);
		lines++;
		for (const k of [...t.kids.values()].sort((a, b) => b.incl - a.incl)) print(k, depth + 1);
	};
	print(top, 0);
	if (lines >= maxLines) log("  ... (truncated)");
}

function manualTable(m: Manual): void {
	const agg = new Map<string, { count: number; total: number; max: number; first: number }>();
	for (const s of m.spans) {
		const a = agg.get(s.n) ?? { count: 0, total: 0, max: 0, first: s.s - m.t0 };
		const d = s.e - s.s;
		a.count++;
		a.total += d;
		a.max = Math.max(a.max, d);
		agg.set(s.n, a);
	}
	log(`  Manual spans (inclusive wall ms; spans nest, so rows overlap; sorted by total)`);
	log(`  ${"total".padStart(8)} ${"calls".padStart(6)} ${"max".padStart(8)} ${"first at".padStart(9)}  span`);
	for (const [n, a] of [...agg].sort((x, y) => y[1].total - x[1].total).slice(0, 40)) {
		log(`  ${f1(a.total).padStart(8)} ${String(a.count).padStart(6)} ${f1(a.max).padStart(8)} ${f1(a.first).padStart(9)}  ${n}`);
	}
	log(`  Timeline (marks, and spans of 5 ms or more; offsets in ms from the start of the phase)`);
	const events: { at: number; text: string }[] = [];
	for (const mk of m.marks) events.push({ at: mk.t - m.t0, text: `mark  ${mk.n}` });
	for (const s of m.spans) if (s.e - s.s >= 5) events.push({ at: s.s - m.t0, text: `span  ${s.n}  ${f1(s.s - m.t0)} - ${f1(s.e - m.t0)}  (${f1(s.e - s.s)} ms${s.x !== undefined ? `, ${s.x} chars` : ""})` });
	for (const e of events.sort((a, b) => a.at - b.at).slice(0, 80)) log(`  ${f1(e.at).padStart(8)}  ${e.text}`);
	const lt = m.longtasks.filter((t) => t.d >= 50 && t.s + t.d > m.t0).sort((a, b) => a.s - b.s);
	log(`  Long tasks (50 ms or more, from the renderer's PerformanceObserver): ${lt.length}${lt.length > 0 ? ` -> ${lt.map((t) => `${f1(t.s - m.t0)}+${f1(t.d)}`).join(", ")}` : ""}`);
}

/** Self time between two marks of the phase: what the main thread did in each stretch. */
function segments(st: Stats, m: Manual, resolve: (cf: CallFrame) => Resolved): void {
	const end = st.at.length > 0 ? (st.at[st.at.length - 1] as number) + (st.dur[st.dur.length - 1] as number) : 0;
	const cuts = [0, ...m.marks.map((k) => k.t - m.t0), end].sort((a, b) => a - b);
	const labels = new Map<number, string>();
	for (const k of m.marks) labels.set(Math.round(k.t - m.t0), k.n);
	log("  What the main thread did between marks (stretches of 40 ms or more; self ms by function, GC / program / idle separately)");
	for (let i = 0; i + 1 < cuts.length; i++) {
		const a = cuts[i] as number;
		const b = cuts[i + 1] as number;
		if (b - a < 40) continue;
		const self = new Map<string, number>();
		let idle = 0;
		let program = 0;
		let gc = 0;
		for (let j = 0; j < st.at.length; j++) {
			const t = st.at[j] as number;
			if (t < a || t >= b) continue;
			const cf = (st.byId.get(st.node[j] as number) as ProfileNode).callFrame;
			const d = st.dur[j] as number;
			if (cf.functionName === "(idle)") idle += d;
			else if (cf.functionName === "(program)") program += d;
			else if (cf.functionName === "(garbage collector)") gc += d;
			else self.set(fnKey(cf), (self.get(fnKey(cf)) ?? 0) + d);
		}
		const top = [...self].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([k, ms]) => {
			const r = resolve(keyToFrame(k));
			return `${r.name} ${f1(ms)}`;
		});
		const from = labels.get(Math.round(a)) ?? (a === 0 ? "start" : "?");
		const to = labels.get(Math.round(b)) ?? (b === end ? "end of profile" : "?");
		log(`  ${f1(a).padStart(8)} - ${f1(b).padStart(8)} (${f1(b - a)} ms) after "${from}" until "${to}": idle ${f1(idle)}, program ${f1(program)}, GC ${f1(gc)}; top: ${top.join("; ")}`);
	}
}

/** When did the main thread run inside these functions? Contiguous stretches (gaps under 3 ms are merged). */
function activity(st: Stats, resolve: (cf: CallFrame) => Resolved): void {
	const watch: { label: string; test: (r: Resolved, cf: CallFrame) => boolean }[] = [
		{ label: "Preact render queue (process)", test: (r) => r.where.endsWith("preact/src/component.js:222") },
		{ label: "Preact render() of a root", test: (r) => r.where.endsWith("preact/src/render.js:14") },
		{ label: "buildView", test: (r) => r.name === "buildView" },
		{ label: "sidebarCounts", test: (r) => r.name === "sidebarCounts" },
		{ label: "todayEntries", test: (r) => r.name === "todayEntries" },
		{ label: "TaskRow (row render)", test: (r) => r.name === "TaskRow" },
		{ label: "loadText (parse + validate)", test: (r) => r.name === "loadText" },
		{ label: "serializeDb", test: (r) => r.name === "serializeDb" },
		{ label: "layout-forcing effect (QuickAddEditor)", test: (r) => r.where.includes("QuickAddEditor.tsx:93") },
	];
	const memo = new Map<number, boolean[]>();
	const flags = (id: number): boolean[] => {
		const hit = memo.get(id);
		if (hit !== undefined) return hit;
		const node = st.byId.get(id) as ProfileNode;
		const own = watch.map((w) => w.test(resolve(node.callFrame), node.callFrame));
		const p = st.parent.get(id);
		const up = p === undefined ? watch.map(() => false) : flags(p);
		const all = own.map((o, i) => o || (up[i] as boolean));
		memo.set(id, all);
		return all;
	};
	log("  When the main thread was inside these functions (ms from the start of the phase; stretches, gaps under 3 ms merged)");
	for (let w = 0; w < watch.length; w++) {
		const spans: [number, number][] = [];
		for (let j = 0; j < st.at.length; j++) {
			if (!(flags(st.node[j] as number)[w] as boolean)) continue;
			const a = st.at[j] as number;
			const b = a + (st.dur[j] as number);
			const last = spans[spans.length - 1];
			if (last !== undefined && a - last[1] < 3) last[1] = b;
			else spans.push([a, b]);
		}
		if (spans.length === 0) continue;
		const total = spans.reduce((acc, [a, b]) => acc + (b - a), 0);
		const shown = spans.filter(([a, b]) => b - a >= 5).slice(0, 10).map(([a, b]) => `${f1(a)}-${f1(b)} (${f1(b - a)})`);
		log(`  ${(watch[w] as { label: string }).label}: ${spans.length} stretches, ${f1(total)} ms; ${shown.join(", ")}${spans.filter(([a, b]) => b - a >= 5).length > 10 ? ", ..." : ""}`);
	}
}

/** Component updates (setState / forceUpdate) during the phase, grouped by who called them. */
function updatesTable(m: Manual, cal: Calibration | null): void {
	const ups = m.updates ?? [];
	log(`  Component updates requested (setState / forceUpdate calls): ${ups.length}`);
	if (ups.length === 0) return;
	const mapFrame = (line: string): string | null => {
		const mm = /^at\s+(?:(.*?)\s+\()?(plugin:logwell):(\d+):(\d+)\)?$/.exec(line);
		if (mm === null || sourceMap === null || cal === null) return null;
		const e = sourceMap.findEntry(Math.max(0, Number(mm[3]) - 1 - cal.offset), Math.max(0, Number(mm[4]) - 1)) as { originalSource?: string; originalLine?: number };
		const src = typeof e.originalSource === "string" ? e.originalSource.replace(/^(\.\.\/)+/, "") : "?";
		return `${mm[1] ?? "(anonymous)"} ${src}:${(e.originalLine ?? 0) + 1}`;
	};
	const groups = new Map<string, { n: number; first: number; last: number; kind: string }>();
	for (const u of ups) {
		const frames = u.stack.map(mapFrame).filter((x): x is string => x !== null && !x.includes("node_modules/preact"));
		const sig = `${u.kind} <- ${frames.slice(0, 3).join(" <- ") || u.stack[0] || "?"}`;
		const g = groups.get(sig) ?? { n: 0, first: u.t - m.t0, last: u.t - m.t0, kind: u.kind };
		g.n++;
		g.last = u.t - m.t0;
		groups.set(sig, g);
	}
	for (const [sig, g] of [...groups].sort((a, b) => a[1].first - b[1].first).slice(0, 14)) log(`  ${String(g.n).padStart(4)}x  first ${f1(g.first).padStart(8)}  last ${f1(g.last).padStart(8)}  ${sig}`);
}

function main(): void {
	const only = process.argv.slice(2);
	const names = ORDER.filter((n) => (only.length === 0 || only.includes(n)) && (existsSync(`${dir}/${n}.cpuprofile`) || existsSync(`${dir}/${n}.manual.json`)));
	const profiles = new Map<string, Profile>();
	for (const n of names) if (existsSync(`${dir}/${n}.cpuprofile`)) profiles.set(n, JSON.parse(readFileSync(`${dir}/${n}.cpuprofile`, "utf8")) as Profile);
	const cal = calibrate([...profiles.values()]);
	const resolve = makeResolver(cal);
	log(
		cal === null
			? "Source mapping: NOT available (main.js / main.js.map missing or no match); function locations are bundle positions."
			: `Source mapping: script "${cal.url}", loader line offset ${cal.offset}, ${cal.matched} of ${cal.tried} frames checked against main.js lines.`,
	);
	if (existsSync(`${dir}/run.json`)) {
		const run = JSON.parse(readFileSync(`${dir}/run.json`, "utf8")) as Record<string, unknown>;
		log(`Run: ${String(run["tasks"])} tasks, ${Math.round(Number(run["sizeKb"]))} KB, ${String(run["device"])}, plugin ${String(run["version"])}, profiler: ${String(run["provider"])}`);
		log(`Reference (live store, pure calls): ${JSON.stringify(run["reference"])}`);
		const results = run["results"] as Record<string, { measuredMs: number; totalMs: number }>;
		log("Phase times (measured = the limits-harness definition; profiled phases include the profiler's own cost):");
		for (const n of ORDER) {
			const r = results[n];
			if (r !== undefined) log(`  ${n.padEnd(22)} ${f1(r.measuredMs).padStart(8)} ms  ${profiles.has(n) ? "profiled" : "plain"}`);
		}
	}
	for (const n of names) {
		log();
		log(`==== ${n} ====`);
		const manualPath = `${dir}/${n}.manual.json`;
		const manual = existsSync(manualPath) ? (JSON.parse(readFileSync(manualPath, "utf8")) as Manual) : null;
		const profile = profiles.get(n);
		if (manual !== null) {
			log(`  Phase window ${f1(manual.t1 - manual.t0)} ms; heap ${(manual.heapBefore / 1048576).toFixed(0)} MB -> ${(manual.heapAfter / 1048576).toFixed(0)} MB; DOM at the end: ${manual.domNodes ?? "?"} elements, ${manual.taskRows ?? "?"} task rows`);
			manualTable(manual);
			updatesTable(manual, cal);
		}
		if (profile === undefined) continue;
		const st = analyze(profile, resolve);
		log(`  CPU profile: window ${f1(st.windowMs)} ms, ${st.sampleCount} samples; active ${f1(st.activeMs)} ms, idle ${f1(st.idleMs)} ms, (program) ${f1(st.programMs)} ms, GC ${f1(st.gcMs)} ms (${((100 * st.gcMs) / st.windowMs).toFixed(1)}% of the window)`);
		if (manual !== null) segments(st, manual, resolve);
		activity(st, resolve);
		topTable("Top 25 by self time", st.self, 25, st, resolve);
		topTable("Top 15 by total (inclusive) time", st.total, 15, st, resolve);
		log("  Self time by module");
		for (const [c, ms] of [...st.byCategory].sort((a, b) => b[1] - a[1]).slice(0, 14)) log(`  ${f1(ms).padStart(8)} ${((100 * ms) / st.windowMs).toFixed(1).padStart(5)}%  ${c}`);
		printTree(st, resolve, 3, 90);
	}
	writeFileSync(`${dir}/report.txt`, `${out.join("\n")}\n`);
}

main();
