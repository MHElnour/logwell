# Focus record

The focus record shows the rounds you saved on the [Focus](focus.md) page: how long you focused today and in total, and every round by day. You can fix a round's task, delete a round, and decide what happens to a timer that a crash or sleep interrupted.

## See where your time went

The **Overview**, at the top of the right column of the Focus page, shows **Today** and **All time**, each with **Pomos** and **Focused**. A pomo is a completed focus round with at least one minute of focus. A round you end with **Finish** counts too, with its real minutes. Stopped and split rounds add to the time focused but are not pomos.

Below it, the **Focus record** lists your history by day, newest day first. Each day shows its total. Under a day are its focus sets, such as "Focus set · 3 of 4 rounds", with the time range and how the set ended: done, stopped after round 3, recovered or in progress. Click a set to fold it. **Show more** loads older rounds.

Under a set are its rounds, each with its time range, its length and its status:

- **Completed**: the round ran to its end.
- **Finished early**: you ended it with **Finish** before its planned length.
- **Stopped early**: you ended it with **Stop**.
- **Split to another task**: the part before a **Split**.
- **Recovered**: the timer was interrupted during the round. See [Recover the timer after a crash or sleep](#recover-the-timer-after-a-crash-or-sleep) below.

A colored dot repeats the status, with a legend at the bottom. When the rounds of a set have different tasks, each round shows its own. A round whose task you deleted shows the task's name with "(deleted)".

## Fix or delete a round

Click the three-dot button on a round, labelled "Actions for round" with its number and time:

- **Assign to task…** gives a round with no task a task.
- **Change task…** and **Remove task** change or clear the task of a round that has one.
- **Delete record** removes the round.

Each change shows a notice with **Undo**, and the totals follow. The menu is not shown while the database is read-only.

## Recover the timer after a crash or sleep

While a timer runs, Logwell saves it on this device about every 15 seconds. If Obsidian closes, restarts or crashes during a set, or the computer sleeps for more than about a minute and a half, the timer cannot know what happened in between. The next time Logwell runs, the timer is paused and a dialog titled "Focus timer was interrupted" asks what to do:

- **Resume** continues the round from where it stopped.
- **Finish** saves the round up to the last moment Logwell saw it, as Recovered, and ends the set.
- **Discard** drops the round and the rest of the set. Nothing is saved. The notice has **Undo**.
- **Decide later** closes the dialog and keeps the timer paused.

Nothing is saved until you choose. While the question waits, a banner on the Focus page offers **Resume**, **Finish and save** and **Discard**, which asks you to confirm first. The status bar adds "Needs your answer". Clicking the status bar, **Open focus** and **Pause or resume focus** show the dialog again.

The time in between is not counted at first. In the focus record it shows under the round with its length, such as "+5m unobserved, not counted", with **Include** and **Exclude** buttons. **Include** adds it to the round's time. You can change your mind at any time.

If Logwell saved the round just before Obsidian closed, it says so and ends the set.

The running timer lives on the device where you started it, with the database it belongs to. If the database file is replaced while the timer runs, for example a damaged file put back outside Obsidian, the timer stays with the database that is open now. It is not in the database, so another computer does not show it. If this device cannot save it (for example its storage is full), a notice says so once; the timer keeps running, but a restart loses the current round. Saved rounds are in the database and sync with it. See [Your data](your-data.md).

