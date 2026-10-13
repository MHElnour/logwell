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
- (#52) `tag:` in a task block takes several tags separated by commas; a task with any of them shows.
- (#52) A task block has a new `scheduled:` filter for a task's planned date (a repeating task's current one), with the values `today`, `overdue`, `this week` and `next 7 days`.
- (#12) Added a yearly repeat: pick **Yearly** in the repeat picker. Once this version opens a database, older Logwell versions open it read-only, so update every device.
- (#12) Quick Add reads more repeats: `every mon wed fri`, `every mon-fri`, `daily`, `mondays`, `weekly on mon, fri`, `quarterly`, `every year`, `every year on May 5`, `every 15th`, `the 15th of each month`, `the 2nd tuesday of every month`, `last day of the month`, `every morning`, a time with `at` after any of them, a start with `starting`, `from` or `on`, and an end with `until Dec 1`, `for 5 times` or `for 2 weeks`, or a start and end with `starting Oct 12 to Dec 1`. The full list is in the Repeating tasks page. A repeat it cannot do yet, such as `every 3 hours` or `every monday at 9 and friday at 5`, shows a notice instead of a wrong date.
- (#8) Edit a tag from its menu: rename it, move it under another tag or to the top, and change its color in one step with Undo. Renaming a parent renames its child tags' paths, and tasks in the Trash keep the tag. Undo of a new or renamed tag is refused once a synced task uses it, so no task is left with a tag that no longer exists.

## Changed

- (#126) In the Eisenhower matrix, a task whose deadline is today is now under **Today** even when its date is later, as it is in the Today view and the sidebar's Today count.
- (#7) A new tag name can have at most 64 characters. Longer tags you already have keep working. The Tags heading in the sidebar now shows even before you have a tag.

- (#11) Tags now show just their own name, like `@calls`, wherever they appear outside the sidebar tree. Two older tags that share a name still show their full paths, and the message for a name that is already used no longer names a parent.

- (#9) A parent tag is now a tag of its own: creating `@home/calls` also creates `home`, and every tag in the sidebar has a color and the full menu. Adding a task from a parent's view gives it that tag. Deleting a parent moves its child tags to the top level (`home/calls` becomes `calls`) on every task, including tasks in the Trash, in one step with Undo.

- (#12) A weekly repeat on picked weekdays now starts on the first of those weekdays on or after the task's date, in Quick Add, the repeat picker and the details pane alike, so "every 2 weeks on Monday" made on a Wednesday first falls on the coming Monday.
- (#12) A repeat can end after at most 999 times, in Quick Add and the picker.
- (#12) Duplicating a repeating task keeps its end, unless that end would come before the copy's first date: then the copy never ends.
- (#12) In Quick Add, `until` before a date is a deadline when the task does not repeat (`Pay rent until Oct 20`); with a repeat it is the repeat's end. A lone comma left where a recognized phrase was removed no longer stays in the title (`Read every day, 20 pages` is "Read 20 pages").
- (#12) In Quick Add, a repeat with a bare hour, such as `every day at 7`, now waits for you to choose 07:00 or 19:00 before the task is saved: Enter opens the choice. Start and end words count only after a repeat Quick Add can make, and `until 5pm` after a repeat is offered as a date instead of being applied.
- (#12) In Quick Add, `a day` or `a week` alone, as in `3 times a day`, is no longer read as a date.
- (#12) In Quick Add, a two-digit number after a comma is no longer read as a year: `Party May 5, 20 guests` is May 5 with "20 guests" in the title.
- (#12) In Quick Add with the Day/month date order, `from 12 Oct` is now the date 12 October, not a time.
- (#12) In Quick Add, a date typed without a year that this year does not have, such as `Feb 29`, now means the next year that has it.

- (#52) In a task block, `due:` now matches only a task's deadline. Use the new `scheduled:` filter, with the same values, for a task's planned date (a repeating task's current one). A block that used `due:` for planned dates needs `scheduled:` instead.

## Fixed

- (#132) Fixed a calendar drop working from the task as it was when the drag began: a change that came in during the drag, such as a new duration from TickTick sync, could be overwritten, and a task that had started repeating meanwhile was moved. A drop now uses the task as it is when you let go, and a task that now repeats does not move.
- (#121) Fixed the "(TickTick)" copy made when a task was changed on both sides coming back as open work in Logwell and in TickTick when you had completed the task in TickTick. The copy is now completed, like TickTick's version, and stays in Logwell only.
- (#120) Fixed a date you cleared in TickTick coming back when the task had a different date and deadline in Logwell: the sync removed only the deadline and sent the date back to TickTick. Clearing the date in TickTick now clears both in Logwell.
- (#119) Fixed a task deleted in TickTick taking all its Logwell subtasks to the Trash with it, including ones still in TickTick and ones you had just added, and the next sync then deleting those subtasks in TickTick. Only the tasks gone from TickTick go to the Trash now; the other subtasks stay as top-level tasks, on both sides.
- (#109) Fixed a subtask you moved to another synced list in TickTick being moved back to its old list by the next sync, and no longer a subtask on either side. It now stays in the list you moved it to, as a top-level task, in Logwell and in TickTick.
- (#108) Fixed a TickTick sync dropping everything changed in TickTick on a task, such as a new title and priority, when one of the changes could not apply in Logwell, like a column of the list you had just moved the task out of. The sync then sent the old values back to TickTick. Each change now applies on its own, and only the one Logwell cannot take is skipped.
- (#117) Fixed edits made right before quitting Obsidian being lost when the last save failed, for example while a sync tool held the file: they are now kept as a conflict copy, as when a database closes. A database being switched to or from when Obsidian quits is saved too.
- (#118) Fixed an error in one part of Logwell, such as a view or a task block, making a saved change report a failure and leaving the other views out of date. The error is now shown on its own, and a change made outside Obsidian still shows its conflict notice and saves its repairs.
- (#106) Fixed the details pane keeping the Custom repeat editor open, filled in with the previous task's rule, after you selected another task; **Done** then gave that rule to the new task. Selecting another task now closes the repeat picker and empties the Add tag box.
- (#130) Fixed text typed in Quick Add while the previous task was still being saved being wiped when the save finished. It now stays in the field for the next task.
- (#105) Fixed Quick Add dropping a typed `until` date after **Never** was picked as the repeat: the chip showed it as applied, but the task was saved with no end and no deadline. With **Never** picked, `until Dec 1` is now a deadline, as on a task that does not repeat.
- (#129) Fixed **Move up** on the first list doing nothing visible while adding an Undo step and putting the list before Inbox in the list pickers. Inbox now stays first everywhere and has no **Move up** or **Move down**, the ends of the list are off, each move is one visible step, and lists that share a place after Import backup with Merge by ID can be moved instead of showing an error.
- (#104) Fixed two sections with the same name in a list making every open take a backup and save the database again, and two devices rewriting each other's file over and over. The duplicate is now named in a notice and the file is left as it is. A reload after a change from another device that does repair records now says so. **Merge by ID** no longer adds a backup's section next to one of the same name: its tasks go to the section you have.
- (#128) Fixed deleting a list moving its open tasks into an Inbox synced with TickTick past the limit of 999 open tasks. The delete is now refused with the same message as other moves into a full list.
- (#139) Fixed a false conflict copy and Keep mine / Keep theirs notice on another device after a save reported an error but reached the file anyway: the retried save now continues from the version that landed.
- (#127) Fixed deleting a parent tag merging a child tag into an older tag of the same name, such as `home/calls` into `calls`, which took the child's color and joined both tags' tasks. The delete is now refused with the message a rename gives, and nothing changes.
- (#125) Fixed an overdue task you tick in Today jumping to the Today group while its check plays. It now stays under Overdue until it leaves, and on the board the Overdue column no longer disappears and shifts the other columns for that moment.
- (#107) Fixed a drag in Today or Upcoming changing the order of tasks you did not drag in their own list: a task with no date between two dragged ones could end up on the other side. Now only the task you drag moves, in every view.
- (#138) Fixed the hourly Trash clean-up, in rare timing, removing the repeat history of a task that had just been restored and deleted again, and marking its TickTick copy for deletion, while the task was still in the Trash. The clean-up now checks what is older than 30 days at the moment it runs.
- (#131) Fixed a repeating task whose repeat had ended but which was still open, after an edit of the database file or a sync, failing to complete from its row or a task block with "This repeat has ended.". It now completes like any other task, and its menu no longer offers Skip, Edit repeat or Stop repeating.
- (#124) Fixed changing the date of a repeating task after **Stop repeating** saying it now repeats from that date while it stayed completed and did not repeat. A repeat that has ended now keeps its date and the notice says to reopen the task first.
- (#116) Fixed the next start after a conflict saying "Changes this device saved earlier are missing" and adding another conflict copy of the version you had discarded with **Keep theirs**, or not chosen for yet.
- (#101) Fixed an edit that was waiting to be saved disappearing without a word when the database file was damaged (for example by merge markers) or came from a newer version of Logwell, and a valid file came back. The edit is kept as a conflict copy and the conflict notice offers **Keep mine** and **Keep theirs**; if the database closes first, a notice points at the copy.
- (#102) Fixed Restore backup leaving out the edits made since the newest snapshot once Obsidian had quit in the middle of a save. The log of saved changes behind recovery now skips a line cut off by the crash, keeps later changes readable and is cleared after each snapshot again, so it no longer grows with every save.
- (#100) Fixed dates with a time being saved in the computer's own digits when its language writes numbers differently, such as Arabic, Persian or Bengali. Quick Add showed a false daylight saving warning and the database no longer opened. Dates, times and habit reminders now always use 0 to 9, and a database that already holds such a date opens again with those dates repaired.
- (#88) Typing today's date in Quick Add, such as `Pay Oct 7` on Oct 7, now means today at any time of day, not the same day next year, and weekdays, relative words and dates no longer depend on the computer's time zone. `in 1 hour` counts from the task's own clock even while the computer's clock is skipping an hour for daylight saving.
- (#85) Quick Add's date and ⋯ popovers are no longer cut off by the Quick Add window or a short view, and the All fields form lines up: consistent spacing and field styles, and Time says it needs a date.

## Security
