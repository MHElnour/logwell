// How the perf tests measure. A time depends on how busy the machine is, so no perf test asserts an absolute time: a
// test compares two times measured in the same run (how a time grows with the input, or a path against a reference that
// does the same work another way), or only logs its times (CHECKPOINT_PERF_LOG=1 prints them). The exact checks are
// counts: full passes over the task map, queries, listings, reads and requests.

const LOG = Boolean(process.env.CHECKPOINT_PERF_LOG);

/** Prints one line of measurements when CHECKPOINT_PERF_LOG is set. */
export function perfLog(line: string): void {
	if (LOG) process.stderr.write(`${line}\n`);
}

export function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? 0;
}

export const fastest = (xs: number[]) => Math.min(...xs);

/** Milliseconds `run` takes. */
export function elapsed(run: () => unknown): number {
	const start = performance.now();
	run();
	return performance.now() - start;
}

/** Milliseconds `run` takes, awaited. */
export async function elapsedAsync(run: () => Promise<unknown>): Promise<number> {
	const start = performance.now();
	await run();
	return performance.now() - start;
}

/**
 * The fastest time of `small` and of `large` over `runs` interleaved runs, after one warm-up run of each, so a busy
 * machine slows both alike. A growth check compares them: work that grows with its input as it should takes a few
 * times longer on an input a few times larger, while work that grows with its square takes many times longer.
 */
export function timeBoth(small: () => unknown, large: () => unknown, runs = 5): { small: number; large: number } {
	small();
	large();
	const smalls: number[] = [];
	const larges: number[] = [];
	for (let i = 0; i < runs; i++) {
		smalls.push(elapsed(small));
		larges.push(elapsed(large));
	}
	return { small: fastest(smalls), large: fastest(larges) };
}

/** A pass is an iteration of a map of at least this many entries: the task map of a 50,000-task database. */
const BIG = 40_000;

/** Counts iterations of maps with at least `BIG` entries while `fn` runs; returns where each pass started. */
export async function countBigPasses<T>(fn: () => Promise<T> | T): Promise<{ result: T; passes: string[] }> {
	const proto = Map.prototype as unknown as Record<string | symbol, (...a: unknown[]) => unknown>;
	const names: (string | symbol)[] = ["values", "keys", "entries", "forEach", Symbol.iterator];
	const originals = names.map((n) => proto[n] as (...a: unknown[]) => unknown);
	const passes: string[] = [];
	names.forEach((name, i) => {
		const original = originals[i] as (...a: unknown[]) => unknown;
		proto[name] = function (this: Map<unknown, unknown>, ...args: unknown[]) {
			if (this.size >= BIG) {
				const frames = (new Error().stack ?? "").split("\n").filter((l) => l.includes("/src/"));
				const first = (frames[0] ?? "(outside src)").trim().replace(/^at /, "").replace(/\(?file:\/\/|\)$/g, "");
				passes.push(`${String(name === Symbol.iterator ? "[iterator]" : name)} ${first.replace(/.*\/src\//, "src/")}`);
			}
			return original.apply(this, args);
		};
	});
	try {
		return { result: await fn(), passes };
	} finally {
		names.forEach((name, i) => {
			proto[name] = originals[i] as (...a: unknown[]) => unknown;
		});
	}
}

export const tally = (passes: string[]) => {
	const counts = new Map<string, number>();
	for (const p of passes) counts.set(p, (counts.get(p) ?? 0) + 1);
	return [...counts].map(([where, n]) => `${n}x ${where}`).join("; ");
};
