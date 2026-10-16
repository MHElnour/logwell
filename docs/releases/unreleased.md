# Unreleased

<!--
Changes that are not released yet. `npm version` moves the entries into docs/releases/<version>.md and puts this
template back.

Rules
- Every change a user can notice adds a line in the commit that makes it. Tests, refactors and documentation of
  internals are not user-visible: no line.
- Put the line under one of the sections below, and delete nothing: empty sections are fine.
- A patch release (0.x.Y) may contain only Fixed and Security. Added and Changed need a minor release.
- Credit the reporter and name the issue when a change comes from a GitHub issue:
  - (#12) Fixed the calendar showing a task twice on the day it repeats. Thanks to @user for reporting.
- A change that does not come from an issue has no number and no thanks.
- Write for someone who uses the plugin: what they see now, not how the code changed.

Sections: Added, Changed, Fixed, Security (Removed is also accepted, for a minor release).
-->

## Added

## Changed

## Fixed

- (#212) Fixed Quick Add dropping a weekday from a repeat when a dash or `to` and a date followed it: `every mon, wed - Oct 26` now repeats on Monday and Wednesday starting Oct 26, and `every mon, wed to Oct 26` repeats until Oct 26.

- (#210) Fixed "Also linked from" in the task details running outside its box: the other tasks now show one per line, and a long title ends in "…" with the full title on hover.

## Security
