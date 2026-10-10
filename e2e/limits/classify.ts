// The result column of docs/development/performance.md: pass, slow or broke by the time criteria. `ui_ok` stays empty
// (a human fills it from the screenshot), so a `pass` here is provisional until it reads `yes`.

/** The pass limit of each time, in ms. */
export const LIMITS = { open: 1000, save: 200, render: 300 } as const;
/** Slow up to this many times a limit; over it the row is broke. */
export const BROKE_FACTOR = 3;

export type Result = "pass" | "slow" | "broke";

export interface Measured {
	open_ms: number | null;
	save_ms: number | null;
	render_ms: number | null;
	/** An error, a freeze or the 60 s row timeout. */
	failed: boolean;
}

export function classify(m: Measured): Result {
	if (m.failed) return "broke";
	const pairs: [number | null, number][] = [
		[m.open_ms, LIMITS.open],
		[m.save_ms, LIMITS.save],
		[m.render_ms, LIMITS.render],
	];
	let allPass = true;
	for (const [value, limit] of pairs) {
		if (value === null) continue;
		if (value > BROKE_FACTOR * limit) return "broke";
		if (value >= limit) allPass = false;
	}
	return allPass ? "pass" : "slow";
}
