import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import type { ParseResult, SpanDecision } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, makeCtx, ruleKey } from "./helpers";

// Repeating tasks rule 19 (#12): `every year on <date>` starts on that date. While the date is still a choice (a bare
// hour), the repeat applies but saving is blocked until the hour is chosen, so the series is never anchored on today.
// And a range after an `every …` Quick Add cannot build stays one suggestion: only a built repeat splits it.
// Wednesday 2026-10-07 10:00 in each zone.

const ZONES = [NY, BERLIN, TOKYO] as const;

function parse(input: string, zone: string, decisions: SpanDecision[] = []): ParseResult {
	return parseQuickAdd(input, makeCtx({ zone, now: at(zone, "2026-10-07T10:00"), decisions }));
}

const chips = (r: ParseResult): string[] => r.chips.map((c) => `${c.kind}|${c.status}|${c.text}`);

describe.each(ZONES)("a yearly repeat whose start is a choice in %s", (zone) => {
	it.each(["Birthday every year on May 5 at 7", "Birthday every year on Feb 29 at 9", "Dentist every 2 years on May 5 at 7"])("%s: the repeat applies, the start blocks saving until chosen", (input) => {
		const r = parse(input, zone);
		const start = r.chips.find((c) => c.kind === "scheduled")!;
		expect(start.status, input).toBe("choice");
		expect(r.fields.recurrence?.freq, input).toBe("yearly");
		expect(r.fields.scheduled, input).toBeUndefined();
		expect(r.blocking, input).toEqual([start.id]);
		// Chosen, the start applies, the repeat keeps its rule and nothing blocks.
		const chosen = parse(input, zone, [{ span: start.span, text: start.text, kind: "date", value: start.alternatives![0]!.value! }]);
		expect(chosen.blocking, input).toEqual([]);
		expect(chosen.fields.scheduled, input).toEqual(start.alternatives![0]!.value);
		expect(chosen.fields.recurrence?.freq, input).toBe("yearly");
		expect(chosen.title, input).toBe(input.split(" every")[0]);
	});

	it("a repeat's time that is a choice blocks and its end waits; a start date that is a choice does not block", () => {
		const r = parse("Gym every monday at 7 until Dec 1", zone);
		expect(r.blocking.map((id) => r.chips.find((c) => c.id === id)?.kind)).toEqual(["recurrence"]);
		expect(r.chips.find((c) => c.kind === "repeatEnd")).toMatchObject({ status: "suggestion", notice: "Applies once the repeat's time is chosen" });
		const choice = parse("Gym every day starting Wednesday", zone);
		expect(choice.chips.find((c) => c.kind === "scheduled")?.status).toBe("choice");
		expect(choice.blocking).toEqual([]);
	});
});

describe.each(ZONES)("a range after an unsupported `every …` in %s", (zone) => {
	it.each([
		["Check server every 3 hours from Oct 12 to Oct 20", "every 3 hours", "unsupported|from Oct 12 to Oct 20"],
		["Standup every 2nd and 4th tuesday from Oct 12 to Dec 1", "every 2nd and 4th tuesday", "unsupported|from Oct 12 to Dec 1"],
		["Call every 3 hours, Oct 12 to Oct 20", "every 3 hours", "suggestion|Oct 12 to Oct 20"],
	])("%s stays one chip that applies nothing, never a start and an end", (input, phrase, range) => {
		const r = parse(input, zone);
		// Led by a start word it is the repeat's part, not supported with it; on its own it is the suggestion a range is.
		expect(chips(r), input).toEqual([`recurrence|unsupported|${phrase}`, `scheduled|${range}`]);
		expect(r.fields.scheduled, input).toBeUndefined();
		expect(r.fields.recurrenceEnd, input).toBeUndefined();
		expect(r.title, input).toBe(input);
	});

	it("a built repeat still splits it, and `until` after an unsupported one is still never a date", () => {
		const built = parse("Gym every day from Oct 12 to Oct 20", zone);
		expect(ruleKey(built.fields.recurrence!)).toBe("daily");
		expect(built.fields.recurrenceEnd).toEqual({ kind: "date", date: "2026-10-20" });
		const end = parse("Call every 3 hours until Dec 1", zone);
		expect(chips(end)).toEqual(["recurrence|unsupported|every 3 hours", "repeatEnd|unsupported|until Dec 1"]);
	});
});
