import type { Instant } from "./types";

/** Clock port. Tests use a fixed or manually advanced clock. */
export interface Clock {
	now(): Date;
}

export const systemClock: Clock = {
	now: () => new Date(),
};

export function nowInstant(clock: Clock): Instant {
	return clock.now().toISOString();
}

export function deviceZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Id port. Production uses crypto.randomUUID. */
export type IdGenerator = () => string;

export const randomId: IdGenerator = () => crypto.randomUUID();
