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

- (#20) Fixed the tab title showing the old name "Checkpoint" when no database file is loaded; it now says "Logwell".
- (#27) Fixed the Quick Add list pill saying "Unknown" for a list that no longer exists; it now says "Inbox", like everywhere else.
- (#22) Fixed the TickTick settings line "The last sync stopped" giving a different message for the same problem depending on how the sync failed; it now reads the same.
- (#29) Fixed "Open conflict view" in the damaged-database notice not behaving like the other conflict notices when the database file had moved or gone missing.
- (#42) Fixed the task details showing a planned duration as "90 min" while rows show "1h 30m"; both now read "1h 30m".
- (#19) Fixed the Undo button on task notices and on the TickTick confirmation prompt doing nothing when the undo could not be done; it now says "Nothing to undo.", like the other Undo buttons.
- (#18) Fixed focus time being written differently in the status bar, the timer and the "Focus set done" notice. The clock now reads "5:03" everywhere, the set summary reads "4 rounds · 2h focused", and short times are rounded to whole seconds.

## Security
