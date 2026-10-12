import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/parsing";
import type { RepeatRule } from "../../src/domain/types";
import type { ParsedField, SpanDecision } from "../../src/parsing/types";
import { BERLIN, NY, TOKYO, at, chipLines, dateSpecOf, makeCtx, ruleKey } from "./helpers";

// Golden table. Every case fixes the reference instant and
// zone, then asserts the title, every field and every chip exactly. Omitted
// expectations mean "absent": a case that forgets a chip fails.
//
// Reference instants (all 2026-10-01 10:00Z unless noted):
//   ny     Thu 2026-10-01 06:00 EDT
//   berlin Thu 2026-10-01 12:00 CEST
//   tokyo  Fri 2026-10-02 05:00 JST (the UTC date is Oct 1)

/** The rule "every monday at <time>" as the default (New York) zone parses it: what the Quick Add picker hands back. */
const weeklyMondayAt = (time: string): RepeatRule => ({ freq: "weekly", interval: 1, weekdays: ["MO"], monthly: null, afterCompletion: false, time, tz: NY });

type ZoneKey = "ny" | "berlin" | "tokyo";
const ZONES: Record<ZoneKey, { zone: string; now: string }> = {
	ny: { zone: NY, now: "2026-10-01T06:00" },
	berlin: { zone: BERLIN, now: "2026-10-01T12:00" },
	tokyo: { zone: TOKYO, now: "2026-10-02T05:00" },
};

interface Golden {
	in: string;
	title: string;
	z?: ZoneKey;
	/** Local wall time of the reference instant in the zone. */
	now?: string;
	loc?: "en-GB";
	fb?: true;
	/** Shorthand: "2026-10-02" is a date, "2026-10-02T19:00" a datetime in the zone. */
	s?: string;
	d?: string;
	dur?: number;
	pri?: 1 | 2 | 3;
	cat?: string;
	tags?: string[];
	nt?: string[];
	note?: string;
	/** The typed repeat as a ruleKey (see helpers.ts); absent means no recurrence field. */
	rec?: string;
	chips?: string[];
	manual?: ParsedField[];
	dec?: SpanDecision[];
	block?: number;
}

const CAT = { inbox: "cat-inbox-0001", study: "cat-study-0002", deep: "cat-deepwork-0003", health: "cat-health-0004", cafe: "cat-cafe-0005" };
const U = "Use as date?";
const SUP = "Replaced by a later value";
const REC = "Recurrence not supported yet";

