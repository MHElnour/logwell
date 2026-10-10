# CSV export

**Export CSV** writes your Logwell data as spreadsheet files, so you can sort, count and chart your tasks, focus time and habits in a spreadsheet app. Nothing is sent anywhere, and the export never changes your data. Logwell cannot import these files. For a backup that it can import, use **Export backup**. See [Your data](your-data.md#export-a-backup).

## Export your data

1. Open the Data page with **Data** at the bottom of the rail.
2. Under **Backup and export**, choose **Export CSV**.

Logwell saves any pending change first, then creates a folder in the root of your vault named `Logwell export YYYY-MM-DD HHmm`, for example `Logwell export 2026-10-05 1434`. The time is in the zone of the **Time zone** setting, or the device's zone when that is empty. If the name exists, ` (2)`, ` (3)` and so on are added. Existing files are never overwritten.

A notice says "Exported 8 files to" and the folder. If a file cannot be written, the notice says how many files were written and that the folder is incomplete. Delete that folder and export again.

The folder is part of your vault, so your sync tool and other plugins see it. Delete it when you no longer need it. **Export CSV** is unavailable while the database is read-only.

## Read the files

- There is one file for each kind of record. The first row holds the column names below.
- The files are UTF-8 with a byte order mark, so spreadsheet apps read accents, emoji and other scripts correctly.
- Fields are separated by commas and rows end with CRLF. A field that holds a comma, a double quote or a line break is wrapped in double quotes, and its quotes are doubled.
- Dates are written as stored: `2026-10-05` for a day, `2026-10-05T09:00` for a wall time (its zone is in the next column), `2026-10-05T07:00:00.000Z` for an instant in UTC.
- Booleans are `true` or `false`. An empty cell means "none".
- Nested values, such as a repeat rule, focus segments or habit versions, are compact JSON in one column whose name ends in `Json`.
- A cell that starts with `=`, `+`, `@`, a tab, a carriage return, or a `-` that is not a plain number gets a leading apostrophe, such as `'=total`. A spreadsheet then shows it as text instead of running it as a formula. Numbers such as `-5` are left alone.

When you open a file, choose UTF-8 and the comma separator if your app asks. If it changes dates such as `2026-10-05T09:00`, set those columns to text.

## tasks.csv

One row per task, subtasks included, ordered by `createdAt`. Tasks in the Trash are not exported.

| Column | Meaning |
| --- | --- |
| `id` | The task's UUID. |
| `title` | The title. |
| `list` | The list name. |
| `section` | The section name, or empty. |
| `tags` | Tag display names, separated by `; `. |
| `parentId` | The parent task's id for a subtask, else empty. |
| `scheduled` | The date or wall time it is scheduled. Empty for a repeating task: see `nextOccurrence`. |
| `scheduledTz` | The IANA zone of a timed `scheduled`, else empty. |
| `deadline` | The deadline. A repeating task has none. |
| `deadlineTz` | The IANA zone of a timed `deadline`, else empty. |
| `plannedDurationMin` | The planned duration in minutes, or empty. |
| `urgent`, `important` | The Eisenhower flags. |
| `priority` | 0 none, 1 high, 2 medium, 3 low. |
| `status` | `open` or `completed`. A repeating task is `open` until its series ends. |
| `completedAt` | The completion time (UTC instant), else empty. |
| `repeat` | The repeat rule in words, such as "every Mon, Fri", else empty. |
| `repeatJson` | The full repeat record as JSON, with every field: the first date (`anchor`), every rule version, the end, `endedAt` and, when set, `anchoredAt` and `countFrom`. Else empty. |
| `nextOccurrence` | The date of the current occurrence of a repeating series that has not ended, else empty. |
| `sortKey` | The manual order key. |
| `createdAt`, `modifiedAt` | UTC instants. |
| `note` | The vault path of the linked description note, else empty. The note's text is not exported. |

## occurrences.csv

One row per resolved occurrence of a repeating task, ordered by task and date.

| Column | Meaning |
| --- | --- |
| `taskId` | The repeating task's id. |
| `task` | Its title. For a series in the Trash, the title comes from the Trash. |
| `trashed` | `true` when the series is in the Trash, else `false`. |
| `occurrenceDate` | The date the occurrence belongs to. |
| `status` | `done` or `skipped`. |
| `resolvedAt` | The completion or skip time (UTC instant). |
| `auto` | `true` when completing a later occurrence skipped it automatically. |
| `completedOn` | The local day it is completed, or skipped by hand. Empty for automatic skips. |

## lists.csv

`id`, `name`, `icon`, `color`, `isInbox`, `sortKey`, `createdAt`, `modifiedAt`. Ordered by `sortKey`.

## sections.csv

`id`, `list` (the list name), `listId`, `name`, `sortKey`, `createdAt`, `modifiedAt`.

## tags.csv

`key` (the lower-case path, such as `home/garden`), `displayName`, `color`, `createdAt`, `modifiedAt`.

## focus-sessions.csv

One row per finished focus round, ordered by start.

| Column | Meaning |
| --- | --- |
| `id`, `deviceId` | The round's id and the device that recorded it. |
| `taskId`, `taskTitle` | The task it was on (empty for none) and the task's title at the time of the round. |
| `plannedSec` | The planned length in seconds. |
| `status` | `completed`, `stopped`, `interrupted`, `recovered` or `split`. |
| `startedAt`, `endedAt`, `finalizedAt` | UTC instants. |
| `focusedSec` | Seconds focused: the segments plus any unobserved gaps you chose to include. |
| `splitFrom` | The round this one is split from, else empty. |
| `setId`, `setRounds`, `setRound` | The focus set it belongs to, its planned rounds and the round's number. Empty when not recorded. |
| `segmentsJson`, `unobservedJson` | The focused segments, and the unobserved gaps with their resolution. |
| `modifiedAt` | The time of the last edit after the round ended, else empty. |

## habits.csv

| Column | Meaning |
| --- | --- |
| `id`, `name`, `icon`, `color` | The habit. |
| `timeOfDay` | `morning`, `afternoon`, `evening` or `anytime`. |
| `reminder` | The reminder time `HH:MM`, or empty. |
| `archivedAt` | The archive time, else empty. |
| `goalType`, `goalTarget`, `goalUnit`, `goalPeriod` | The current goal: `binary`, `count` or `quantity`, per `day` or `week`. |
| `scheduleJson` | The current schedule: daily, weekdays or weekly. |
| `sortKey`, `createdAt`, `modifiedAt` | The order key and UTC instants. |
| `versionsJson` | Every version of the goal and schedule, with the date it took effect. |

## check-ins.csv

One row per check-in, deleted ones included.

`id`, `habitId`, `habit` (the habit's name), `date` (the day it counts for), `value`, `note`, `createdAt`, `modifiedAt`, `deletedAt` (empty unless you deleted it).
