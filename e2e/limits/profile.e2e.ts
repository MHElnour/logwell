import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { browser } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { generateDb } from "./generate";
import { PROFILE_SRC } from "./profile-renderer";
import { RENDERER_SRC } from "./renderer";

// Where the time goes at 50,000 tasks (the open, save and view numbers of tests/limits/limits-matrix.csv). NOT part of `npm run e2e`.
//
//   LOGWELL_PROFILE_BUILD=1 node esbuild.config.mjs production      # unminified bundle + main.js.map
//   npx wdio run ./wdio.conf.mts --spec ./e2e/limits/profile.e2e.ts
//   npx tsx e2e/limits/profile-report.ts                            # the tables (needs main.js.map from the build)
//   npm run build                                                   # afterwards: put the minified bundle back
//
// It seeds a database like the limits harness (generate.ts, "tasks_total"), opens it once, and runs the three phases
// of the limits matrix in the real renderer, each with a V8 CPU profile (a CDP Profiler session attached from here
// through chromedriver's debugger address, 100 us sampling; the renderer opens and closes each profile with
// console.profile/profileEnd, so the window is exact) and manual spans from wraps on the live objects (profile-renderer.ts):
//   open  setActiveDatabase -> ready -> openApp("today") -> first render
//   save  complete one task through the app service, flush until isDirty is false
//   view  Today -> Inbox, Inbox -> Upcoming
// and at the end opens the database once more without the profiler (open-plain).
// Profiled phases pay for the profiler; the same actions then run again without it (marked "plain") to show how much.
// Output: .notes/limits/profiles/<phase>.cpuprofile, <phase>.manual.json and run.json (gitignored).
//
// Environment: PROFILE_TASKS (default 50000), PROFILE_SETTLE_MS (pause between phases, default 3000).
// Keep the real mouse off the Obsidian window while it runs.

const TASKS = Number(process.env.PROFILE_TASKS ?? 50_000);
const SETTLE_MS = Number(process.env.PROFILE_SETTLE_MS ?? 3000);
const BUDGET_MS = 120_000;
const DB_PATH = "Limits.cpbase";
const WARM_PATH = "Warmup.cpbase";

const outDir = fileURLToPath(new URL("../../.notes/limits/profiles", import.meta.url));
const manifestPath = fileURLToPath(new URL("../../manifest.json", import.meta.url));