const CASES: Golden[] = [
	// --- plain titles and false positives ---
	{ in: "Buy milk", title: "Buy milk" },
	{ in: "May the 4th be with you", title: "May the 4th be with you" },
	{ in: "May review", title: "May review" },
	{ in: "Second draft", title: "Second draft" },
	{ in: "Buy 2 apples", title: "Buy 2 apples" },
	{ in: "Sun cream", title: "Sun cream", chips: [`suggestion|scheduled|Sun|d=2026-10-04|n=${U}`] },
	{ in: "Beach sat", title: "Beach sat", chips: [`suggestion|scheduled|sat|d=2026-10-03|n=${U}`] },
	{ in: "Pay may", title: "Pay may" },
	{ in: "Pay in may", title: "Pay in may", chips: [`suggestion|scheduled|may|d=2027-05-01|n=${U}`] },
	{ in: "Pay May 5", title: "Pay", s: "2027-05-05", chips: ["applied|scheduled|May 5"] },
	{ in: "Plan March", title: "Plan March", chips: [`suggestion|scheduled|March|d=2027-03-01|n=${U}`] },
	{ in: "Do it now", title: "Do it now", chips: [`suggestion|scheduled|now|d=2026-10-01T06:00|n=${U}`] },
	{ in: "Chapter 12 notes", title: "Chapter 12 notes" },
	{ in: "Feb 30 party", title: "Feb 30 party" },
	{ in: "File 2026-02-30", title: "File 2026-02-30" },
	{ in: "", title: "" },
	{ in: "   ", title: "   " },
	{ in: "Stand by", title: "Stand by" },
	{ in: "Sunday brunch", title: "brunch", s: "2026-10-04", chips: ["applied|scheduled|Sunday"] },
	{ in: "Gym 1h", title: "Gym 1h", chips: [`suggestion|scheduled|1h|d=2026-10-01T07:00|n=${U}`] },
	{ in: "Pay rent next month", title: "Pay rent next month", chips: [`suggestion|scheduled|next month|d=2026-11-01|n=${U}`] },
	{ in: "Taxes in a month", title: "Taxes in a month", chips: [`suggestion|scheduled|in a month|d=2026-11-01|n=${U}`] },
	{ in: "Sort this evening", title: "Sort this evening", chips: [`suggestion|scheduled|this evening|d=2026-10-01|n=${U}`] },
	{ in: "Finish by the end of the day", title: "Finish by the end of the day", chips: [`suggestion|scheduled|the day|d=2026-10-02|n=${U}`] },
	{ in: "Trip Oct 5 - Oct 9", title: "Trip Oct 5 - Oct 9", chips: [`suggestion|scheduled|Oct 5 - Oct 9|d=2026-10-05|n=${U}`] },
	{ in: "Finish by may", title: "Finish by may" },
	{ in: "Finish by in may", title: "Finish by in may", chips: [`suggestion|scheduled|may|d=2027-05-01|n=${U}`] },

	// --- relative dates (ny) ---
	{ in: "Buy milk tomorrow", title: "Buy milk", s: "2026-10-02", chips: ["applied|scheduled|tomorrow"] },
	{ in: "tomorrow", title: "tomorrow", fb: true, s: "2026-10-02", chips: ["applied|scheduled|tomorrow"] },
	{ in: "Call mom today", title: "Call mom", s: "2026-10-01", chips: ["applied|scheduled|today"] },
	// "tonight" is today at the evening time (default 20:00)
	{ in: "Call mom tonight", title: "Call mom", s: "2026-10-01T20:00", chips: ["applied|scheduled|tonight"] },
	{ in: "Call mom tonight", z: "berlin", title: "Call mom", s: "2026-10-01T20:00", chips: ["applied|scheduled|tonight"] },
	{ in: "Dentist in 3 days", title: "Dentist", s: "2026-10-04", chips: ["applied|scheduled|in 3 days"] },
	{ in: "Review next week", title: "Review", s: "2026-10-08", chips: ["applied|scheduled|next week"] },
	{ in: "Review in 2 weeks", title: "Review", s: "2026-10-15", chips: ["applied|scheduled|in 2 weeks"] },
	{ in: "Trip this weekend", title: "Trip", s: "2026-10-03", chips: ["applied|scheduled|this weekend"] },
	{ in: "Party next weekend", title: "Party", s: "2026-10-10", chips: ["applied|scheduled|next weekend"] },
	{ in: "Dinner the day after tomorrow", title: "Dinner", s: "2026-10-03", chips: ["applied|scheduled|the day after tomorrow"] },
	{ in: "Report yesterday", title: "Report", s: "2026-09-30", chips: ["applied|scheduled|yesterday"] },
	{ in: "Run tomorrow morning", title: "Run", s: "2026-10-02", chips: ["applied|scheduled|tomorrow morning"] },
	{ in: "Milk TOMORROW", title: "Milk", s: "2026-10-02", chips: ["applied|scheduled|TOMORROW"] },

	// --- weekdays (ny, Thu 2026-10-01) ---
	{ in: "Gym friday", title: "Gym", s: "2026-10-02", chips: ["applied|scheduled|friday"] },
	{ in: "Gym Fri", title: "Gym", s: "2026-10-02", chips: ["applied|scheduled|Fri"] },
	{ in: "Call next fri", title: "Call", s: "2026-10-09", chips: ["applied|scheduled|next fri"] },
	{ in: "Standup this monday", title: "Standup", s: "2026-10-05", chips: ["applied|scheduled|this monday"] },
	{ in: "Meet wed", title: "Meet", s: "2026-10-07", chips: ["applied|scheduled|wed"] },
	{ in: "Meet thursday", title: "Meet thursday", chips: ["choice|scheduled|thursday|a=Today/Next week"] },
	{ in: "Meet this thursday", title: "Meet this thursday", chips: ["choice|scheduled|this thursday|a=Today/Next week"] },
	{ in: "Meet next thursday", title: "Meet", s: "2026-10-08", chips: ["applied|scheduled|next thursday"] },
	{ in: "Call last friday", title: "Call last friday", chips: [`suggestion|scheduled|last friday|d=2026-09-25|n=${U}`] },
	{ in: "Friday at 5pm", title: "Friday at 5pm", fb: true, s: "2026-10-02T17:00", chips: ["applied|scheduled|Friday at 5pm"] },
	{ in: "Gym friday 5pm", title: "Gym", s: "2026-10-02T17:00", chips: ["applied|scheduled|friday 5pm"] },
	{ in: "Meet on friday", title: "Meet", s: "2026-10-02", chips: ["applied|scheduled|on friday"] },

	// --- explicit dates (ny) ---
	{ in: "Pay rent Oct 5", title: "Pay rent", s: "2026-10-05", chips: ["applied|scheduled|Oct 5"] },
	{ in: "Pay rent 5 Oct 2026", title: "Pay rent", s: "2026-10-05", chips: ["applied|scheduled|5 Oct 2026"] },
	{ in: "File 2026-10-05", title: "File", s: "2026-10-05", chips: ["applied|scheduled|2026-10-05"] },
	{ in: "Pay rent 10/5", title: "Pay rent", s: "2026-10-05", chips: ["applied|scheduled|10/5"] },
	{ in: "Pay rent 10/5", title: "Pay rent", loc: "en-GB", s: "2027-05-10", chips: ["applied|scheduled|10/5"] },
	{ in: "Pay 5/10", title: "Pay", s: "2027-05-10", chips: ["applied|scheduled|5/10"] },
	{ in: "Pay 5/10", title: "Pay", loc: "en-GB", s: "2026-10-05", chips: ["applied|scheduled|5/10"] },
	{ in: "Pay 10.5.2026", title: "Pay", s: "2026-10-05", chips: ["applied|scheduled|10.5.2026"] },
	{ in: "Pay Oct 5th", title: "Pay", s: "2026-10-05", chips: ["applied|scheduled|Oct 5th"] },
	{ in: "Pay oct. 5", title: "Pay", s: "2026-10-05", chips: ["applied|scheduled|oct. 5"] },
	{ in: "Trip 5 January", title: "Trip", s: "2027-01-05", chips: ["applied|scheduled|5 January"] },
	{ in: "Trip Jan 5 2027", title: "Trip", s: "2027-01-05", chips: ["applied|scheduled|Jan 5 2027"] },
	{ in: "Trip Oct 2", title: "Trip", s: "2026-10-02", chips: ["applied|scheduled|Oct 2"] },
	{ in: "Trip Sep 30", title: "Trip", s: "2027-09-30", chips: ["applied|scheduled|Sep 30"] },
	{ in: "Trip Dec 31 2026", title: "Trip", s: "2026-12-31", chips: ["applied|scheduled|Dec 31 2026"] },
	{ in: "Leap Feb 29 2028", title: "Leap", s: "2028-02-29", chips: ["applied|scheduled|Feb 29 2028"] },

	// --- times (ny) ---
	{ in: "Call at 7pm", title: "Call", s: "2026-10-01T19:00", chips: ["applied|scheduled|at 7pm"] },
	{ in: "Call 19:00", title: "Call", s: "2026-10-01T19:00", chips: ["applied|scheduled|19:00"] },
	{ in: "Call at 7:30pm", title: "Call", s: "2026-10-01T19:30", chips: ["applied|scheduled|at 7:30pm"] },
	{ in: "Call at 17:30", title: "Call", s: "2026-10-01T17:30", chips: ["applied|scheduled|at 17:30"] },
	{ in: "Call at 13", title: "Call", s: "2026-10-01T13:00", chips: ["applied|scheduled|at 13"] },
	{ in: "Lunch at noon", title: "Lunch", s: "2026-10-01T12:00", chips: ["applied|scheduled|at noon"] },
	{ in: "Lunch noon", title: "Lunch", s: "2026-10-01T12:00", chips: ["applied|scheduled|noon"] },
	{ in: "Lunch tomorrow at noon", title: "Lunch", s: "2026-10-02T12:00", chips: ["applied|scheduled|tomorrow at noon"] },
	{ in: "Call at midnight", title: "Call", s: "2026-10-02T00:00", chips: ["applied|scheduled|at midnight"] },
	{ in: "Call at 9am", title: "Call", s: "2026-10-01T09:00", chips: ["applied|scheduled|at 9am"] },
	{ in: "Call at 5am", title: "Call", s: "2026-10-02T05:00", chips: ["applied|scheduled|at 5am"] },
	{ in: "Run at 5", title: "Run at 5", chips: ["choice|scheduled|at 5|a=05:00/17:00"] },
	{ in: "Meet at 7", title: "Meet at 7", chips: ["choice|scheduled|at 7|a=07:00/19:00"] },
	{ in: "Meet at 7:30", title: "Meet at 7:30", chips: ["choice|scheduled|at 7:30|a=07:30/19:30"] },
	{ in: "Meet at 12", title: "Meet at 12", chips: ["choice|scheduled|at 12|a=12:00/00:00"] },
	{ in: "Meet tomorrow at 5", title: "Meet tomorrow at 5", chips: ["choice|scheduled|tomorrow at 5|a=05:00/17:00"] },
	{ in: "Call tomorrow at 7pm", title: "Call", s: "2026-10-02T19:00", chips: ["applied|scheduled|tomorrow at 7pm"] },
	{ in: "Call tomorrow 5pm", title: "Call", s: "2026-10-02T17:00", chips: ["applied|scheduled|tomorrow 5pm"] },
	{ in: "Call 5pm tomorrow", title: "Call", s: "2026-10-02T17:00", chips: ["applied|scheduled|5pm tomorrow"] },
	{ in: "Call tonight at 9", title: "Call", s: "2026-10-01T21:00", chips: ["applied|scheduled|tonight at 9"] },
	{ in: "Run tomorrow morning at 8", title: "Run", s: "2026-10-02T08:00", chips: ["applied|scheduled|tomorrow morning at 8"] },
	{ in: "Stretch in 2 hours", title: "Stretch", s: "2026-10-01T08:00", chips: ["applied|scheduled|in 2 hours"] },
	{ in: "Stretch in 45 minutes", title: "Stretch", s: "2026-10-01T06:45", chips: ["applied|scheduled|in 45 minutes"] },
	{ in: "Call Oct 5 at 3pm", title: "Call", s: "2026-10-05T15:00", chips: ["applied|scheduled|Oct 5 at 3pm"] },
	{ in: "Call Oct 5 7:15pm", title: "Call", s: "2026-10-05T19:15", chips: ["applied|scheduled|Oct 5 7:15pm"] },
	{ in: "Call Oct 5 at 3", title: "Call Oct 5 at 3", chips: ["choice|scheduled|Oct 5 at 3|a=03:00/15:00"] },
	{ in: "Call from 3pm to 5pm", title: "Call from 3pm to 5pm", chips: [`suggestion|scheduled|from 3pm to 5pm|d=2026-10-01T15:00|n=${U}`] },

	// --- deadlines (ny) ---
	{ in: "Report by Friday", title: "Report", d: "2026-10-02", chips: ["applied|deadline|by Friday"] },
	{ in: "Report by Oct 9", title: "Report", d: "2026-10-09", chips: ["applied|deadline|by Oct 9"] },
	{ in: "Report by tomorrow 5pm", title: "Report", d: "2026-10-02T17:00", chips: ["applied|deadline|by tomorrow 5pm"] },
	{ in: "Report by 5pm", title: "Report", d: "2026-10-01T17:00", chips: ["applied|deadline|by 5pm"] },
	{ in: "Report by noon", title: "Report", d: "2026-10-01T12:00", chips: ["applied|deadline|by noon"] },
	{ in: "Finish by sat", title: "Finish by sat", chips: [`suggestion|deadline|by sat|d=2026-10-03|n=${U}`] },
	{ in: "Report BY friday", title: "Report", d: "2026-10-02", chips: ["applied|deadline|BY friday"] },
	{ in: "Report due friday", title: "Report due", s: "2026-10-02", chips: ["applied|scheduled|friday"] },
	{ in: "Drive by tomorrow", title: "Drive", d: "2026-10-02", chips: ["applied|deadline|by tomorrow"] },
	{ in: "Essay tomorrow by Oct 9", title: "Essay", s: "2026-10-02", d: "2026-10-09", chips: ["applied|scheduled|tomorrow", "applied|deadline|by Oct 9"] },
	{ in: "Essay by Oct 9 tomorrow", title: "Essay", s: "2026-10-02", d: "2026-10-09", chips: ["applied|deadline|by Oct 9", "applied|scheduled|tomorrow"] },
	{ in: "Report by Friday by Oct 9", title: "Report by Friday", d: "2026-10-09", chips: [`superseded|deadline|by Friday|n=${SUP}`, "applied|deadline|by Oct 9"] },
	{ in: "Report by Mar 8 2:30am", title: "Report", z: "ny", now: "2026-03-01T12:00", d: "2026-03-08T03:30", chips: ["applied|deadline|by Mar 8 2:30am|w=dst-gap"] },

	// --- one value per field ---
	{ in: "Call tomorrow and also Oct 9", title: "Call tomorrow and also", s: "2026-10-09", chips: [`superseded|scheduled|tomorrow|n=${SUP}`, "applied|scheduled|Oct 9"] },
	{ in: "tomorrow #Study at 7pm", title: "tomorrow", cat: CAT.study, s: "2026-10-01T19:00", chips: [`superseded|scheduled|tomorrow|n=${SUP}`, "applied|category|#Study", "applied|scheduled|at 7pm"] },
	{ in: "a Oct 5 b Oct 6 c Oct 7", title: "a Oct 5 b Oct 6 c", s: "2026-10-07", chips: [`superseded|scheduled|Oct 5|n=${SUP}`, `superseded|scheduled|Oct 6|n=${SUP}`, "applied|scheduled|Oct 7"] },

	// --- durations ---
	{ in: "Study for 45m", title: "Study", dur: 45, chips: ["applied|duration|for 45m"] },
	{ in: "Study for 1h", title: "Study", dur: 60, chips: ["applied|duration|for 1h"] },
	{ in: "Study for 1h30m", title: "Study", dur: 90, chips: ["applied|duration|for 1h30m"] },
	{ in: "Study for 90 min", title: "Study", dur: 90, chips: ["applied|duration|for 90 min"] },
	{ in: "Study for 1.5 hours", title: "Study", dur: 90, chips: ["applied|duration|for 1.5 hours"] },
	{ in: "Study for 2 hrs", title: "Study", dur: 120, chips: ["applied|duration|for 2 hrs"] },
	{ in: "Study for 45 minutes", title: "Study", dur: 45, chips: ["applied|duration|for 45 minutes"] },
	{ in: "Study for 1 hour 30 minutes", title: "Study", dur: 90, chips: ["applied|duration|for 1 hour 30 minutes"] },
	{ in: "Study for 1h 30m", title: "Study", dur: 90, chips: ["applied|duration|for 1h 30m"] },
	{ in: "Study for 1 hour and 30 minutes", title: "Study", dur: 90, chips: ["applied|duration|for 1 hour and 30 minutes"] },
	{ in: "Study for 1h30", title: "Study", dur: 90, chips: ["applied|duration|for 1h30"] },
	{ in: "Study for 25min", title: "Study", dur: 25, chips: ["applied|duration|for 25min"] },
	{ in: "Study for 0.5h", title: "Study", dur: 30, chips: ["applied|duration|for 0.5h"] },
	{ in: "Study for an hour", title: "Study", dur: 60, chips: ["applied|duration|for an hour"] },
	{ in: "Study for half an hour", title: "Study", dur: 30, chips: ["applied|duration|for half an hour"] },
	{ in: "Study FOR 20 MIN", title: "Study", dur: 20, chips: ["applied|duration|FOR 20 MIN"] },
	{ in: "Study for 1440 min", title: "Study", dur: 1440, chips: ["applied|duration|for 1440 min"] },
	{ in: "Study for 24h", title: "Study", dur: 1440, chips: ["applied|duration|for 24h"] },
	{ in: "Study for 1m", title: "Study", dur: 1, chips: ["applied|duration|for 1m"] },
	{ in: "Study for 1441 min", title: "Study for 1441 min", chips: ["invalid|duration|for 1441 min|n=Duration must be 1 to 1440 minutes"] },
	{ in: "Study for 25h", title: "Study for 25h", chips: ["invalid|duration|for 25h|n=Duration must be 1 to 1440 minutes"] },
	{ in: "Study for 0m", title: "Study for 0m", chips: ["invalid|duration|for 0m|n=Duration must be 1 to 1440 minutes"] },
	{ in: "Study for 5 meetings", title: "Study for 5 meetings" },
	{ in: "Study for 2 days", title: "Study for 2 days" },
	{ in: "Study after 2 days", title: "Study", s: "2026-10-03", chips: ["applied|scheduled|after 2 days"] },
	{ in: "Study tomorrow at 7pm for 45m", title: "Study", s: "2026-10-02T19:00", dur: 45, chips: ["applied|scheduled|tomorrow at 7pm", "applied|duration|for 45m"] },
	{ in: "Study for 45m tomorrow at 7pm", title: "Study", s: "2026-10-02T19:00", dur: 45, chips: ["applied|duration|for 45m", "applied|scheduled|tomorrow at 7pm"] },
	{ in: "Study for 30m for 1h", title: "Study for 30m", dur: 60, chips: [`superseded|duration|for 30m|n=${SUP}`, "applied|duration|for 1h"] },

	// --- categories ---
	{ in: "Read #Study", title: "Read", cat: CAT.study, chips: ["applied|category|#Study"] },
	{ in: "Read #study", title: "Read", cat: CAT.study, chips: ["applied|category|#study"] },
	{ in: "Read #STUDY", title: "Read", cat: CAT.study, chips: ["applied|category|#STUDY"] },
	{ in: "#Study Read", title: "Read", cat: CAT.study, chips: ["applied|category|#Study"] },
	{ in: "Gym #health-care", title: "Gym", cat: CAT.health, chips: ["applied|category|#health-care"] },
	{ in: "Gym #health_care", title: "Gym", cat: CAT.health, chips: ["applied|category|#health_care"] },
	{ in: "Gym #healthcare", title: "Gym", cat: CAT.health, chips: ["applied|category|#healthcare"] },
	{ in: "Plan #deepwork", title: "Plan", cat: CAT.deep, chips: ["applied|category|#deepwork"] },
	{ in: "Plan #deep-work", title: "Plan", cat: CAT.deep, chips: ["applied|category|#deep-work"] },
	{ in: "Coffee #café", title: "Coffee", cat: CAT.cafe, chips: ["applied|category|#café"] },
	{ in: "Coffee #CAFÉ", title: "Coffee", cat: CAT.cafe, chips: ["applied|category|#CAFÉ"] },
	{ in: "Coffee #Cafe\u0301", title: "Coffee", cat: CAT.cafe, chips: ["applied|category|#Cafe\u0301"] },
	{ in: "Sort #Inbox", title: "Sort", cat: CAT.inbox, chips: ["applied|category|#Inbox"] },
	{ in: "Read #Foo", title: "Read #Foo", chips: ["unresolved|category|#Foo|n=No list named Foo"], block: 1 },
	{ in: "Read #Foo #Study", title: "Read #Foo", cat: CAT.study, chips: ["superseded|category|#Foo|n=Replaced by a later value", "applied|category|#Study"] },
	{ in: "Read #Study #Inbox", title: "Read #Study", cat: CAT.inbox, chips: [`superseded|category|#Study|n=${SUP}`, "applied|category|#Inbox"] },
	{ in: "Read #学习", title: "Read #学习", chips: ["unresolved|category|#学习|n=No list named 学习"], block: 1 },
	{ in: "Read # Study", title: "Read # Study" },
	{ in: "Fix bug #42", title: "Fix bug #42" },
	{ in: "Fix bug #42 tomorrow", title: "Fix bug #42", s: "2026-10-02", chips: ["applied|scheduled|tomorrow"] },
	{ in: "Meet @5", title: "Meet @5" },
	{ in: "Oct 5 at noon x", title: "x", s: "2026-10-05T12:00", chips: ["applied|scheduled|Oct 5 at noon"] },
	{ in: "Read C#", title: "Read C#" },
	{ in: "Read price#1", title: "Read price#1" },
	{ in: "Read (#Study)", title: "Read (#Study)" },
	{ in: "Read https://x.com/#frag", title: "Read https://x.com/#frag" },
	{ in: "Read #", title: "Read #" },

	// --- tags ---
	{ in: "Call @learning", title: "Call", tags: ["learning"], chips: ["applied|tag|@learning"] },
	{ in: "Call @Learning", title: "Call", tags: ["learning"], chips: ["applied|tag|@Learning"] },
	{ in: "Call @work/urgent", title: "Call", tags: ["work/urgent"], chips: ["applied|tag|@work/urgent"] },
	{ in: "Call @learning @home", title: "Call", tags: ["learning", "home"], chips: ["applied|tag|@learning", "applied|tag|@home"] },
	{ in: "Call @learning @LEARNING", title: "Call", tags: ["learning"], chips: ["applied|tag|@learning", "applied|tag|@LEARNING"] },
	{ in: "Call @newtag", title: "Call", nt: ["newtag"], chips: ["applied|tag|@newtag|new"] },
	{ in: "Call @NewTag", title: "Call", nt: ["NewTag"], chips: ["applied|tag|@NewTag|new"] },
	{ in: "Call @new @NEW", title: "Call", nt: ["new"], chips: ["applied|tag|@new|new", "applied|tag|@NEW|new"] },
	{ in: "Call @learning @newtag", title: "Call", tags: ["learning"], nt: ["newtag"], chips: ["applied|tag|@learning", "applied|tag|@newtag|new"] },
	{ in: "Call @学习", title: "Call", nt: ["学习"], chips: ["applied|tag|@学习|new"] },
	{ in: "Email a@b.com", title: "Email a@b.com" },
	{ in: "Email me@home.com tomorrow", title: "Email me@home.com", s: "2026-10-02", chips: ["applied|scheduled|tomorrow"] },
	{ in: "Call @ home", title: "Call @ home" },
	{ in: "Call @🎉", title: "Call @🎉" },
	{ in: "Call @", title: "Call @" },

	// --- notes ---
	{ in: "Read [[Python study plan]]", title: "Read", note: "Notes/Python study plan.md", chips: ["applied|note|[[Python study plan]]"] },
	{ in: "[[folder/Note]] review", title: "review", note: "folder/Note.md", chips: ["applied|note|[[folder/Note]]"] },
	{ in: "Read [[Big|the big one]]", title: "Read", note: "Notes/Big note.md", chips: ["applied|note|[[Big|the big one]]"] },
	{ in: "Read [[Big#Heading]]", title: "Read", note: "Notes/Big note.md", chips: ["applied|note|[[Big#Heading]]"] },
	{ in: "Read [[Plan]]", title: "Read [[Plan]]", chips: ["collision|note|[[Plan]]|c=Projects/Plan.md+Archive/Plan.md|n=2 matches"] },
	{ in: "Read [[Nope]]", title: "Read [[Nope]]", chips: ["missing|note|[[Nope]]|n=No note named Nope"] },
	{ in: "Read [[Plan]] [[Big]]", title: "Read [[Plan]]", note: "Notes/Big note.md", chips: ["collision|note|[[Plan]]|c=Projects/Plan.md+Archive/Plan.md|n=2 matches", "applied|note|[[Big]]"] },
	{ in: "[[Python study plan]] and [[Big]]", title: "[[Python study plan]] and", note: "Notes/Big note.md", chips: [`superseded|note|[[Python study plan]]|n=${SUP}`, "applied|note|[[Big]]"] },
	{ in: "Read [[ ]]", title: "Read [[ ]]" },
	{ in: "Read [[unclosed", title: "Read [[unclosed" },
	{ in: "Read [[Big]]tomorrow", title: "Read", note: "Notes/Big note.md", s: "2026-10-02", chips: ["applied|note|[[Big]]", "applied|scheduled|tomorrow"] },
	{ in: "[[Big for 5m]]", title: "[[Big for 5m]]", chips: ["missing|note|[[Big for 5m]]|n=No note named Big for 5m"] },
	{ in: "[[Plan #Study]] tomorrow", title: "[[Plan #Study]]", s: "2026-10-02", chips: ["collision|note|[[Plan #Study]]|c=Projects/Plan.md+Archive/Plan.md|n=2 matches", "applied|scheduled|tomorrow"] },

	// --- recurrence: `every …` becomes a rule and leaves the title ---
	{ in: "Gym every monday", title: "Gym", rec: "weekly:MO", chips: ["applied|recurrence|every monday|r=weekly:MO"] },
	{ in: "Gym Every Monday", title: "Gym", rec: "weekly:MO", chips: ["applied|recurrence|Every Monday|r=weekly:MO"] },
	{ in: "Gym every day", title: "Gym", rec: "daily", chips: ["applied|recurrence|every day|r=daily"] },
	{ in: "Gym EVERY DAY", title: "Gym", rec: "daily", chips: ["applied|recurrence|EVERY DAY|r=daily"] },
	{ in: "Gym every weekday", title: "Gym", rec: "weekly:MO,TU,WE,TH,FR", chips: ["applied|recurrence|every weekday|r=weekly:MO,TU,WE,TH,FR"] },
	{ in: "Gym every weekend", title: "Gym", rec: "weekly:SA,SU", chips: ["applied|recurrence|every weekend|r=weekly:SA,SU"] },
	{ in: "Gym every week", title: "Gym", rec: "weekly", chips: ["applied|recurrence|every week|r=weekly"] },
	{ in: "Gym every month", title: "Gym", rec: "monthly", chips: ["applied|recurrence|every month|r=monthly"] },
	{ in: "Gym every year", title: "Gym", rec: "yearly", chips: ["applied|recurrence|every year|r=yearly"] },
	{ in: "Gym every other weekday", title: "Gym every other weekday", chips: [`unsupported|recurrence|every other weekday|n=${REC}`] },
	{ in: "Gym every 2 weekdays", title: "Gym every 2 weekdays", chips: [`unsupported|recurrence|every 2 weekdays|n=${REC}`] },
	{ in: "Gym every 2 years", title: "Gym", rec: "yearly/2", chips: ["applied|recurrence|every 2 years|r=yearly/2"] },
	{ in: "Gym every other day", title: "Gym", rec: "daily/2", chips: ["applied|recurrence|every other day|r=daily/2"] },
	{ in: "Gym every other week", title: "Gym", rec: "weekly/2", chips: ["applied|recurrence|every other week|r=weekly/2"] },
	{ in: "Gym every other month", title: "Gym", rec: "monthly/2", chips: ["applied|recurrence|every other month|r=monthly/2"] },
	{ in: "Gym every other friday", title: "Gym", rec: "weekly/2:FR", chips: ["applied|recurrence|every other friday|r=weekly/2:FR"] },
	{ in: "Gym every 2 days", title: "Gym", rec: "daily/2", chips: ["applied|recurrence|every 2 days|r=daily/2"] },
	{ in: "Gym every 1 day", title: "Gym", rec: "daily", chips: ["applied|recurrence|every 1 day|r=daily"] },
	{ in: "Gym every 3 weeks", title: "Gym", rec: "weekly/3", chips: ["applied|recurrence|every 3 weeks|r=weekly/3"] },
	{ in: "Gym every 6 months", title: "Gym", rec: "monthly/6", chips: ["applied|recurrence|every 6 months|r=monthly/6"] },
	{ in: "Gym every 1 month", title: "Gym", rec: "monthly", chips: ["applied|recurrence|every 1 month|r=monthly"] },
	{ in: "Gym every 0 days", title: "Gym every 0 days", chips: [`unsupported|recurrence|every 0 days|n=${REC}`] },
	{ in: "Gym every 1000 days", title: "Gym every 1000 days", chips: [`unsupported|recurrence|every 1000 days|n=${REC}`] },
	{ in: "Gym every mon, wed", title: "Gym", rec: "weekly:MO,WE", chips: ["applied|recurrence|every mon, wed|r=weekly:MO,WE"] },
	{ in: "Gym every mon, wed and fri", title: "Gym", rec: "weekly:MO,WE,FR", chips: ["applied|recurrence|every mon, wed and fri|r=weekly:MO,WE,FR"] },
	{ in: "Gym every fri and mon", title: "Gym", rec: "weekly:MO,FR", chips: ["applied|recurrence|every fri and mon|r=weekly:MO,FR"] },
	{ in: "Gym every Tuesday & Thursday", title: "Gym", rec: "weekly:TU,TH", chips: ["applied|recurrence|every Tuesday & Thursday|r=weekly:TU,TH"] },
	{ in: "Gym every sat, sun", title: "Gym", rec: "weekly:SA,SU", chips: ["applied|recurrence|every sat, sun|r=weekly:SA,SU"] },
	{ in: "Gym every month on the 15th", title: "Gym", rec: "monthly:d15", chips: ["applied|recurrence|every month on the 15th|r=monthly:d15"] },
	{ in: "Gym every month on the 1st", title: "Gym", rec: "monthly:d1", chips: ["applied|recurrence|every month on the 1st|r=monthly:d1"] },
	{ in: "Gym every month on day 15", title: "Gym", rec: "monthly:d15", chips: ["applied|recurrence|every month on day 15|r=monthly:d15"] },
	{ in: "Gym every month on the 31st", title: "Gym", rec: "monthly:d31", chips: ["applied|recurrence|every month on the 31st|r=monthly:d31"] },
	{ in: "Gym every month on the 32nd", title: "Gym every month on the 32nd", chips: [`unsupported|recurrence|every month on the 32nd|n=${REC}`] },
	{ in: "Gym every month on the 0th", title: "Gym every month on the 0th", chips: [`unsupported|recurrence|every month on the 0th|n=${REC}`] },
	// "on 5pm" is a time, not a day of the month: the repeat stops at "month"
	{ in: "Gym every month on 5pm", title: "Gym", s: "2026-10-01T17:00", rec: "monthly", chips: ["applied|recurrence|every month|r=monthly", "applied|scheduled|on 5pm"] },
	{ in: "Gym every 3 months on the 5th", title: "Gym", rec: "monthly/3:d5", chips: ["applied|recurrence|every 3 months on the 5th|r=monthly/3:d5"] },
	{ in: "Gym every other month on day 20", title: "Gym", rec: "monthly/2:d20", chips: ["applied|recurrence|every other month on day 20|r=monthly/2:d20"] },
	{ in: "Gym every last friday", title: "Gym", rec: "monthly:FR#-1", chips: ["applied|recurrence|every last friday|r=monthly:FR#-1"] },
	{ in: "Gym every first monday", title: "Gym", rec: "monthly:MO#1", chips: ["applied|recurrence|every first monday|r=monthly:MO#1"] },
	{ in: "Gym every second tuesday", title: "Gym", rec: "monthly:TU#2", chips: ["applied|recurrence|every second tuesday|r=monthly:TU#2"] },
	{ in: "Gym every third wed", title: "Gym", rec: "monthly:WE#3", chips: ["applied|recurrence|every third wed|r=monthly:WE#3"] },
	{ in: "Gym every fourth thursday", title: "Gym", rec: "monthly:TH#4", chips: ["applied|recurrence|every fourth thursday|r=monthly:TH#4"] },
	{ in: "Gym every 2nd friday of the month", title: "Gym", rec: "monthly:FR#2", chips: ["applied|recurrence|every 2nd friday of the month|r=monthly:FR#2"] },
	{ in: "Gym every last day of the month", title: "Gym", rec: "monthly:last", chips: ["applied|recurrence|every last day of the month|r=monthly:last"] },
	{ in: "Gym every last day of month", title: "Gym", rec: "monthly:last", chips: ["applied|recurrence|every last day of month|r=monthly:last"] },
	{ in: "Gym every third", title: "Gym every third", chips: [`unsupported|recurrence|every third|n=${REC}`] },
	{ in: "Gym every last", title: "Gym every last", chips: [`unsupported|recurrence|every last|n=${REC}`] },
	// a time: certain forms apply, a bare hour 1-12 is a suggestion (the user decides, like "at 5")
	{ in: "Gym every monday at 9pm", title: "Gym", rec: "weekly:MO@21:00", chips: ["applied|recurrence|every monday at 9pm|r=weekly:MO@21:00"] },
	{ in: "Gym every monday at 9am", title: "Gym", rec: "weekly:MO@09:00", chips: ["applied|recurrence|every monday at 9am|r=weekly:MO@09:00"] },
	{ in: "Gym every monday at 9", title: "Gym every monday at 9", chips: ["choice|recurrence|every monday at 9|a=09:00/21:00"], block: 1 },
	{ in: "Gym every monday at 9", dec: [{ span: { start: 4, end: 21 }, text: "every monday at 9", kind: "rule", rule: weeklyMondayAt("21:00") }], title: "Gym", rec: "weekly:MO@21:00", chips: ["applied|recurrence|every monday at 9|r=weekly:MO@21:00"] },
	{ in: "Gym every monday at 9", dec: [{ span: { start: 4, end: 21 }, text: "every monday at 9", kind: "rule", rule: weeklyMondayAt("09:00") }], title: "Gym", rec: "weekly:MO@09:00", chips: ["applied|recurrence|every monday at 9|r=weekly:MO@09:00"] },
	{ in: "Gym every day at 12", title: "Gym every day at 12", chips: ["choice|recurrence|every day at 12|a=12:00/00:00"], block: 1 },
	{ in: "Gym every day at 5", title: "Gym every day at 5", chips: ["choice|recurrence|every day at 5|a=05:00/17:00"], block: 1 },
	{ in: "Gym every day at 17:30", title: "Gym", rec: "daily@17:30", chips: ["applied|recurrence|every day at 17:30|r=daily@17:30"] },
	{ in: "Gym every day at 13", title: "Gym", rec: "daily@13:00", chips: ["applied|recurrence|every day at 13|r=daily@13:00"] },
	{ in: "Gym every day at 09:30", title: "Gym", rec: "daily@09:30", chips: ["applied|recurrence|every day at 09:30|r=daily@09:30"] },
	{ in: "Gym every day at 9:30", title: "Gym every day at 9:30", chips: ["choice|recurrence|every day at 9:30|a=09:30/21:30"], block: 1 },
	{ in: "Gym every day at noon", title: "Gym", rec: "daily@12:00", chips: ["applied|recurrence|every day at noon|r=daily@12:00"] },
	{ in: "Gym every day at midnight", title: "Gym", rec: "daily@00:00", chips: ["applied|recurrence|every day at midnight|r=daily@00:00"] },
	{ in: "Gym every day at 12am", title: "Gym", rec: "daily@00:00", chips: ["applied|recurrence|every day at 12am|r=daily@00:00"] },
	{ in: "Gym every day at 12pm", title: "Gym", rec: "daily@12:00", chips: ["applied|recurrence|every day at 12pm|r=daily@12:00"] },
	{ in: "Gym every day at 7:15 p.m.", title: "Gym", rec: "daily@19:15", chips: ["applied|recurrence|every day at 7:15 p.m.|r=daily@19:15"] },
	{ in: "Gym every day at 13pm", title: "Gym every day at 13pm", chips: [`unsupported|recurrence|every day at 13pm|n=${REC}`] },
	{ in: "Gym every day at 25", title: "Gym every day at 25", chips: [`unsupported|recurrence|every day at 25|n=${REC}`] },
	{ in: "Gym every month on the 15th at 8am", title: "Gym", rec: "monthly:d15@08:00", chips: ["applied|recurrence|every month on the 15th at 8am|r=monthly:d15@08:00"] },
	{ in: "Gym every last friday at 6pm", title: "Gym", rec: "monthly:FR#-1@18:00", chips: ["applied|recurrence|every last friday at 6pm|r=monthly:FR#-1@18:00"] },
	{ in: "Gym every weekday at 7:30am", z: "berlin", title: "Gym", rec: "weekly:MO,TU,WE,TH,FR@07:30", chips: ["applied|recurrence|every weekday at 7:30am|r=weekly:MO,TU,WE,TH,FR@07:30"] },
	{ in: "Gym every weekday at 7:30am", z: "tokyo", title: "Gym", rec: "weekly:MO,TU,WE,TH,FR@07:30", chips: ["applied|recurrence|every weekday at 7:30am|r=weekly:MO,TU,WE,TH,FR@07:30"] },
	// next to the other tokens
	{ in: "Standup every day tomorrow", title: "Standup", s: "2026-10-02", rec: "daily", chips: ["applied|recurrence|every day|r=daily", "applied|scheduled|tomorrow"] },
	{ in: "Gym every monday for 30m", title: "Gym", dur: 30, rec: "weekly:MO", chips: ["applied|recurrence|every monday|r=weekly:MO", "applied|duration|for 30m"] },
	{ in: "Pay rent every month on the 1st !1 #Study", title: "Pay rent", pri: 1, cat: CAT.study, rec: "monthly:d1", chips: ["applied|recurrence|every month on the 1st|r=monthly:d1", "applied|priority|!1", "applied|category|#Study"] },
	{ in: "Gym every monday friday", title: "Gym", rec: "weekly:MO,FR", chips: ["applied|recurrence|every monday friday|r=weekly:MO,FR"] },
	// Two typed repeats are several patterns: not supported (Repeating tasks rule 19).
	{ in: "Gym every day every week", title: "Gym every day every week", chips: [`unsupported|recurrence|every day|n=${REC}`, `unsupported|recurrence|every week|n=${REC}`] },
	{ in: "Everyone tomorrow", title: "Everyone", s: "2026-10-02", chips: ["applied|scheduled|tomorrow"] },
	{ in: "Every", title: "Every" },
	{ in: "Gym every friday", z: "tokyo", title: "Gym", rec: "weekly:FR", chips: ["applied|recurrence|every friday|r=weekly:FR"] },
	{ in: "Gym every friday", z: "berlin", title: "Gym", rec: "weekly:FR", chips: ["applied|recurrence|every friday|r=weekly:FR"] },
	{ in: "Gym every day", z: "berlin", title: "Gym", rec: "daily", chips: ["applied|recurrence|every day|r=daily"] },
	{ in: "Gym every month on the 15th", z: "tokyo", title: "Gym", rec: "monthly:d15", chips: ["applied|recurrence|every month on the 15th|r=monthly:d15"] },
	{ in: "Gym every month on the 15th", z: "berlin", title: "Gym", rec: "monthly:d15", chips: ["applied|recurrence|every month on the 15th|r=monthly:d15"] },
	{ in: "Gym every last friday at 6pm", z: "tokyo", title: "Gym", rec: "monthly:FR#-1@18:00", chips: ["applied|recurrence|every last friday at 6pm|r=monthly:FR#-1@18:00"] },
	{ in: "Gym every other friday at 6pm", z: "berlin", title: "Gym", rec: "weekly/2:FR@18:00", chips: ["applied|recurrence|every other friday at 6pm|r=weekly/2:FR@18:00"] },
	// decisions and manual precedence work on the repeat like on every other chip
	{ in: "Gym every monday", dec: [{ span: { start: 4, end: 16 }, text: "every monday", kind: "literal" }], title: "Gym every monday" },
	{ in: "Gym every monday", manual: ["recurrence"], title: "Gym every monday", chips: ["suggestion|recurrence|every monday|r=weekly:MO|n=Replace repeat?"] },
	{ in: "Gym every monday", manual: ["recurrence"], dec: [{ span: { start: 4, end: 16 }, text: "every monday", kind: "accept" }], title: "Gym", rec: "weekly:MO", chips: ["applied|recurrence|every monday|r=weekly:MO"] },

	// --- DST ---
	{ in: "Standup Mar 8 2:30am", z: "ny", now: "2026-03-01T12:00", title: "Standup", s: "2026-03-08T03:30", chips: ["applied|scheduled|Mar 8 2:30am|w=dst-gap"] },
	{ in: "Standup Mar 8 at 2:00am", z: "ny", now: "2026-03-01T12:00", title: "Standup", s: "2026-03-08T03:00", chips: ["applied|scheduled|Mar 8 at 2:00am|w=dst-gap"] },
	{ in: "Standup Mar 8 at 3:30am", z: "ny", now: "2026-03-01T12:00", title: "Standup", s: "2026-03-08T03:30", chips: ["applied|scheduled|Mar 8 at 3:30am"] },
	{ in: "Standup Mar 8 at 1:59am", z: "ny", now: "2026-03-01T12:00", title: "Standup", s: "2026-03-08T01:59", chips: ["applied|scheduled|Mar 8 at 1:59am"] },
	{ in: "Standup Mar 8 at 2:30", z: "ny", now: "2026-03-01T12:00", title: "Standup Mar 8 at 2:30", chips: ["choice|scheduled|Mar 8 at 2:30|a=02:30/14:30"] },
	{ in: "Standup Nov 1 1:30am", z: "ny", now: "2026-10-25T12:00", title: "Standup", s: "2026-11-01T01:30", chips: ["applied|scheduled|Nov 1 1:30am|w=dst-ambiguous"] },
	{ in: "Standup Nov 1 at 1:00am", z: "ny", now: "2026-10-25T12:00", title: "Standup", s: "2026-11-01T01:00", chips: ["applied|scheduled|Nov 1 at 1:00am|w=dst-ambiguous"] },
	{ in: "Standup Nov 1 at 2:00am", z: "ny", now: "2026-10-25T12:00", title: "Standup", s: "2026-11-01T02:00", chips: ["applied|scheduled|Nov 1 at 2:00am"] },
	{ in: "Standup Nov 1 at 12:59am", z: "ny", now: "2026-10-25T12:00", title: "Standup", s: "2026-11-01T00:59", chips: ["applied|scheduled|Nov 1 at 12:59am"] },
	{ in: "Standup Nov 1 at 1:30", z: "ny", now: "2026-10-25T12:00", title: "Standup Nov 1 at 1:30", chips: ["choice|scheduled|Nov 1 at 1:30|a=01:30/13:30"] },
	{ in: "Standup Mar 8 at 02:30", z: "ny", now: "2026-03-01T12:00", title: "Standup", s: "2026-03-08T03:30", chips: ["applied|scheduled|Mar 8 at 02:30|w=dst-gap"] },
	{ in: "Standup 2026-03-08 02:30", z: "ny", now: "2026-03-01T12:00", title: "Standup", s: "2026-03-08T03:30", chips: ["applied|scheduled|2026-03-08 02:30|w=dst-gap"] },
	{ in: "Standup Mar 29 2:30am", z: "berlin", now: "2026-03-20T12:00", title: "Standup", s: "2026-03-29T03:30", chips: ["applied|scheduled|Mar 29 2:30am|w=dst-gap"] },
	{ in: "Standup 29 Mar at 2:15am", z: "berlin", now: "2026-03-20T12:00", title: "Standup", s: "2026-03-29T03:15", chips: ["applied|scheduled|29 Mar at 2:15am|w=dst-gap"] },
	{ in: "Standup 29/3 at 2:30am", z: "berlin", loc: "en-GB", now: "2026-03-20T12:00", title: "Standup", s: "2026-03-29T03:30", chips: ["applied|scheduled|29/3 at 2:30am|w=dst-gap"] },
	{ in: "Standup Mar 29 at 3:00am", z: "berlin", now: "2026-03-20T12:00", title: "Standup", s: "2026-03-29T03:00", chips: ["applied|scheduled|Mar 29 at 3:00am"] },
	{ in: "Standup Mar 29 at 1:59am", z: "berlin", now: "2026-03-20T12:00", title: "Standup", s: "2026-03-29T01:59", chips: ["applied|scheduled|Mar 29 at 1:59am"] },
	{ in: "Standup Oct 25 2:30am", z: "berlin", now: "2026-10-20T12:00", title: "Standup", s: "2026-10-25T02:30", chips: ["applied|scheduled|Oct 25 2:30am|w=dst-ambiguous"] },
	{ in: "Standup 25 Oct at 2:00am", z: "berlin", now: "2026-10-20T12:00", title: "Standup", s: "2026-10-25T02:00", chips: ["applied|scheduled|25 Oct at 2:00am|w=dst-ambiguous"] },
	{ in: "Standup Oct 25 at 3:00am", z: "berlin", now: "2026-10-20T12:00", title: "Standup", s: "2026-10-25T03:00", chips: ["applied|scheduled|Oct 25 at 3:00am"] },
	{ in: "Standup Oct 25 at 1:30am", z: "berlin", now: "2026-10-20T12:00", title: "Standup", s: "2026-10-25T01:30", chips: ["applied|scheduled|Oct 25 at 1:30am"] },
	{ in: "Report by Oct 25 2:30am", z: "berlin", now: "2026-10-20T12:00", title: "Report", d: "2026-10-25T02:30", chips: ["applied|deadline|by Oct 25 2:30am|w=dst-ambiguous"] },
	{ in: "Standup Mar 28 2:30am", z: "berlin", now: "2026-03-20T12:00", title: "Standup", s: "2026-03-28T02:30", chips: ["applied|scheduled|Mar 28 2:30am"] },
	{ in: "Standup Mar 8 2:30am", z: "tokyo", now: "2026-03-01T12:00", title: "Standup", s: "2026-03-08T02:30", chips: ["applied|scheduled|Mar 8 2:30am"] },

	// --- zones (the reference instant differs from the zone date in tokyo) ---
	{ in: "Meet today", z: "tokyo", title: "Meet", s: "2026-10-02", chips: ["applied|scheduled|today"] },
	{ in: "Meet tomorrow", z: "tokyo", title: "Meet", s: "2026-10-03", chips: ["applied|scheduled|tomorrow"] },
	{ in: "Meet yesterday", z: "tokyo", title: "Meet", s: "2026-10-01", chips: ["applied|scheduled|yesterday"] },
	{ in: "Meet at 7am", z: "tokyo", title: "Meet", s: "2026-10-02T07:00", chips: ["applied|scheduled|at 7am"] },
	{ in: "Meet at 3am", z: "tokyo", title: "Meet", s: "2026-10-03T03:00", chips: ["applied|scheduled|at 3am"] },
	{ in: "Meet at 7", z: "tokyo", title: "Meet at 7", chips: ["choice|scheduled|at 7|a=07:00/19:00"] },
	{ in: "Meet at 4", z: "tokyo", title: "Meet at 4", chips: ["choice|scheduled|at 4|a=04:00/16:00"] },
	{ in: "Meet tomorrow at 7pm", z: "tokyo", title: "Meet", s: "2026-10-03T19:00", chips: ["applied|scheduled|tomorrow at 7pm"] },
	{ in: "Meet monday", z: "tokyo", title: "Meet", s: "2026-10-05", chips: ["applied|scheduled|monday"] },
	{ in: "Meet next friday", z: "tokyo", title: "Meet", s: "2026-10-09", chips: ["applied|scheduled|next friday"] },
	{ in: "Meet in 2 hours", z: "tokyo", title: "Meet", s: "2026-10-02T07:00", chips: ["applied|scheduled|in 2 hours"] },
	{ in: "Report today at 6pm", z: "tokyo", title: "Report", s: "2026-10-02T18:00", chips: ["applied|scheduled|today at 6pm"] },
	{ in: "Meet tomorrow at 7pm", z: "berlin", title: "Meet", s: "2026-10-02T19:00", chips: ["applied|scheduled|tomorrow at 7pm"] },
	{ in: "Meet Oct 5 18:00", z: "berlin", title: "Meet", s: "2026-10-05T18:00", chips: ["applied|scheduled|Oct 5 18:00"] },
	{ in: "Meet at 14:30", z: "berlin", title: "Meet", s: "2026-10-01T14:30", chips: ["applied|scheduled|at 14:30"] },
	{ in: "Meet at 11:30", z: "berlin", title: "Meet at 11:30", chips: ["choice|scheduled|at 11:30|a=11:30/23:30"] },
	{ in: "Meet at 11:30am", z: "berlin", title: "Meet", s: "2026-10-02T11:30", chips: ["applied|scheduled|at 11:30am"] },
	{ in: "Meet at 3", z: "berlin", title: "Meet at 3", chips: ["choice|scheduled|at 3|a=03:00/15:00"] },
	{ in: "Meet 5/10", z: "berlin", loc: "en-GB", title: "Meet", s: "2026-10-05", chips: ["applied|scheduled|5/10"] },
	{ in: "Meet 10/5", z: "berlin", loc: "en-GB", title: "Meet", s: "2027-05-10", chips: ["applied|scheduled|10/5"] },
	{ in: "Meet 10/5", z: "berlin", title: "Meet", s: "2026-10-05", chips: ["applied|scheduled|10/5"] },
	{ in: "Meet 5 Oct", z: "berlin", loc: "en-GB", title: "Meet", s: "2026-10-05", chips: ["applied|scheduled|5 Oct"] },
	{ in: "Report by friday", z: "berlin", title: "Report", d: "2026-10-02", chips: ["applied|deadline|by friday"] },
	{ in: "Meet friday", z: "tokyo", title: "Meet friday", chips: ["choice|scheduled|friday|a=Today/Next week"] },
	{ in: "Report by friday", z: "tokyo", title: "Report by friday", chips: ["choice|deadline|by friday|a=Today/Next week"] },
	{ in: "Meet fri", z: "tokyo", title: "Meet fri", chips: ["choice|scheduled|fri|a=Today/Next week"] },
	{ in: "Meet friday at 5pm", z: "tokyo", title: "Meet", s: "2026-10-02T17:00", chips: ["applied|scheduled|friday at 5pm"] },

	// --- manual precedence ---
	{ in: "Call friday", manual: ["scheduled"], title: "Call friday", chips: ["suggestion|scheduled|friday|d=2026-10-02|n=Replace date?"] },
	{ in: "Call tomorrow at 7pm", manual: ["scheduled"], title: "Call tomorrow at 7pm", chips: ["suggestion|scheduled|tomorrow at 7pm|d=2026-10-02T19:00|n=Replace date?"] },
	{ in: "Call by friday", manual: ["deadline"], title: "Call by friday", chips: ["suggestion|deadline|by friday|d=2026-10-02|n=Replace deadline?"] },
	{ in: "Call by friday", manual: ["scheduled"], title: "Call", d: "2026-10-02", chips: ["applied|deadline|by friday"] },
	{ in: "Call for 45m", manual: ["duration"], title: "Call for 45m", chips: ["suggestion|duration|for 45m|n=Replace duration?"] },
	{ in: "Call #Study", manual: ["category"], title: "Call #Study", chips: ["suggestion|category|#Study|n=Replace list?"] },
	{ in: "Call [[Big]]", manual: ["note"], title: "Call [[Big]]", chips: ["suggestion|note|[[Big]]|n=Replace note?"] },
	{ in: "Call @home", manual: ["tags"], title: "Call", tags: ["home"], chips: ["applied|tag|@home"] },
	{ in: "Call friday #Study", manual: ["scheduled"], title: "Call friday", cat: CAT.study, chips: ["suggestion|scheduled|friday|d=2026-10-02|n=Replace date?", "applied|category|#Study"] },
	{ in: "Call sun", manual: ["scheduled"], title: "Call sun", chips: ["suggestion|scheduled|sun|d=2026-10-04|n=Replace date?"] },
	{ in: "Call thursday", manual: ["scheduled"], title: "Call thursday", chips: ["choice|scheduled|thursday|a=Today/Next week|n=Replace date?"] },
	{ in: "Call tomorrow", manual: ["deadline", "duration", "category", "note", "tags"], title: "Call", s: "2026-10-02", chips: ["applied|scheduled|tomorrow"] },

	// --- decisions ---
	{ in: "Buy milk tomorrow", dec: [{ span: { start: 9, end: 17 }, text: "tomorrow", kind: "literal" }], title: "Buy milk tomorrow" },
	{ in: "Buy milk tomorrow at 7pm", dec: [{ span: { start: 9, end: 17 }, text: "tomorrow", kind: "literal" }], title: "Buy milk tomorrow", s: "2026-10-01T19:00", chips: ["applied|scheduled|at 7pm"] },
	{ in: "Buy milk tomorrow", dec: [{ span: { start: 9, end: 17 }, text: "today", kind: "literal" }], title: "Buy milk", s: "2026-10-02", chips: ["applied|scheduled|tomorrow"] },
	{ in: "Sun cream", dec: [{ span: { start: 0, end: 3 }, text: "Sun", kind: "accept" }], title: "cream", s: "2026-10-04", chips: ["applied|scheduled|Sun"] },
	{ in: "Run at 5", dec: [{ span: { start: 4, end: 8 }, text: "at 5", kind: "date", value: { kind: "datetime", local: "2026-10-01T17:00", tz: NY } }], title: "Run", s: "2026-10-01T17:00", chips: ["applied|scheduled|at 5"] },
	{ in: "Call friday", manual: ["scheduled"], dec: [{ span: { start: 5, end: 11 }, text: "friday", kind: "accept" }], title: "Call", s: "2026-10-02", chips: ["applied|scheduled|friday"] },
	{ in: "Read #Foo", dec: [{ span: { start: 5, end: 9 }, text: "#Foo", kind: "category", categoryId: CAT.deep }], title: "Read", cat: CAT.deep, chips: ["applied|category|#Foo"] },
	{ in: "Read #Deep work", dec: [{ span: { start: 5, end: 15 }, text: "#Deep work", kind: "category", categoryId: CAT.deep }], title: "Read", cat: CAT.deep, chips: ["applied|category|#Deep work"] },
	{ in: "Read [[Plan]]", dec: [{ span: { start: 5, end: 13 }, text: "[[Plan]]", kind: "note", path: "Archive/Plan.md" }], title: "Read", note: "Archive/Plan.md", chips: ["applied|note|[[Plan]]"] },
	{ in: "Call @lrn", dec: [{ span: { start: 5, end: 9 }, text: "@lrn", kind: "tag", key: "learning" }], title: "Call", tags: ["learning"], chips: ["applied|tag|@lrn"] },

	// --- unicode and layout ---
	{ in: "Café ☕ tomorrow", title: "Café ☕", s: "2026-10-02", chips: ["applied|scheduled|tomorrow"] },
	{ in: "明日 tomorrow", title: "明日", s: "2026-10-02", chips: ["applied|scheduled|tomorrow"] },
	{ in: "买牛奶 #Study", title: "买牛奶", cat: CAT.study, chips: ["applied|category|#Study"] },
	{ in: "😀 tomorrow", title: "😀", s: "2026-10-02", chips: ["applied|scheduled|tomorrow"] },
	{ in: "🎉 party tomorrow 🎉", title: "🎉 party 🎉", s: "2026-10-02", chips: ["applied|scheduled|tomorrow"] },
	{ in: "  Buy   milk   tomorrow  ", title: "Buy milk", s: "2026-10-02", chips: ["applied|scheduled|tomorrow"] },
	{ in: "Buy\tmilk\ntomorrow", title: "Buy milk", s: "2026-10-02", chips: ["applied|scheduled|tomorrow"] },
	// A lone comma next to a removed span goes with it (Repeating tasks rule 19).
	{ in: "Buy milk, tomorrow", title: "Buy milk", s: "2026-10-02", chips: ["applied|scheduled|tomorrow"] },
	{ in: "tomorrow #Study", title: "tomorrow #Study", fb: true, s: "2026-10-02", cat: CAT.study, chips: ["applied|scheduled|tomorrow", "applied|category|#Study"] },
	{ in: "#Study @learning [[Big]] tomorrow at 7pm for 45m", title: "#Study @learning [[Big]] tomorrow at 7pm for 45m", fb: true, s: "2026-10-02T19:00", dur: 45, cat: CAT.study, tags: ["learning"], note: "Notes/Big note.md", chips: ["applied|category|#Study", "applied|tag|@learning", "applied|note|[[Big]]", "applied|scheduled|tomorrow at 7pm", "applied|duration|for 45m"] },
	// --- priority: !1 !2 !3 !high !medium !low ---
	{ in: "Pay rent !1", title: "Pay rent", pri: 1, chips: ["applied|priority|!1"] },
	{ in: "!2 Pay rent", title: "Pay rent", pri: 2, chips: ["applied|priority|!2"] },
	{ in: "Pay !3 rent", title: "Pay rent", pri: 3, chips: ["applied|priority|!3"] },
	{ in: "Pay rent !high", title: "Pay rent", pri: 1, chips: ["applied|priority|!high"] },
	{ in: "Pay rent !Medium", title: "Pay rent", pri: 2, chips: ["applied|priority|!Medium"] },
	{ in: "Pay rent !LOW", title: "Pay rent", pri: 3, chips: ["applied|priority|!LOW"] },
	{ in: "!1", title: "!1", fb: true, pri: 1, chips: ["applied|priority|!1"] },
	{ in: "Pay\t!1\nrent", title: "Pay rent", pri: 1, chips: ["applied|priority|!1"] },
	{ in: "Pay rent !1 !3", title: "Pay rent !1", pri: 3, chips: [`superseded|priority|!1|n=${SUP}`, "applied|priority|!3"] },
	{ in: "Pay rent !low !high", title: "Pay rent !low", pri: 1, chips: [`superseded|priority|!low|n=${SUP}`, "applied|priority|!high"] },
	{ in: "Call mom !1 tomorrow", title: "Call mom", pri: 1, s: "2026-10-02", chips: ["applied|priority|!1", "applied|scheduled|tomorrow"] },
	{ in: "Study !2 #Study @home for 45m", title: "Study", pri: 2, cat: CAT.study, tags: ["home"], dur: 45, chips: ["applied|priority|!2", "applied|category|#Study", "applied|tag|@home", "applied|duration|for 45m"] },
	{ in: "Pay rent !1", title: "Pay rent !1", dec: [{ span: { start: 9, end: 11 }, text: "!1", kind: "literal" }] },
	// dismissed: only that span; a second one still applies
	{ in: "Pay !1 rent !2", title: "Pay !1 rent", pri: 2, dec: [{ span: { start: 4, end: 6 }, text: "!1", kind: "literal" }], chips: ["applied|priority|!2"] },
	// a manual priority turns the typed token into a suggestion, accepting replaces it
	{ in: "Pay rent !1", title: "Pay rent !1", manual: ["priority"], chips: ["suggestion|priority|!1|n=Replace priority?"] },
	{ in: "Pay rent !1", title: "Pay rent", pri: 1, manual: ["priority"], dec: [{ span: { start: 9, end: 11 }, text: "!1", kind: "accept" }], chips: ["applied|priority|!1"] },
	// the span is masked before chrono: a priority word never becomes a date
	{ in: "Pay !2 pm", title: "Pay pm", pri: 2, chips: ["applied|priority|!2"] },
	{ in: "Pay !3 tomorrow", title: "Pay", pri: 3, s: "2026-10-02", chips: ["applied|priority|!3", "applied|scheduled|tomorrow"] },
	// golden false positives: none of these is a priority
	{ in: "Wow!", title: "Wow!" },
	{ in: "Wow! great", title: "Wow! great" },
	{ in: "!important", title: "!important" },
	{ in: "Fix this !important", title: "Fix this !important" },
	{ in: "!4", title: "!4" },
	{ in: "!0", title: "!0" },
	{ in: "a!1", title: "a!1" },
	{ in: "!!1", title: "!!1" },
	{ in: "!1x", title: "!1x" },
	{ in: "!10", title: "!10" },
	{ in: "!highest", title: "!highest" },
	{ in: "!", title: "!" },
	{ in: "Pay (!1)", title: "Pay (!1)" },
	{ in: "Pay [[Plan]] !1", title: "Pay [[Plan]]", pri: 1, chips: [`collision|note|[[Plan]]|c=Projects/Plan.md+Archive/Plan.md|n=2 matches`, "applied|priority|!1"], block: 0 },
];

