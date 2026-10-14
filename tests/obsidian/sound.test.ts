import { describe, expect, it } from "vitest";
import { type AudioContextLike, SoundPlayer } from "../../src/obsidian/sound";

interface Tone {
	freq: number;
	start: number;
	peak: number;
}

function fakeContext() {
	const tones: Tone[] = [];
	const ctx = {
		created: 0,
		closed: 0,
		resumed: 0,
		currentTime: 10,
		state: "running",
		destination: {},
		createOscillator() {
			const tone: Tone = { freq: 0, start: 0, peak: 0 };
			tones.push(tone);
			return {
				type: "sine",
				frequency: {
					setValueAtTime: (v: number) => void (tone.freq = v),
					value: 0,
				},
				connect: () => undefined,
				start: (t: number) => void (tone.start = t),
				stop: () => undefined,
				__tone: tone,
			};
		},
		createGain() {
			const idx = tones.length - 1;
			return {
				gain: {
					setValueAtTime: () => undefined,
					linearRampToValueAtTime: (v: number) => void (tones[idx] && v > (tones[idx]?.peak ?? 0) && (tones[idx].peak = v)),
					exponentialRampToValueAtTime: () => undefined,
				},
				connect: () => undefined,
			};
		},
		resume() {
			ctx.resumed++;
			return Promise.resolve();
		},
		close() {
			ctx.closed++;
			return Promise.resolve();
		},
	};
	return { ctx, tones };
}

function player(theme: "chime" | "soft" | "digital" | "none", volume: number) {
	const f = fakeContext();
	const p = new SoundPlayer(() => ({ theme, volume }), () => {
		f.ctx.created++;
		return f.ctx as unknown as AudioContextLike;
	});
	return { ...f, p };
}

const freqs = (tones: Tone[]) => tones.map((t) => t.freq);

describe("SoundPlayer", () => {
	it("creates the AudioContext lazily", () => {
		const { ctx, p } = player("chime", 60);
		expect(ctx.created).toBe(0);
		p.play("focus-start");
		expect(ctx.created).toBe(1);
		p.play("break-start");
		expect(ctx.created).toBe(1);
	});

	it("each moment plays its own tone in every theme", () => {
		for (const theme of ["chime", "soft", "digital"] as const) {
			const seen = new Set<string>();
			for (const moment of ["focus-start", "break-start", "set-done"] as const) {
				const { tones, p } = player(theme, 60);
				p.play(moment);
				expect(tones.length).toBeGreaterThan(0);
				seen.add(freqs(tones).join(","));
			}
			expect(seen.size).toBe(3);
		}
	});

	it("none plays nothing and creates no context", () => {
		const { ctx, tones, p } = player("none", 60);
		p.play("set-done");
		expect(tones).toEqual([]);
		expect(ctx.created).toBe(0);
	});

	it("volume 0 plays nothing", () => {
		const { tones, p } = player("chime", 0);
		p.play("focus-start");
		expect(tones).toEqual([]);
	});

	it("volume scales the gain", () => {
		const low = player("chime", 25);
		const high = player("chime", 100);
		low.p.play("focus-start");
		high.p.play("focus-start");
		expect(low.tones[0]!.peak).toBeGreaterThan(0);
		expect(high.tones[0]!.peak).toBeCloseTo(low.tones[0]!.peak * 4, 5);
	});

	it("tones start at or after the context time", () => {
		const { tones, p } = player("digital", 60);
		p.play("set-done");
		for (const t of tones) expect(t.start).toBeGreaterThanOrEqual(10);
	});

	it("preview plays the three moments one after another", () => {
		const { tones, p } = player("soft", 60);
		p.preview();
		const starts = tones.map((t) => t.start);
		expect(starts).toEqual([...starts].sort((a, b) => a - b));
		expect(Math.max(...starts) - Math.min(...starts)).toBeGreaterThan(1);
	});

	it("resumes a suspended context", () => {
		const { ctx, p } = player("chime", 60);
		ctx.state = "suspended";
		p.play("focus-start");
		expect(ctx.resumed).toBe(1);
	});

	it("unlock creates the context and resumes a suspended one before any sound plays", () => {
		const { ctx, tones, p } = player("chime", 60);
		ctx.state = "suspended";
		p.unlock();
		expect(ctx.created).toBe(1);
		expect(ctx.resumed).toBe(1);
		expect(tones).toEqual([]);
		p.play("focus-start");
		expect(ctx.created).toBe(1);
	});

	it("unlock resumes an interrupted context (iOS) but not a running or closed one", () => {
		for (const [state, resumed] of [["interrupted", 1], ["running", 0], ["closed", 0]] as const) {
			const { ctx, p } = player("chime", 60);
			ctx.state = state;
			p.unlock();
			expect(ctx.resumed).toBe(resumed);
		}
	});

	it("unlock does nothing for the none theme or volume 0, and after dispose", () => {
		const a = player("none", 60);
		a.p.unlock();
		expect(a.ctx.created).toBe(0);
		const b = player("chime", 0);
		b.p.unlock();
		expect(b.ctx.created).toBe(0);
		const c = player("chime", 60);
		c.p.dispose();
		c.p.unlock();
		expect(c.ctx.created).toBe(0);
	});

	it("dispose closes the context once, and a later play or preview is a no-op that creates nothing", () => {
		const { ctx, p } = player("chime", 60);
		p.play("focus-start");
		p.dispose();
		p.dispose();
		expect(ctx.closed).toBe(1);
		p.play("focus-start");
		p.preview();
		expect(ctx.created).toBe(1);
	});

	it("play after dispose never creates a context, even before the first sound", () => {
		const { ctx, p } = player("chime", 60);
		p.dispose();
		p.play("set-done");
		expect(ctx.created).toBe(0);
	});

	it("a failing AudioContext never throws", () => {
		const p = new SoundPlayer(() => ({ theme: "chime", volume: 60 }), () => {
			throw new Error("no audio");
		});
		expect(() => p.play("focus-start")).not.toThrow();
	});
});
