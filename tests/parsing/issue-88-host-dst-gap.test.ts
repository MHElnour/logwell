import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import type { ParseResult } from "../../src/parsing/types";
import { TOKYO, at, makeCtx } from "./helpers";

// Tasks and Quick Add rule 25 (#88): relative times count from the task's own clock, whatever the computer's zone. The
// computer is in New York; the task's zone is Tokyo, where nothing changes. Around the computer's spring-forward (02:00
// on 2026-03-08 does not exist there), chrono's reading of "in 1 hour" moved an hour on the computer's clock.

const HOST = "America/New_York";
let before: string | undefined;

beforeAll(() => {
	before = process.env.TZ;
	process.env.TZ = HOST;
	// The premise: the computer has no 02:30 on 2026-03-08.
	expect(DateTime.fromObject({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, { zone: "system" }).hour).toBe(3);
});

afterAll(() => {
	if (before === undefined) delete process.env.TZ;
	else process.env.TZ = before;
});

const parse = (input: string, local: string): ParseResult => parseQuickAdd(input, makeCtx({ zone: TOKYO, now: at(TOKYO, local) }));
const local = (r: ParseResult): string | undefined => (r.fields.scheduled?.kind === "datetime" ? r.fields.scheduled.local : undefined);

describe("relative times on a computer in a DST gap (#88)", () => {
	it("count from the task's clock when the task's wall time does not exist on the computer", () => {
		expect(local(parse("Call in 1 hour", "2026-03-08T02:30"))).toBe("2026-03-08T03:30");
		expect(local(parse("Call in 30 minutes", "2026-03-08T02:30"))).toBe("2026-03-08T03:00");
		expect(local(parse("Call in 2 hours", "2026-03-08T02:30"))).toBe("2026-03-08T04:30");
	});

	it("count from the task's clock when the computer changes its clock within the span", () => {
		expect(local(parse("Call in 1 hour", "2026-03-08T01:30"))).toBe("2026-03-08T02:30");
		expect(local(parse("Call in 3 hours", "2026-03-08T00:30"))).toBe("2026-03-08T03:30");
	});

	it("a plain time and a date are unaffected", () => {
		const r = parse("Call tomorrow at 5pm", "2026-03-08T02:30");
		expect(local(r)).toBe("2026-03-09T17:00");
		expect(parse("Call Oct 12", "2026-03-08T02:30").fields.scheduled).toEqual({ kind: "date", date: "2026-10-12" });
		expect(local(parse("Call in 1 hour", "2026-06-10T10:00"))).toBe("2026-06-10T11:00");
	});
});
