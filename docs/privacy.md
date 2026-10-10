# Privacy

Logwell keeps your tasks in a file in your vault and sends nothing anywhere by default. It has no accounts, no analytics and no update checks. The one exception is [TickTick sync](ticktick-sync.md), which stays off until you turn it on. This page says what it sends.

## What is sent to TickTick

Nothing is sent until you choose a token, turn on **Sync with TickTick on this device** and link a list. Then Logwell talks only to `api.ticktick.com`, over HTTPS:

- **Your token**, with each request, so TickTick knows whose lists to read and change.
- **The tasks of the lists you linked:** the fields listed in [What syncs](ticktick-sync.md#what-syncs). Deleting such a task in Logwell deletes it in TickTick.
- **Names you create there:** a list you create with **Create "Work" in TickTick**, its sections, and tag names.
- **Description notes**, only with **Create notes from TickTick descriptions** on: the text of the notes that sync created, without frontmatter, with links as their text and embeds left out.

Logwell also reads the names of your TickTick lists to show them in the link window; they are not saved. It reads the tasks, sections and tags of the linked lists, and writes what it takes in to your database.

Nothing else is sent: not your other lists, habits, focus records or settings, and not a note you linked yourself.

Requests go out after you edit a linked list or a note that sync created, when Obsidian opens, at the pull interval you set, and when you choose **Sync now**. A device with the switch off makes no request. TickTick's own policies cover what it does with your data.

## Where the token is kept

The token is in Obsidian's secret storage, under a secret you choose. Logwell's settings keep only the secret's name. The token is never in your database, a backup or an export, and Logwell never shows it in a notice.

To stop all requests, turn off the device switch. To remove the token, clear **TickTick token** or delete the secret in Obsidian.

For what the database holds about synced tasks, see [Your data](your-data.md).
