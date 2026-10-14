# Development

These pages are for people and agents who change Logwell's code or docs. The user guide is in [`docs/`](../README.md), and release notes are in [`docs/releases/`](../releases/README.md).

Read them in this order:

1. [`architecture.md`](architecture.md): how the code is organized and why. It covers the layers, how a change flows from a view to the file and back, and a glossary. Read it before changing code.
2. [`releasing.md`](releasing.md): the version scheme, the release notes rules and how a release is cut.
3. [`performance.md`](performance.md): how limits are measured, the budgets, the procedure and the latest results.

## Tests

Tests are grouped by feature: one file per feature or part of one (for example `tests/parsing/phrase-table.test.ts`, `tests/parsing/repeat-ends.test.ts`, `tests/ui/repeat-picker.test.tsx`), not one file per issue, milestone or review. A bug fix starts with a failing test in its feature's file, named with the issue number: `it("#88: …")`.

- Rules checked on the stylesheet as text go in the feature's `<feature>-styles` file (for example `tests/ui/calendar-styles.test.ts`, `tests/ui/repeat-styles.test.ts`).
- A feature gets a second file only when its tests need different module mocks (`vi.mock`), which apply to a whole file (for example `tests/obsidian/view-title.test.ts`, which replaces Obsidian's `FileView`).
- When files are merged, each keeps its hooks, helpers and state inside its own top-level `describe`, and the merged file uses `// @vitest-environment happy-dom` if any part needs a DOM.
- A test that fakes timers runs what is still pending (`await vi.runOnlyPendingTimersAsync()`) before `vi.useRealTimers()`, and every prototype or global patch is restored in the matching after-hook, so no test depends on the order of the others.
- Unit tests never go into the timed files (`tests/perf/`, `tests/ui/performance.test.tsx`). A timed test compares times measured in the same run or logs them, never a fixed number of milliseconds (`tests/perf/measure.ts`).

The unit suite runs a sample of the Quick Add repeat grammar grid (`tests/parsing/repeat-grammar-grid.ts`). The whole grid, every repeat form with every title, separator and follower in two zones (about 41,000 cases), runs on demand:

- `npm run test:parser-grid` runs the whole grid against the working tree, reads every everyday phrase once, and exits 1 if a case fails or a phrase throws.
- `node scripts/parser-oracle.mjs --compare <ref>` also reads every grid input with the parser at `<ref>` (a branch, tag or commit, such as `main`) and lists the inputs that read differently. Run it before and after a parser change to see every reading the change moves.
- The same comparison reads the everyday phrases in `tests/parsing/everyday-phrases.txt` (dates, times, ranges, lists, sections, tags, priorities, punctuation, quotes, both English locales): one phrase per line, `phrase<TAB>en-GB` for British English, a line starting with a hash and a space for a comment. Each phrase is read at Wednesday 2026-10-07 10:00 in three zones against a fixed vault (lists Inbox, Work, Home; section Admin in Work; tag home; no notes). The summary line `phrases: <n> inputs × 3 zones, <k> read differently` is followed, for each phrase that changed, by every field that differs (title, scheduled, deadline, planned duration, list, section, priority, repeat, tags, new tags, chips, blocking count) with the value at `<ref>` and here. The list stores no expected readings: it is a change detector, so check every difference by value and add a phrase to the list when a change touches a reading it does not cover.

## Where open work lives

Open work is tracked as GitHub issues, not in a file in the repository.
