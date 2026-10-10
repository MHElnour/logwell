# TickTick sync

TickTick sync keeps the lists you choose in step with TickTick, both ways. It stays off until you add a TickTick token and turn it on for a device. See [Privacy](privacy.md) for what is sent.

## Set up sync

1. In the TickTick web app, open your avatar, then Settings, then Account, then API Token. Create a token and copy it.
2. In Obsidian, open Settings, then Logwell, and find the **TickTick sync** group.
3. In **TickTick token**, choose or create a secret that holds the token. Obsidian keeps it in its secret storage, never in your vault.
4. Turn on **Sync with TickTick on this device**.

Turn sync on for one device only. Edits from your other devices still reach TickTick through it, because they reach the database first. While sync is on, the group shows the last sync with a **Sync now** button, and each linked list with **Unlink**. See [Settings and commands](settings-and-commands.md#ticktick-sync) for every setting.

## Link a list

1. Right-click a list in the sidebar (Inbox too) and choose **Sync with TickTick…**.
2. Pick a TickTick list, or **Create "Work" in TickTick**, and choose **Continue**. Note lists and lists already linked are greyed out.
3. A preview shows how many open tasks go each way. Choose **Sync**, or **Back** to pick again.

Logwell takes a backup first ("Before first TickTick sync" under Backups on the Data page). If one side is empty, it is filled from the other. If both have tasks, nothing is matched, so a task on both sides appears twice. Delete the copy you don't want; the delete syncs.

A linked list shows a sync icon in the sidebar and a line under its title: "Synced with TickTick · Last sync 2 minutes ago".

Tip: change synced tasks in one place, such as TickTick. Both sides stay editable.

## Stop syncing a list

Choose **Unlink from TickTick** in the list's menu, or **Unlink** in settings. Every task stays on both sides.

## What syncs

Title, list, section, subtask parent, priority, open or completed, tags and one date sync both ways. Urgent, important, **Duration (min)** and order stay in Logwell. Reminders and attachments stay in TickTick.

**Dates.** TickTick keeps one date. Logwell sends the deadline if there is one, otherwise the schedule. A task that comes from TickTick gets its date as both. A time range is not kept.

**Tags.** Tags sync by name. TickTick allows each name once and nests one level deep, so a tag with a duplicate name or deeper nesting stays in Logwell only. Sync never renames, recolors or deletes a tag in TickTick. Deleting a tag in Logwell removes it from its tasks, and those tasks go up without it.

**Not synced.** Repeating tasks, on either side, and TickTick notes. Such a task in a linked list shows **Not synced**. A task that starts repeating syncs again once neither copy repeats. See [Repeating tasks](repeating-tasks.md).

## Description notes

Turn on **Create notes from TickTick descriptions**. A synced task with a TickTick description, or a checklist with items, then gets a note in your description note folder, linked to the task.

- Your edits to the note go up about 5 seconds later, without the frontmatter. Links go up as their text; embeds stay in Obsidian.
- A change in TickTick changes only the lines it touched. Your links, embeds and layout stay.
- A checklist comes down as tick boxes, such as `- [ ] Buy groceries`, which you can move anywhere in the note. Ticking, adding or removing one changes TickTick too.
- If both sides changed the same lines, your lines come first, then a line `From TickTick:` and TickTick's version. Delete the one you don't want.

Sync writes only the notes it created, and never deletes or renames them. If you delete or unlink one, sync stops writing it and makes no other. A note you link yourself is never read, changed or sent.

## When it syncs

- Your edits go up about 5 seconds after the last one.
- Logwell pulls when Obsidian opens and at the interval you set, 5 to 60 minutes.
- **Sync now**, or the command **Sync with TickTick now**, syncs at once.

A sync cannot be undone. While the database is read-only, sync waits.

## Change a task on both sides

Changes to different fields both apply. If you change the same field on both sides, Logwell keeps its value, and TickTick's version becomes a separate task such as "Pay rent (TickTick)". Keep one and delete the other.

## Delete and complete tasks

- A task you delete in Logwell, or move to a list that is not linked, is deleted in TickTick. A task you restore from the Trash is sent again.
- A task completed or marked won't do in TickTick is completed in Logwell.
- A task gone from TickTick goes to the Logwell Trash. Fewer than 5 in one list move without asking.
- For 5 or more in one list, or a TickTick list that comes back empty, a window asks. **Move to Trash** moves them, with Undo. **Keep** keeps them in Logwell only, marked **Not synced**; for an emptied list, it unlinks the list. Closing the window decides nothing.

## Limits

- A synced list holds at most 999 open tasks. Adding, moving in or reopening a task past that is refused. TickTick can still bring tasks in.
- TickTick's free plan allows 9 lists and 99 open tasks per list. Going over shows an error.
- If more than about 250 tasks of one TickTick list are completed there at almost the same time while they are still open in Logwell (or a very large number over a long time without a sync), Logwell cannot check them all and the sync stops.

## Fix a sync error

A failure stops the sync with a notice that names the list. Nothing retries in a loop; the next try is your next edit or pull.

| Notice | What to do |
| --- | --- |
| "TickTick: too many requests. Sync will try again at the next pull." | Wait. |
| "…the API token was refused… Replace it in Settings > Logwell." | Choose **Open settings** and choose another token. |
| "…has 99 open tasks, the limit of TickTick's free plan." | Complete or move tasks in TickTick, then choose **Sync now**. |
| "…no answer… (network error)." | Check your connection. |
| "…too many tasks in "List" were completed at once to check them all." | In TickTick, reopen some of those tasks, then choose **Sync now**. Afterwards, complete them again fewer than 200 at a time. |

See also [Troubleshooting](troubleshooting.md).
