# Your data

Logwell keeps your tasks in one database file in your vault. This page explains where your data lives, how it is saved and backed up, and how to sync, export and import it.

## Where your data lives

**The database file.** One file with the extension `.cpbase`, in the folder you chose when you created it. It holds your lists, sections, tags, tasks, the completed and skipped dates of repeating tasks, habits and check-ins, focus records and the Trash. It is plain JSON text with one line for each record, so a change to one task changes one line.

**Your notes.** A task's description note is stored as a path only. Logwell never copies a note's text into the database and never deletes your notes. It edits only the description notes that TickTick sync created. See [Privacy](privacy.md).

**Settings.** In `.obsidian/plugins/logwell/data.json`.

**Backups.** In `.obsidian/plugins/logwell/backups/`, with one folder for each database. They stay on this device.

**This device.** Obsidian's local storage holds what belongs to one device, such as a running focus timer and the habit reminders already shown. It does not sync.

## How Logwell saves

Logwell saves a moment after you stop editing, and at the latest a couple of seconds later. It also saves when the window loses focus or is hidden, and when Obsidian quits. If a save fails, see [Troubleshooting](troubleshooting.md#a-notice-says-the-database-could-not-be-saved).

To take back a change, see [Undo](tasks.md#undo).

## Back up and restore

Logwell keeps snapshots of each database on this device. The Data page, opened with **Data** at the bottom of the rail, lists them under **Backups**, newest first. Each one has a label:

| Label | When it is taken | Kept |
| --- | --- | --- |
| **Snapshot** | When the database opens, then about every hour while you make changes | The newest 5 |
| **Daily snapshot** | Once a day | 14 days |
| **After reload** | The first save after the file changed outside Obsidian | The newest 5 |
| **Before upgrade**, **Before repair**, **Before import**, **Before restore**, **Before first TickTick sync** | Before that action | The newest 5 of each |

Logwell also logs each saved change, so a damaged file can be recovered up to the last one.

To restore a snapshot:

1. Open the Data page and find the snapshot under **Backups**.
2. Choose **Restore**, then **Restore** again to confirm.

All records are replaced with the snapshot's, after a **Before restore** backup. **Restore** is unavailable while the database is read-only; see [Troubleshooting](troubleshooting.md#the-database-opened-read-only).

Snapshots are a safety net on one device. Use **Export backup** for a file you can keep anywhere.

## Sync

The database is one file, so any tool that syncs your vault syncs it. Use one device at a time, and let the sync finish before you switch devices.

- **Obsidian Sync.** `.cpbase` is not one of the file types it syncs by default. Turn on "Sync all other types". Logwell reminds you once, when you create your first database.
- **Other sync and version-control tools.** No change is needed.

If the file changes from outside while this device has unsaved changes, Logwell loads the other version and keeps yours as a conflict copy. A notice offers **Keep mine** and **Keep theirs**:

- **Keep mine** writes your version on top of the current one, after a **Before restore** backup.
- **Keep theirs** keeps the current version and moves your copy to a "resolved" folder.

The same buttons are on the Data page under **Conflicts**. A copy whose header cannot be read shows only **Dismiss**. Copies are never deleted. There is no merge: you keep one version.

If you rename or move the active database file inside Obsidian, Logwell follows it. For other notices, such as a damaged file or a copy made by a sync tool, see [Troubleshooting](troubleshooting.md#a-conflict-copy-appeared-after-sync).

## Upgrade the database

A database written by an older version of Logwell is upgraded once when you open it. A **Before upgrade** snapshot is taken first, and a notice says "The database was upgraded from schema X to Y. A backup was taken first."

An older version of Logwell cannot write a newer database: it opens it read-only. Update Logwell on every device that uses the database. See [Troubleshooting](troubleshooting.md#the-database-is-newer-than-this-plugin).

## Export a backup

**Export backup**, on the Data page under **Backup and export**, saves the whole database as one JSON file:

1. Choose **Export backup**.
2. Pick a folder in your vault.

The file is named `logwell-backup-YYYY-MM-DD.json`, with " (2)" and so on if that name exists. It holds every record, but not your notes, only the links to them. It is the only export that Logwell can import again.

## Import a backup

1. Choose **Import backup** and pick a Logwell backup file from your vault.
2. Read the preview: the file's schema version, how many records of each kind it holds, and how many records a merge would add, overwrite and remove. Open **Records a merge would change** to see them.
3. Choose one:
   - **Merge by ID** adds records you do not have. When a record exists on both sides, the newer one wins. A task you purged from the Trash can come back from an older backup. A section from the backup is not added when the same list here already has a section of that name (for example one you deleted and created again); its tasks go to the section here.
   - **Replace all** replaces every record with the file's.
   - **Cancel** changes nothing.

Either import takes a **Before import** backup first. A backup from a newer version is refused until you update Logwell. If the database changes while the preview is open, nothing is imported and the preview opens again.

Export and import are unavailable while the database is read-only.

## Export to a spreadsheet

**Export CSV** writes one spreadsheet file for each kind of record into a folder of its own in your vault. It does not change your data and cannot be imported. See [CSV export](export.md).
