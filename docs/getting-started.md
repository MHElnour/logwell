# Getting started

This page takes you from install to your first task in about a minute. Logwell runs on Obsidian for desktop and needs Obsidian 1.13.0 or newer.

## Install and turn on Logwell

Logwell is not in the community plugin directory, so you install it by hand from a GitHub release.

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/MHElnour/checkpoint/releases).
2. In your vault, create the folder `.obsidian/plugins/logwell/` if it does not exist. The `.obsidian` folder is hidden, so turn on hidden files in your file manager.
3. Copy the three files into that folder.
4. In Obsidian, open Settings, then Community plugins. Turn on community plugins if they are off, reload the list and turn on Logwell.

## Create your database

Logwell keeps your lists, tasks, habits and focus rounds in one database file in your vault. When no database is active, a notice says "Logwell keeps your tasks in a database file. Create one to get started." Choose **Create database** in it.

If the notice is gone, run the command **Create database**, or open Settings, then Logwell, and choose **Create database** in the Database group.

1. Choose a folder for the database file.
2. Keep the name "Logwell" or type another, and choose **Create**.

The file becomes the active database, and the app opens in a tab. The first time, a notice also explains one Obsidian Sync setting. See [Your data](your-data.md#sync).

## Open the app

Open the app on your database in any of these ways:

- Click the **Open Logwell** icon in the ribbon.
- Run the command **Open app**. Other commands open one part directly, such as **Open today** and **Open calendar**. See [Settings and commands](settings-and-commands.md#run-a-command).
- Open the database file itself.

If the app tab is already open, Logwell switches to it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/today-dark.png">
  <img src="images/today-light.png" alt="The Today view with the rail of icons on the left, the sidebar of views, lists and tags, and the task list">
</picture>

The rail on the left switches between **Tasks**, **Calendar**, **Focus**, **Habits**, **Matrix** and **Search**. In Tasks, the sidebar lists **Today**, **Upcoming**, **Inbox**, your lists and your tags. The app opens on **Today**. See [Views](views.md#find-your-way-around) for a full tour.

## Make a list

A fresh database has one list, Inbox. Add a list for your home tasks:

1. Click **New list**, the plus button next to Lists in the sidebar.
2. Type "Home" as the **Name** and choose **Create**.

See [Lists, sections and tags](lists-and-tags.md#create-a-list) for icons, colors and sections.

## Add your first task

Click **Today** in the sidebar. Then click the add bar at the top of the list and type:

```text
Call the bank today at 9am #Home
```

As you type, Logwell highlights the words it recognizes and shows each as a chip under the bar: "today at 9am" becomes the date and time, and `#Home` puts the task in your Home list. Press Enter.

The task "Call the bank" appears in **Today** with its time, and the bar is ready for the next task. Click the task to open its details and change anything you like. Click its checkbox when you are done.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/quick-add-dark.png">
  <img src="images/quick-add-light.png" alt="The Quick add task window with a task typed in and chips for the date, list, tag, priority and duration">
</picture>

You can also add a task from anywhere in Obsidian with the command **Quick add task**. Give it a hotkey to make it quicker. See [Settings and commands](settings-and-commands.md#give-a-command-a-hotkey).

## Where to go next

- [Quick Add](quick-add.md): everything you can type in one line, such as `Pay rent friday #Home @errands !1`.
- [Tasks](tasks.md): dates, deadlines, priorities, subtasks, notes and undo.
- [Views](views.md): what Today and Upcoming show, and how to sort, group and search.
- [Repeating tasks](repeating-tasks.md): bills, chores and anything else that comes back.
- [Calendar](calendar.md), [Focus](focus.md) and [Habits](habits.md): the other sections of the app.
- [Your data](your-data.md): where your tasks are saved and how they are backed up.
- [All pages](README.md): the full documentation.
