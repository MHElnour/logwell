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

- (#11) Type a nested tag by its own name, like `@calls` for `home/calls`, in Quick Add, the tag field and task blocks.
- (#7) Create a tag from the sidebar: the **New tag** button next to Tags opens a dialog with a name, an optional parent and a color. The name is checked as you type.
- (#8) Edit a tag from its menu: rename it, move it under another tag or to the top, and change its color in one step with Undo. Renaming a parent renames its child tags' paths, and tasks in the Trash keep the tag.

## Changed

- (#7) A new tag name can have at most 64 characters. Longer tags you already have keep working. The Tags heading in the sidebar now shows even before you have a tag.

- (#11) Tags now show just their own name, like `@calls`, wherever they appear outside the sidebar tree. Two older tags that share a name still show their full paths, and the message for a name that is already used no longer names a parent.

## Fixed

## Security
