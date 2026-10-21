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

- (#222) Added a status filter to the task block: status: completed shows completed tasks and status: all shows both, with every other filter narrowing them as usual.
- (#224) Added a Git sync setting for vaults that Git tracks. It adds one line to .gitattributes so Git stops merging the database line by line, and a conflict between two computers offers Keep mine or Keep theirs.

## Changed

- (#222) A task block now needs a list, tag, due, scheduled or linked line; without one it says so instead of listing every open task.

## Fixed

- (#215) Undo no longer leaves a subtask without its parent after a TickTick sync added the subtask.
- (#215) A tag that sits under a tag missing from the database now gets that tag back when the database opens, so it can be renamed and recolored.
- (#224) A database that Git merged from two computers now says so, in the notice, the banner and the Data page. It explains how to recover (add the Git sync setting, then Restore backup), instead of leading to an empty conflict view.

## Security
