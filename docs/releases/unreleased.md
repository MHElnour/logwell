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

- (#40) Fixed "Next 7 days" covering a different set of days in the Eisenhower matrix than in the list filter and task blocks; it now means today and the next six days everywhere.
- (#41) Fixed slow redraws after an edit in large vaults: the Tasks views, the sidebar and the calendar no longer read through every task on each change, the Eisenhower matrix filtered by a list or tag reads only those tasks, and Search no longer searches again while hidden or when nothing changed.

## Security
