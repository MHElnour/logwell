# Development

These pages are for people and agents who change Logwell's code or docs. The user guide is in [`docs/`](../README.md), and release notes are in [`docs/releases/`](../releases/README.md).

Read them in this order:

1. [`architecture.md`](architecture.md): how the code is organized and why. It covers the layers, how a change flows from a view to the file and back, and a glossary. Read it before changing code.
2. [`releasing.md`](releasing.md): the version scheme, the release notes rules and how a release is cut.
3. [`performance.md`](performance.md): how limits are measured, the budgets, the procedure and the latest results.

## Tests

Tests are grouped by feature: one file per feature or part of one (for example `tests/parsing/phrase-table.test.ts`, `tests/parsing/repeat-ends.test.ts`, `tests/ui/repeat-picker.test.tsx`), not one file per issue, milestone or review. A bug fix starts with a failing test in its feature's file, named with the issue number: `it("#88: …")`.

- Rules checked on the stylesheet as text go in the feature's `<feature>-styles` file (for example `tests/ui/calendar-styles.test.ts`, `tests/ui/repeat-styles.test.ts`).
- A feature gets a second file only when its tests need different module mocks (`vi.mock`), which apply to a whole file (for example the schema readers `tests/persistence/older-reader-v2.test.ts` to `-v5`).
- When files are merged, each keeps its hooks, helpers and state inside its own top-level `describe`, and the merged file uses `// @vitest-environment happy-dom` if any part needs a DOM. Tests that fake timers go last in their file.
- Unit tests never go into the timed files (`tests/perf/`, `tests/ui/performance.test.tsx`, `tests/ui/perf-virtual-list.test.tsx`).

The unit suite runs a sample of the Quick Add repeat grammar grid (`tests/parsing/repeat-grammar-grid.ts`). The whole grid, every repeat form with every title, separator and follower in two zones (about 41,000 cases), runs on demand:

- `npm run test:parser-grid` runs the whole grid against the working tree and exits 1 if a case fails.
- `node scripts/parser-oracle.mjs --compare <ref>` also reads every grid input with the parser at `<ref>` (a branch, tag or commit, such as `main`) and lists the inputs that read differently. Run it before and after a parser change to see every reading the change moves.

## Where open work lives

Open work is tracked as GitHub issues, not in a file in the repository.