function localToday(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sysctl(name: string): string {
	try {
		return execFileSync("sysctl", ["-n", name], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
	return (await browser.executeObsidian(
		async (_ctx, m, a) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const w = window as any;
			const target = m.startsWith("__limits.") ? w.__limits : w.__prof;
			return await target[m.replace("__limits.", "")](...a);
		},
		method,
		args,
	)) as T;
}

/** A CDP session on the Obsidian window. The renderer itself has no node `inspector` (no V8::Inspector in its node environment). */
interface Cdp {
	send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
	on(event: string, handler: (params: Record<string, unknown>) => void): void;
}

async function connectCdp(): Promise<{ cdp: Cdp; how: string }> {
	const errors: string[] = [];
	try {
		const pb = await browser.getPuppeteer();
		const pages = await pb.pages();
		const page = pages.find((pg: { url(): string }) => pg.url().startsWith("app://obsidian.md")) ?? pages[0];
		if (page !== undefined) {
			const session = await page.createCDPSession();
			return { cdp: session as unknown as Cdp, how: `puppeteer CDP session on ${page.url()}` };
		}
		errors.push("puppeteer: no page");
	} catch (err) {
		errors.push(`puppeteer: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		const opts = (browser.capabilities as Record<string, unknown>)["goog:chromeOptions"] as { debuggerAddress?: string } | undefined;
		const addr = opts?.debuggerAddress;
		if (addr === undefined) throw new Error("no goog:chromeOptions.debuggerAddress");
		const [host = "127.0.0.1", port = ""] = addr.split(":");
		const moduleName = "chrome-remote-interface";
		const mod = (await import(moduleName)) as { default: (o: Record<string, unknown>) => Promise<Cdp> };
		const client = await mod.default({ host: host === "localhost" ? "127.0.0.1" : host, port: Number(port) });
		return { cdp: client, how: `chrome-remote-interface on ${addr}` };
	} catch (err) {
		errors.push(`chrome-remote-interface: ${err instanceof Error ? err.message : String(err)}`);
	}
	throw new Error(`no CDP session: ${errors.join("; ")}`);
}

interface PhaseResult {
	totalMs: number;
	measuredMs: number;
	spanCount: number;
	longtasks: number;
	marks: { n: string; ms: number }[];
	[k: string]: unknown;
}

describe("profile", function () {
	this.timeout(15 * 60_000);

	it(`profiles open, save and view at ${TASKS} tasks`, async () => {
		mkdirSync(outDir, { recursive: true });
		await browser.setTimeout({ script: BUDGET_MS + 60_000 });
		const today = localToday();
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const version = (JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }).version;
		const device = `${sysctl("machdep.cpu.brand_string")}, ${Math.round(Number(sysctl("hw.memsize")) / 2 ** 30)} GB`;

		const big = generateDb("tasks_total", TASKS, { today, zone, dbId: crypto.randomUUID() });
		const warm = generateDb("tasks_total", 1000, { today, zone, dbId: crypto.randomUUID() });
		console.log(`profile: ${TASKS} tasks, ${Math.round(big.sizeKb)} KB, ${version}, ${device}`);

		// Reset and set up, as in the limits harness.
		await browser.execute(RENDERER_SRC);
		await browser.execute(PROFILE_SRC);
		await call("__limits.cleanup");
		await obsidianPage.resetVault();
		await browser.execute(RENDERER_SRC);
		await browser.execute(PROFILE_SRC);
		await call("__limits.prepareWindow");
		const { cdp, how } = await connectCdp();
		const finished = new Map<string, unknown>();
		cdp.on("Profiler.consoleProfileFinished", (e) => finished.set(String(e["title"]), e["profile"]));
		await cdp.send("Profiler.enable");
		await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
		// Does console.profile() deliver a profile to this session? Then the renderer sets the window itself.
		await browser.execute(`console.profile("probe"); let x = 0; for (let i = 0; i < 3e6; i++) x += i; console.profileEnd("probe"); return x;`);
		for (let i = 0; i < 50 && !finished.has("probe"); i++) await browser.pause(100);
		const viaConsole = finished.has("probe");
		finished.clear();
		const mode = viaConsole ? "console" : "outer";
		await call("setMode", mode);
		const provider = `${how}; ${viaConsole ? "console.profile() in the renderer" : "Profiler.start/stop around each call (window includes WebDriver gaps)"}`;
		console.log(`profile: profiler = ${provider}`);

		// Warm-up: a small database opened once so the session classes exist, then wrapped (profile-renderer.ts).
		writeFileSync(`${obsidianPage.getVaultPath()}/${WARM_PATH}`, warm.text);
		await call("__limits.fileIndexed", WARM_PATH, 20_000);
		const warmed = await call<{ wraps: number; updateHook: string }>("warmup", WARM_PATH, 30_000);
		rmSync(`${obsidianPage.getVaultPath()}/${WARM_PATH}`, { force: true });
		console.log(`profile: wrapped ${warmed.wraps} functions; component update hook: ${warmed.updateHook}`);

		writeFileSync(`${obsidianPage.getVaultPath()}/${DB_PATH}`, big.text);
		await call("__limits.fileIndexed", DB_PATH, 20_000);
		await browser.pause(SETTLE_MS);

		const results: Record<string, PhaseResult> = {};
		const run = async (name: string, profiled: boolean, fn: (profile: boolean) => Promise<PhaseResult>): Promise<void> => {
			if (profiled && mode === "outer") await cdp.send("Profiler.start");
			const r = await fn(profiled);
			let profile: unknown = null;
			if (profiled && mode === "outer") profile = (await cdp.send("Profiler.stop"))["profile"];
			if (profiled && mode === "console") {
				for (let i = 0; i < 300 && !finished.has(name); i++) await browser.pause(100);
				profile = finished.get(name) ?? null;
				finished.delete(name);
			}
			if (profiled) {
				if (profile === null) throw new Error(`no CPU profile arrived for ${name}`);
				writeFileSync(`${outDir}/${name}.cpuprofile`, JSON.stringify(profile));
			}
			results[name] = r;
			console.log(`profile: ${name.padEnd(22)} ${profiled ? "profiled" : "plain   "}  measured ${Math.round(r.measuredMs)} ms, window ${Math.round(r.totalMs)} ms, ${r.spanCount} spans, ${r.longtasks} long tasks`);
			await browser.pause(SETTLE_MS);
		};

		// open
		await run("open", true, (p) => call<PhaseResult>("open", "open", DB_PATH, outDir, p, BUDGET_MS));
		const afterOpen = await call<{ dirty: boolean; readOnly: boolean; tasks: number }>("dbState");
		console.log(`profile: after open: ${afterOpen.tasks} tasks, dirty ${afterOpen.dirty}, read-only ${afterOpen.readOnly}`);
		if (afterOpen.readOnly) throw new Error("the database opened read-only");

		// save: the first completion is profiled, the second runs plain.
		const ids = big.markers.completeTaskIds;
		await run("save", true, (p) => call<PhaseResult>("save", "save", ids[0] ?? "", outDir, p, BUDGET_MS));
		await run("save-plain", false, (p) => call<PhaseResult>("save", "save-plain", ids[1] ?? "", outDir, p, BUDGET_MS));

		// view: Today -> Inbox -> Upcoming profiled; then Today -> Inbox -> Upcoming plain.
		await run("view-inbox", true, (p) => call<PhaseResult>("view", "view-inbox", "Inbox", outDir, p, BUDGET_MS));
		await run("view-upcoming", true, (p) => call<PhaseResult>("view", "view-upcoming", "Upcoming", outDir, p, BUDGET_MS));
		await run("view-today-plain", false, (p) => call<PhaseResult>("view", "view-today-plain", "Today", outDir, p, BUDGET_MS));
		await run("view-inbox-plain", false, (p) => call<PhaseResult>("view", "view-inbox-plain", "Inbox", outDir, p, BUDGET_MS));
		await run("view-upcoming-plain", false, (p) => call<PhaseResult>("view", "view-upcoming-plain", "Upcoming", outDir, p, BUDGET_MS));

		// open again without the profiler: what the profiler cost, and what a warm JIT saves.
		await call("cleanup");
		await browser.pause(SETTLE_MS);
		await run("open-plain", false, (p) => call<PhaseResult>("open", "open-plain", DB_PATH, outDir, p, BUDGET_MS));

		const reference = await call<Record<string, number | boolean>>("reference");
		console.log(`profile: reference ${JSON.stringify(reference)}`);

		writeFileSync(
			`${outDir}/run.json`,
			JSON.stringify({ version, device, date: today, tasks: TASKS, sizeKb: big.sizeKb, provider, wraps: warmed.wraps, reference, results }, null, 1),
		);

		// Close the database and remove what the run left behind.
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
		rmSync(`${obsidianPage.getVaultPath()}/${DB_PATH}`, { force: true });
	});
});
