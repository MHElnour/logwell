import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { browser } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { classify, type Result } from "./classify";
import { type Cell, formatCsv, parseCsv } from "./csv";
import { type Generated, generateDb } from "./generate";
import { RENDERER_SRC } from "./renderer";

// The limits harness (docs/development/performance.md). It is NOT part of `npm run e2e` (wdio.conf.mts globs
// ./e2e/specs/**). Run it, after a build, with
//
//   npm run build && npx wdio run ./wdio.conf.mts --spec ./e2e/limits/limits.e2e.ts
//
// For each row of tests/limits/limits-matrix.csv it generates a valid current-schema database (generate.ts), writes it into
// the sandboxed vault, and measures in the real renderer (renderer.ts): open, save, view render. It writes the
// numbers back into the CSV after every row, so an interrupted run keeps what it has.
//
// Environment:
//   LIMITS_MAX_STEP  highest step to run (default 5; 1 = the smallest size of each dimension)
//   LIMITS_ONLY      comma list of dimensions to run (default all)
//
// Keep the real mouse off the Obsidian window while it runs, and run one row at a time (there is no parallelism).

const MAX_STEP = Number(process.env.LIMITS_MAX_STEP ?? 5);
const ONLY = (process.env.LIMITS_ONLY ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
/** The README's 60 s per-row timeout: every measured phase of a row shares this budget. */
const ROW_BUDGET_MS = 60_000;
const DB_PATH = "Limits.cpbase";

const csvPath = fileURLToPath(new URL("../../tests/limits/limits-matrix.csv", import.meta.url));
const shotsDir = fileURLToPath(new URL("../../.notes/limits/shots/", import.meta.url));
const manifestPath = fileURLToPath(new URL("../../manifest.json", import.meta.url));

interface Row {
	index: number;
	dimension: string;
	step: number;
	count: number;
	views: string;
}

interface Step {
	label: string;
	kind: string;
	arg: string;
	/** Counts towards render_ms (it is one of the row's views_to_check); the others only get you there. */
	counted: boolean;
}

interface Outcome {
	sizeKb: number | null;
	open: number | null;
	save: number | null;
	render: number | null;
	failed: boolean;
	notes: string[];
}

const matrix = parseCsv(readFileSync(csvPath, "utf8"));
const header = matrix[0]!.map((c) => c.v);
const colIndex = (name: string): number => {
	const i = header.indexOf(name);
	if (i < 0) throw new Error(`limits-matrix.csv has no column ${name}`);
	return i;
};
const cell = (row: Cell[], name: string): string => row[colIndex(name)]!.v;
const setCell = (row: Cell[], name: string, value: string): void => {
	row[colIndex(name)]!.v = value;
};

const rows: Row[] = matrix.slice(1).map((r, i) => ({
	index: i + 1,
	dimension: cell(r, "dimension"),
	step: Number(cell(r, "step")),
	count: Number(cell(r, "count")),
	views: cell(r, "views_to_check"),
}));

/** The steps of a row, from its views_to_check text. */
function planFor(views: string, g: Generated): Step[] {
	const big = g.markers.bigListName;
	const sidebar = (label: string, name = label, counted = true): Step => ({ label: name, kind: "sidebar", arg: label, counted });
	const openMore: Step = { label: "more popover", kind: "popoverOpen", arg: "", counted: false };
	switch (views) {
		case "Inbox, Today, Upcoming":
			return [sidebar("Inbox"), sidebar("Today"), sidebar("Upcoming")];
		case "that list, List and Board":
		case "that list, Board":
			return [sidebar(big, "list"), { label: "board", kind: "mode", arg: "Board", counted: true }];
		case "sidebar, list picker":
			return [sidebar("Inbox", "sidebar"), openMore, { label: "list picker", kind: "popover", arg: "list", counted: true }];
		case "sidebar tag tree, tag suggester":
			return [sidebar("Inbox", "sidebar tag tree"), openMore, { label: "tag suggester", kind: "popover", arg: "tags", counted: true }];
		case "sidebar tag tree":
			return [sidebar("Inbox", "sidebar tag tree")];
		case "details pane, list":
			return [sidebar(big, "list"), { label: "details pane", kind: "select", arg: g.markers.parentTaskId ?? "", counted: true }];
		case "Today, Upcoming, calendar month":
			return [
				sidebar("Upcoming"),
				sidebar("Today"),
				{ label: "calendar week", kind: "rail", arg: "Calendar", counted: false },
				{ label: "calendar month", kind: "cal", arg: "Month", counted: true },
			];
		case "calendar month and week":
			return [
				{ label: "calendar week", kind: "rail", arg: "Calendar", counted: true },
				{ label: "calendar month", kind: "cal", arg: "Month", counted: true },
			];
		case "Habits page, Today block":
			return [
				{ label: "habits page", kind: "rail", arg: "Habits", counted: true },
				{ label: "tasks", kind: "rail", arg: "Tasks", counted: false },
				sidebar("Inbox", "Inbox", false),
				sidebar("Today", "today block"),
			];
		case "Habits page, open time":
			return [{ label: "habits page", kind: "rail", arg: "Habits", counted: true }];
		case "Focus page history, open time":
			return [{ label: "focus page", kind: "rail", arg: "Focus", counted: true }];
		case "list row, details pane":
			return [sidebar("Inbox", "list row"), { label: "details pane", kind: "select", arg: g.markers.longTaskId ?? "", counted: true }];
		default:
			throw new Error(`No step plan for views_to_check "${views}"`);
	}
}

// -- machine facts ----------------------------------------------------------------------------

function sysctl(name: string): string {
	try {
		return execFileSync("sysctl", ["-n", name], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

function deviceText(): string {
	const brand = sysctl("machdep.cpu.brand_string") || "unknown CPU";
	const bytes = Number(sysctl("hw.memsize"));
	return Number.isFinite(bytes) && bytes > 0 ? `${brand}, ${Math.round(bytes / 2 ** 30)} GB` : brand;
}

function localToday(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// -- driving Obsidian ---------------------------------------------------------------------------

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
	return (await browser.executeObsidian(
		async (_ctx, m, a) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return await (window as any).__limits[m](...a);
		},
		method,
		args,
	)) as T;
}

async function installRenderer(): Promise<void> {
	await browser.execute(RENDERER_SRC);
}

function slug(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const results: { row: Row; result: string; outcome: Outcome | null }[] = [];

async function measureRow(row: Row, today: string, zone: string): Promise<Outcome> {
	const outcome: Outcome = { sizeKb: null, open: null, save: null, render: null, failed: false, notes: [] };
	const dbId = crypto.randomUUID();
	const generated = generateDb(row.dimension, row.count, { today, zone, dbId });
	outcome.sizeKb = generated.sizeKb;
	const s = generated.summary;
	outcome.notes.push(`${s.tasks} tasks, ${s.lists} lists, ${s.tags} tags, ${s.habits} habits, ${s.checkins} check-ins, ${s.focusSessions} focus`);

	// Reset: close what the previous row left, restore the vault, write this row's database.
	await installRenderer();
	await call("cleanup");
	await obsidianPage.resetVault();
	await installRenderer();
	const windowHow = await call<string>("prepareWindow");
	writeFileSync(`${obsidianPage.getVaultPath()}/${DB_PATH}`, generated.text);
	await call("fileIndexed", DB_PATH, 20_000);
	const size = await call<{ w: number; h: number }>("size");
	if (windowHow !== "electron remote") {
		await browser.setWindowSize(1400, 900);
		outcome.notes.push(`window via WebDriver (${windowHow})`);
	}
	const now = Date.now();
	const started = (): number => Date.now() - now;
	const remaining = (): number => {
		const left = ROW_BUDGET_MS - started();
		if (left <= 0) throw new Error(`row timeout: more than ${ROW_BUDGET_MS / 1000} s`);
		return left;
	};

	try {
		// open_ms
		const open = await call<{ ms: number; readyMs: number; tasks: number; readOnly: boolean; rafFallbacks: number }>("open", DB_PATH, remaining());
		outcome.open = open.ms;
		outcome.notes.push(`ready ${Math.round(open.readyMs)} ms`);
		if (open.readOnly) throw new Error("the database opened read-only");
		if (open.rafFallbacks > 0) outcome.notes.push(`${open.rafFallbacks} animation frames did not fire`);
		await browser.saveScreenshot(`${shotsDir}${row.dimension}-${row.step}-open.png`);

		// save_ms: the first completion is the number; the next two are context.
		const times = await call<number[]>("save", generated.markers.completeTaskIds.slice(0, 3), remaining());
		outcome.save = times[0] ?? null;
		if (times.length > 1) outcome.notes.push(`later saves ${times.slice(1).map((t) => Math.round(t)).join("/")} ms`);

		// render_ms: the slowest counted view.
		const steps = planFor(row.views, generated);
		const seen: string[] = [];
		let slowest: { ms: number; file: string } | null = null;
		let n = 0;
		for (const step of steps) {
			n++;
			const r = await call<{ ms: number; rafFallbacks: number }>("step", step.kind, step.arg, remaining());
			seen.push(`${step.label} ${Math.round(r.ms)}${step.counted ? "" : "*"}`);
			if (r.rafFallbacks > 0) outcome.notes.push(`${r.rafFallbacks} frames did not fire in ${step.label}`);
			const file = `${shotsDir}${row.dimension}-${row.step}-${n}-${slug(step.label)}.png`;
			await browser.saveScreenshot(file);
			if (step.counted && (outcome.render === null || r.ms > outcome.render)) {
				outcome.render = r.ms;
				slowest = { ms: r.ms, file };
			}
		}
		outcome.notes.push(`views: ${seen.join(", ")}${seen.some((x) => x.endsWith("*")) ? " (* not counted)" : ""}`);
		if (slowest !== null) copyFileSync(slowest.file, `${shotsDir}${row.dimension}-${row.step}.png`);
		outcome.notes.push(`window ${size.w}x${size.h}`);
	} catch (err) {
		outcome.failed = true;
		const message = err instanceof Error ? err.message : String(err);
		outcome.notes.push(`error: ${message.replace(/\s+/g, " ").slice(0, 220)}`);
		try {
			await browser.saveScreenshot(`${shotsDir}${row.dimension}-${row.step}.png`);
		} catch {
			// The window may be frozen; the note above says why.
		}
	}
	return outcome;
}

/** Closes the row's database, removes its file and its backups, so memory and disk do not pile up. */
async function afterRow(): Promise<void> {
	try {
		await installRenderer();
		await call("cleanup");
		await browser.executeObsidian(async ({ app, plugins }) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const dir = (plugins as any).logwell.manifest.dir as string;
			try {
				await app.vault.adapter.rmdir(`${dir}/backups`, true);
			} catch {
				// No backups were written.
			}
		});
	} catch {
		// A frozen renderer cannot clean up; the next row's reset will try again.
	}
	rmSync(`${obsidianPage.getVaultPath()}/${DB_PATH}`, { force: true });
}

// -- the matrix -----------------------------------------------------------------------------------

describe("limits", function () {
	// A full row is generation, reset, open, save, views and screenshots; only the measured part has the 60 s budget.
	this.timeout(10 * 60_000);

	const broken = new Map<string, number>();
	let version = "";
	let device = "";
	let today = "";
	let zone = "";

	before(async () => {
		mkdirSync(shotsDir, { recursive: true });
		version = `${(JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }).version}+main`;
		device = deviceText();
		today = localToday();
		zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		// A frozen renderer must come back as an error, not as the WebDriver default of 30 s then silence.
		await browser.setTimeout({ script: ROW_BUDGET_MS + 30_000 });
		console.log(`limits: ${version}, ${device}, ${today}, zone ${zone}, max step ${MAX_STEP}${ONLY.length > 0 ? `, only ${ONLY.join("+")}` : ""}`);
	});

	for (const row of rows) {
		if (row.step > MAX_STEP) continue;
		if (ONLY.length > 0 && !ONLY.includes(row.dimension)) continue;
		it(`${row.dimension} step ${row.step} (${row.count})`, async () => {
			const csvRow = matrix[row.index]!;
			const brokeAt = broken.get(row.dimension);
			let result: Result | "skipped";
			let outcome: Outcome | null = null;
			if (brokeAt !== undefined) {
				result = "skipped";
				for (const col of ["db_size_kb", "open_ms", "save_ms", "render_ms"]) setCell(csvRow, col, "");
				setCell(csvRow, "notes", `skipped: step ${brokeAt} of ${row.dimension} broke`);
			} else {
				outcome = await measureRow(row, today, zone);
				result = classify({ open_ms: outcome.open, save_ms: outcome.save, render_ms: outcome.render, failed: outcome.failed });
				const round = (v: number | null): string => (v === null ? "" : String(Math.round(v)));
				setCell(csvRow, "db_size_kb", round(outcome.sizeKb));
				setCell(csvRow, "open_ms", round(outcome.open));
				setCell(csvRow, "save_ms", round(outcome.save));
				setCell(csvRow, "render_ms", round(outcome.render));
				setCell(csvRow, "notes", outcome.notes.join("; "));
				if (result === "broke") broken.set(row.dimension, row.step);
				await afterRow();
			}
			setCell(csvRow, "result", result);
			setCell(csvRow, "version", version);
			setCell(csvRow, "device", device);
			setCell(csvRow, "date", today);
			// Quote what needs it; a field that was empty and quote-free stays that way.
			writeFileSync(csvPath, formatCsv(matrix));
			results.push({ row, result, outcome });
			const o = outcome;
			console.log(
				`limits: ${row.dimension.padEnd(18)} ${String(row.count).padStart(6)}  size ${String(Math.round(o?.sizeKb ?? 0)).padStart(6)} KB  open ${String(Math.round(o?.open ?? 0)).padStart(5)}  save ${String(Math.round(o?.save ?? 0)).padStart(4)}  render ${String(Math.round(o?.render ?? 0)).padStart(5)}  ${result}`,
			);
		});
	}

	after(() => {
		const line = (cols: string[]): string => cols.map((c, i) => (i === 0 ? c.padEnd(18) : c.padStart(8))).join(" ");
		console.log("\nlimits: summary");
		console.log(line(["dimension", "count", "size_kb", "open_ms", "save_ms", "render_ms", "result"]));
		for (const { row, result, outcome } of results) {
			const v = (n: number | null | undefined): string => (n === null || n === undefined ? "-" : String(Math.round(n)));
			console.log(line([row.dimension, String(row.count), v(outcome?.sizeKb), v(outcome?.open), v(outcome?.save), v(outcome?.render), result]));
		}
		if (existsSync(shotsDir)) console.log(`limits: screenshots in ${shotsDir}`);
	});
});
