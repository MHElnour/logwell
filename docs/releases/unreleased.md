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
- (#7) Create a tag from the sidebar with **New tag**: pick a name, parent and color; the name is checked as you type.
- (#52) `tag:` in a task block takes several tags separated by commas and shows a task with any of them.
- (#52) Task blocks have a `scheduled:` filter for planned dates, a repeat's current one included: `today`, `overdue`, `this week` or `next 7 days`.
- (#12) Added a **Yearly** repeat in the repeat picker; older Logwell versions open a database that uses it read-only, so update every device.
- (#12) Quick Add reads more repeats, such as `every mon wed fri`; an unsupported one shows a notice, not a wrong date.
- (#8) Edit a tag's name, parent or color in one step, with Undo until a synced task uses the new or renamed tag.

## Changed

- (#136) When TickTick does not answer while you link a list, the notice now names the list, as a failed sync does.
- (#126) In the Eisenhower matrix, a task with a deadline today sits under **Today** even when its date is later.
- (#7) New tags are limited to 64 characters; longer existing tags still work, and the Tags heading shows even when empty.

- (#11) Tags show just their own name, like `@calls`, outside the sidebar; two older tags with one name still show full paths.

- (#9) Parent tags are real tags: `@home/calls` also creates `home`, and deleting a parent moves its children to the top, with Undo.

- (#12) A weekly repeat on picked weekdays starts on the first picked day on or after the task's date.
- (#12) A repeat can end after at most 999 times, in Quick Add and the picker.
- (#12) Duplicating a repeating task keeps its end date, unless that end falls before the copy's first date; then the copy never ends.
- (#12) In Quick Add, `until` is a deadline for one-off tasks and a repeat's end otherwise; no leftover comma stays in titles.
- (#12) `every day at 7` in Quick Add asks you to pick 07:00 or 19:00; `until 5pm` after a repeat is offered as a date.
- (#12) In Quick Add, `a day` or `a week` alone, as in `3 times a day`, is no longer read as a date.
- (#12) In Quick Add, `Party May 5, 20 guests` keeps "20 guests" in the title instead of reading 20 as a year.
- (#12) In Quick Add with the Day/month date order, `from 12 Oct` is now the date 12 October, not a time.
- (#12) In Quick Add, a yearless date this year lacks, like `Feb 29`, now means the next year that has it.

- (#52) In a task block, `due:` now matches only deadlines; a block that used it for planned dates needs the new `scheduled:` filter instead.

## Fixed

- Fixed Quick Add suggesting the wrong start for a range ending in a time, such as `Party Friday until midnight` on a Wednesday.
- Fixed a task changed in TickTick and briefly left out of its list going to the Trash; deletes there now arrive one sync later.
- (#137) Fixed wording: Undo says "list" instead of "category", the import preview says "Sections", and a TickTick notice names the free plan.
- (#135) Fixed board cards missing the **Not synced** mark and focus time that lists show.
- (#134) Fixed failures that showed nothing, such as creating a database; a failed backup no longer reports a save error.
- (#122) Fixed a new task appearing twice in Logwell and TickTick when the database went read-only or Obsidian closed just after sync.
- (#115) Fixed a running focus round being lost or moved to another database when the open database file was replaced.
- (#111) Fixed a TickTick-deleted list stopping sync for every synced list, so no changes were sent; it is skipped with an **Unlink** button.
- (#110) Fixed a deleted TickTick-synced list staying linked, so its tasks stopped syncing; deleting it unlinks it and its tasks follow the Inbox.
- (#114) Fixed a task block's **Not synced** mark not updating after a TickTick link, unlink or **Keep**, even after a reload.
- (#113) Fixed a note renamed or moved during a database switch breaking the task's note link for good.
- (#112) Fixed a database switch still running at quit, reload or update opening the new database, so two copies could write one file.
- (#103) Fixed another device's change, arriving while the database opened, being ignored and making your next edit a conflict copy.
- (#123) Fixed an open task TickTick briefly left out of a list going to the Trash and coming back as a second copy.
- (#133) Fixed a deleted line in a synced description note coming back when both sides made the same edit beside it.
- (#132) Fixed a calendar drop overwriting changes made during the drag, and moving a task that had started repeating.
- (#121) Fixed a task changed on both sides returning as open work in Logwell and TickTick after you completed it in TickTick.
- (#120) Fixed a date cleared in TickTick coming back when Logwell had another date and deadline.
- (#119) Fixed deleting a task in TickTick sending its Logwell subtasks to the Trash, even those still in TickTick.
- (#109) Fixed a subtask moved to another synced list in TickTick snapping back to its old list at the next sync.
- (#108) Fixed a TickTick sync dropping all of a task's changes when one could not apply in Logwell and sending old values back.
- (#117) Fixed edits made just before quitting Obsidian being lost when the last save failed while a sync tool held the file.
- (#118) Fixed one view's error making a saved change look failed and leaving other views out of date.
- (#106) Fixed the details pane keeping the previous task's Custom repeat editor open, so **Done** gave its rule to the next task.
- (#130) Fixed text typed in Quick Add while the previous task was saving being wiped when the save finished.
- (#105) Fixed a typed `until` date being dropped after **Never** was picked, though its chip still showed it.
- (#129) Fixed **Move up** on the first list putting it before Inbox, which now always stays first.
- (#104) Fixed same-named sections making every open rewrite the database, with two devices rewriting each other's file.
- (#128) Fixed deleting a list pushing its open tasks past the 999-task limit of a TickTick-synced Inbox; the delete is now refused.
- (#139) Fixed a false conflict copy on another device when a save reported an error but reached the file.
- (#127) Fixed deleting a parent tag merging a child into an older same-named tag; the delete is now refused.
- (#125) Fixed an overdue task jumping to the Today group, and the board's Overdue column vanishing, while its tick animation plays.
- (#107) Fixed a drag in Today or Upcoming reordering undated tasks you did not drag; now only the dragged task moves, in every view.
- (#138) Fixed a rare case where the hourly Trash clean-up removed a restored task's repeat history and marked its TickTick copy for deletion.
- (#131) Fixed an open task with an ended repeat failing to complete with "This repeat has ended." after a sync or edit.
- (#124) Fixed a date change on a stopped repeat saying it repeats again while the task stayed completed.
- (#116) Fixed a false "Changes this device saved earlier are missing" warning after a conflict, and an extra copy of a version you discarded.
- (#101) Fixed a pending edit vanishing when the database file was damaged or came from a newer Logwell; now kept as a conflict copy.
- (#102) Fixed Restore backup missing edits made since the newest snapshot after Obsidian quit mid-save.
- (#100) Fixed dates saved in local digits on Arabic, Persian or Bengali computers, which stopped the database opening; existing dates are repaired.
- (#88) Fixed Quick Add reading `Pay Oct 7` on Oct 7 as next year, and dates shifting with the computer's time zone or daylight saving.
- (#85) Fixed Quick Add's date and ⋯ popovers being cut off in a short view; Time now says it needs a date.

## Security
