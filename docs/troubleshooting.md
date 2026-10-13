# Troubleshooting

What to do when Logwell shows a warning or does not behave as you expect. For where your data lives and how backups work, see [Your data](your-data.md).

## The database opened read-only

A read-only database shows a banner at the top of the app. You can look at everything, but Logwell writes nothing to the file, and **Export backup**, **Export CSV**, **Import backup** and **Restore** are unavailable. The banner names one of two causes.

### The database is newer than this plugin

The banner says "This database uses schema version N, which is newer than this plugin supports." Another device saved it with a newer version of Logwell.

1. Update Logwell on this device. See [Getting started](getting-started.md#install-and-turn-on-logwell).
2. Reload Obsidian. The database opens normally.

Update Logwell on every device that uses the database before you edit it there. See [Your data](your-data.md#upgrade-the-database).

### The database file is damaged

The banner says "Database file is damaged or has a merge conflict", with the reason in brackets. The usual causes are a merge that left conflict markers in the file, or a sync tool that wrote a cut-off copy.

When Logwell knows the database's id, from the file's header or from this device, it saves the damaged text as a copy, listed on the Data page under **Conflicts**. If it found a valid backup, it shows that backup and the banner says "Showing the newest valid backup. Nothing is written until you choose." Otherwise it says "No valid backup was found. Nothing is written."

- **Restore backup** writes the backup shown into the database file. It includes the changes this device logged after that snapshot.
- **Open conflict view** opens the Data page and writes nothing. A damaged copy whose header cannot be read shows only **Dismiss**, which moves it to the "resolved" folder. Nothing is deleted.

To repair the file yourself, fix it and Logwell loads it once it is valid.

A change that was not saved yet when the file became damaged is kept as a conflict copy. When a valid file is back, Logwell loads it and shows the conflict notice with **Keep mine** and **Keep theirs**, so the change is never dropped without a word. If the database closes first, a notice points at the copy. The same applies when a file from a newer version of Logwell arrives while a change waits.

## A conflict copy appeared after sync

A notice says "The database changed outside Obsidian while this device had other changes. The other version is now loaded; yours was kept as a conflict copy." Two devices changed the database before a sync finished. Choose **Keep mine** or **Keep theirs**, in the notice or on the Data page under **Conflicts**. See [Your data](your-data.md#sync).

Related notices:

- "Changes this device saved earlier are missing from the database file. They were restored as a conflict copy." **Open conflict view** leads to the copy. A version already kept as a conflict copy when the other version was loaded is not reported again, whether you chose **Keep theirs** or have not chosen yet.
- "Changes made to … just before it closed could not be saved to the file. They were kept as a conflict copy."
- "A sync conflict copy of a Logwell database appeared: …" A sync tool made its own copy of the file. Logwell does not read or merge it. The active database is the one you use.

## Restore a backup

Open the Data page, find the snapshot under **Backups** and choose **Restore**. See [Your data](your-data.md#back-up-and-restore). To restore a file you made with **Export backup**, use **Import backup**. See [Your data](your-data.md#import-a-backup).

## A notice says the database could not be saved

"Could not save the database: …" followed by "Retrying." means a write failed. Logwell keeps your changes in memory and tries again every 5 seconds. If something else changed the file meanwhile, Logwell handles it as an outside change and may show the conflict notice instead.

"Unsaved changes to … could not be kept and are lost" is rare. It means a database closed while its changes could not be saved, and the conflict copy Logwell tries to keep failed too. The notice gives the reason.

## A habit reminder did not fire

Reminders fire only while Obsidian is open and the habit's goal is not met yet; see [Habit reminders](habit-reminders.md#know-when-reminders-run) for every condition.

## Focus recovery after sleep or a crash

After a crash, a close or sleep, the timer waits paused for your choice; see [Focus record](focus-record.md#recover-the-timer-after-a-crash-or-sleep).

## Logwell is slow with a very large database

Logwell is measured at 50,000 tasks. On a fast laptop, 50,000 tasks (about 16 MB) open in about half a second and save an edit in under 0.2 s. See the [performance notes](development/performance.md).

If it feels slow:

- Update Logwell to the latest release.
- Empty the Trash. It is also emptied for good after 30 days.
- Obsidian Sync Standard has a 5 MB file limit, about 15,000 tasks.

If it is slow at a smaller size, report it as a bug, with the number of tasks and the size of the database file.

## Report a bug

1. Open the [issue form](https://github.com/MHElnour/checkpoint/issues/new/choose) and choose Bug report.
2. Fill in the form:
   - What happened, and what you expected instead.
   - The smallest set of steps that triggers it.
   - The Logwell version, from Settings, then Community plugins.
   - The Obsidian version and platform. Run Show debug info from the command palette.
   - Roughly how many tasks the database has, how large the file is and whether you sync it.
   - Errors from the developer console (Ctrl+Shift+I, or Cmd+Option+I on macOS).
   - Screenshots, if they help.

Before you post, remove private content such as task titles and note paths.

Ideas for features go in the Feature request form on the same page.
