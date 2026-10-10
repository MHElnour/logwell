import type { FocusMoment } from "../domain/focus";
import type { SoundTheme } from "../app/settings";

// One short synthesized tone per moment, Web Audio only (no bundled files).

interface ParamLike {
	setValueAtTime(value: number, time: number): unknown;
	linearRampToValueAtTime(value: number, time: number): unknown;
}
interface OscillatorLike {
	type: string;
	frequency: ParamLike;
	connect(node: unknown): unknown;
	start(time: number): void;
	stop(time: number): void;
}
interface GainLike {
	gain: ParamLike;
	connect(node: unknown): unknown;
}
/** The slice of AudioContext the player uses, so tests can fake it. */
export interface AudioContextLike {
	readonly currentTime: number;
	readonly state: string;
	readonly destination: unknown;
	createOscillator(): OscillatorLike;
	createGain(): GainLike;
	resume(): Promise<void>;
	close(): Promise<void>;
}

interface Note {
	freq: number;
	/** Seconds after the moment starts. */
	at: number;
	dur: number;
}
interface Voice {
	wave: "sine" | "triangle" | "square";
	/** Peak gain at volume 100. */
	level: number;
	notes: Record<FocusMoment, Note[]>;
}

const VOICES: Record<Exclude<SoundTheme, "none">, Voice> = {
	// Bell-like: a rising pair starts, a falling pair is the break, a three-note arpeggio ends the set.
	chime: {
		wave: "sine",
		level: 0.4,
		notes: {
			"focus-start": [{ freq: 659, at: 0, dur: 0.5 }, { freq: 988, at: 0.18, dur: 0.7 }],
			"break-start": [{ freq: 988, at: 0, dur: 0.5 }, { freq: 659, at: 0.18, dur: 0.7 }],
			"set-done": [{ freq: 523, at: 0, dur: 0.5 }, { freq: 659, at: 0.2, dur: 0.5 }, { freq: 784, at: 0.4, dur: 0.9 }],
		},
	},
	soft: {
		wave: "triangle",
		level: 0.3,
		notes: {
			"focus-start": [{ freq: 440, at: 0, dur: 0.9 }],
			"break-start": [{ freq: 330, at: 0, dur: 0.9 }],
			"set-done": [{ freq: 330, at: 0, dur: 0.7 }, { freq: 440, at: 0.35, dur: 1.1 }],
		},
	},
	digital: {
		wave: "square",
		level: 0.15,
		notes: {
			"focus-start": [{ freq: 880, at: 0, dur: 0.1 }, { freq: 880, at: 0.16, dur: 0.1 }],
			"break-start": [{ freq: 440, at: 0, dur: 0.2 }],
			"set-done": [{ freq: 660, at: 0, dur: 0.1 }, { freq: 880, at: 0.14, dur: 0.1 }, { freq: 1320, at: 0.28, dur: 0.3 }],
		},
	},
};

const MOMENTS: FocusMoment[] = ["focus-start", "break-start", "set-done"];
/** Seconds between the moments in a preview. */
const PREVIEW_GAP = 1.4;

export class SoundPlayer {
	private ctx: AudioContextLike | null = null;
	private disposed = false;

	constructor(
		private readonly settings: () => { theme: SoundTheme; volume: number },
		private readonly create: () => AudioContextLike = defaultContext,
	) {}

	play(moment: FocusMoment): void {
		this.schedule(moment, 0);
	}

	/** The settings "Play" button: all three moments in a row. */
	preview(): void {
		MOMENTS.forEach((m, i) => this.schedule(m, i * PREVIEW_GAP));
	}

	/**
	 * Call from the user gesture that starts a set (Start, a command, Play): creates or resumes the AudioContext
	 * so the timer-driven sounds later are not blocked by iOS or other mobile autoplay rules.
	 */
	unlock(): void {
		if (this.disposed) return;
		const { theme, volume } = this.settings();
		if (theme === "none" || volume <= 0) return;
		try {
			const ctx = (this.ctx ??= this.create());
			// iOS reports "interrupted" after a call or a lock; anything but running and closed needs a resume.
			if (ctx.state !== "running" && ctx.state !== "closed") void ctx.resume().catch(() => undefined);
		} catch (err) {
			console.warn("Logwell: could not unlock the focus sound.", err);
		}
	}

	/** Closes the AudioContext. The player is done: a later play or preview does nothing. */
	dispose(): void {
		this.disposed = true;
		const ctx = this.ctx;
		this.ctx = null;
		if (ctx !== null) void ctx.close().catch(() => undefined);
	}

	private schedule(moment: FocusMoment, delay: number): void {
		if (this.disposed) return;
		const { theme, volume } = this.settings();
		if (theme === "none") return;
		const scale = Math.min(100, Math.max(0, volume)) / 100;
		if (scale === 0) return;
		try {
			const ctx = (this.ctx ??= this.create());
			if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
			const voice = VOICES[theme];
			const peak = voice.level * scale;
			for (const note of voice.notes[moment]) {
				const t0 = ctx.currentTime + delay + note.at;
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = voice.wave;
				osc.frequency.setValueAtTime(note.freq, t0);
				gain.gain.setValueAtTime(0, t0);
				gain.gain.linearRampToValueAtTime(peak, t0 + 0.02);
				gain.gain.linearRampToValueAtTime(0, t0 + note.dur);
				osc.connect(gain);
				gain.connect(ctx.destination);
				osc.start(t0);
				osc.stop(t0 + note.dur + 0.05);
			}
		} catch (err) {
			// No audio device, or the context was blocked: the sound is optional.
			console.warn("Logwell: could not play the focus sound.", err);
		}
	}
}

function defaultContext(): AudioContextLike {
	return new window.AudioContext();
}
