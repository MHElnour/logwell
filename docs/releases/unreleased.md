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

## Security