describe("golden cases", () => {
	it("has at least 150 cases", () => {
		expect(CASES.length).toBeGreaterThanOrEqual(150);
	});

	it.each(CASES.map((c, i) => [`${i} ${c.z ?? "ny"}${c.loc ? " " + c.loc : ""} ${JSON.stringify(c.in)}`, c] as const))(
		"%s",
		(_name, c) => {
			const zk = ZONES[c.z ?? "ny"];
			const ctx = makeCtx({
				zone: zk.zone,
				now: at(zk.zone, c.now ?? zk.now),
				locale: c.loc ?? "en",
				decisions: c.dec ?? [],
				manual: c.manual ?? [],
			});
			const r = parseQuickAdd(c.in, ctx);
			expect(r.title).toBe(c.title);
			expect(r.titleFallback).toBe(c.fb ?? false);
			const { recurrence, ...fields } = r.fields;
			expect(fields).toEqual({
				scheduled: c.s ? dateSpecOf(c.s, zk.zone) : undefined,
				deadline: c.d ? dateSpecOf(c.d, zk.zone) : undefined,
				plannedDurationMin: c.dur,
				priority: c.pri,
				categoryId: c.cat,
				tagKeys: c.tags ?? [],
				newTags: c.nt ?? [],
				notePath: c.note,
			});
			expect(recurrence === undefined ? undefined : ruleKey(recurrence)).toBe(c.rec);
			// A rule with a time takes the parse zone; one without has none.
			if (recurrence !== undefined) expect(recurrence.tz).toBe(recurrence.time === null ? null : zk.zone);
			expect(chipLines(r)).toEqual(c.chips ?? []);
			expect(r.blocking.length).toBe(c.block ?? 0);
			for (const chip of r.chips) expect(chip.text).toBe(c.in.slice(chip.span.start, chip.span.end));
		},
	);
});
