# Logwell

> [!NOTE]
> AI was used throughout the development of Logwell, for the code, the tests and the documentation. Logwell is not entirely my own creation.

Logwell is a task manager for Obsidian. It brings tasks, a calendar, an Eisenhower matrix, a focus timer and habits into one tab, and keeps all of it in one database file in your vault.

It is for people who plan their days in Obsidian and want their tasks next to their notes, without turning every task into a note. You type a task as a sentence, and Logwell finds the date, list, tags and priority in it. Most changes can be undone.

Logwell runs on Obsidian for desktop.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/MHElnour/logwell/main/docs/images/today-dark.png">
  <img src="https://raw.githubusercontent.com/MHElnour/logwell/main/docs/images/today-light.png" alt="The Today view with lists, nested tags and overdue and timed tasks">
</picture>

## Features

- [Tasks](https://github.com/MHElnour/logwell/blob/main/docs/tasks.md) with dates, times, deadlines, durations, priorities, subtasks and a linked description note.
- [Quick Add](https://github.com/MHElnour/logwell/blob/main/docs/quick-add.md) reads a line such as `Pay rent friday #Home @errands !1` as you type.
- [Lists, sections and tags](https://github.com/MHElnour/logwell/blob/main/docs/lists-and-tags.md), with nested tags and a [board](https://github.com/MHElnour/logwell/blob/main/docs/board.md) of columns.
- [Views](https://github.com/MHElnour/logwell/blob/main/docs/views.md): Today, Upcoming, Inbox, Completed and Trash, with sorting, grouping and search.
- [Repeating tasks](https://github.com/MHElnour/logwell/blob/main/docs/repeating-tasks.md) that stay one task and keep their history.
- A [calendar](https://github.com/MHElnour/logwell/blob/main/docs/calendar.md) with week and month views, where you drag tasks to reschedule them.
- An [Eisenhower matrix](https://github.com/MHElnour/logwell/blob/main/docs/matrix.md) that sorts tasks by urgency and importance.
- [Focus](https://github.com/MHElnour/logwell/blob/main/docs/focus.md): timed rounds with breaks, and a [record](https://github.com/MHElnour/logwell/blob/main/docs/focus-record.md) of every round.
- [Habits](https://github.com/MHElnour/logwell/blob/main/docs/habits.md) with check-ins, streaks, goals and [reminders](https://github.com/MHElnour/logwell/blob/main/docs/habit-reminders.md).
- A [task block](https://github.com/MHElnour/logwell/blob/main/docs/dashboard-block.md) that shows a live list of tasks inside any note.
- Optional [TickTick sync](https://github.com/MHElnour/logwell/blob/main/docs/ticktick-sync.md), off until you turn it on. See [Privacy](https://github.com/MHElnour/logwell/blob/main/docs/privacy.md).

## A closer look

### [Quick Add](https://github.com/MHElnour/logwell/blob/main/docs/quick-add.md)

Type a task as one sentence; Logwell reads the date, time, list, tags, priority and duration as you type.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/MHElnour/logwell/main/docs/images/quick-add-dark.png">
  <img src="https://raw.githubusercontent.com/MHElnour/logwell/main/docs/images/quick-add-light.png" alt="Quick Add reading a date, a list, a tag, a priority and a duration from one line">
</picture>

### [Calendar](https://github.com/MHElnour/logwell/blob/main/docs/calendar.md)

See your week or month at a glance and drag tasks to another day or time to reschedule them.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/MHElnour/logwell/main/docs/images/calendar-week-dark.png">
  <img src="https://raw.githubusercontent.com/MHElnour/logwell/main/docs/images/calendar-week-light.png" alt="The week view of the calendar with timed tasks and an all-day row">
</picture>

### [Eisenhower matrix](https://github.com/MHElnour/logwell/blob/main/docs/matrix.md)

Sort tasks into four quadrants by urgency and importance, and decide what to do first.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/MHElnour/logwell/main/docs/images/matrix-dark.png">
  <img src="https://raw.githubusercontent.com/MHElnour/logwell/main/docs/images/matrix-light.png" alt="The Eisenhower matrix with tasks in four quadrants">
</picture>

### [Focus](https://github.com/MHElnour/logwell/blob/main/docs/focus.md)

Work in timed rounds with breaks, tied to a task, and keep a record of every round.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/MHElnour/logwell/main/docs/images/focus-dark.png">
  <img src="https://raw.githubusercontent.com/MHElnour/logwell/main/docs/images/focus-light.png" alt="The focus timer with the record of past rounds">
</picture>

### [Habits](https://github.com/MHElnour/logwell/blob/main/docs/habits.md)

Check in on daily or weekly habits and follow your streaks, goals and history.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/MHElnour/logwell/main/docs/images/habits-dark.png">
  <img src="https://raw.githubusercontent.com/MHElnour/logwell/main/docs/images/habits-light.png" alt="Habits with check-ins and streaks">
</picture>

### [Task block](https://github.com/MHElnour/logwell/blob/main/docs/dashboard-block.md)

Put a live list of tasks inside any note with a `logwell` code block, one filter per line:

````markdown
```logwell
list: Work
section: Planning
scheduled: this week
```
````

Every line narrows the list, and `tag`, `priority` and `quadrant` take several values separated by commas.

| Filter | Values | Example |
| --- | --- | --- |
| `list` | A list name, or `Inbox` | `list: Home` |
| `section` | A section of that list (needs a `list` line) | `section: Planning` |
| `tag` | A tag, including its nested tags | `tag: home, work` |
| `due` | `today`, `overdue`, `this week`, `next 7 days`, a date `DD-MM-YYYY` or a range `… to …` (the deadline) | `due: overdue` |
| `scheduled` | The same values, for the planned date | `scheduled: 20-10-2026 to 25-10-2026` |
| `priority` | `high`, `medium`, `low` or `none` | `priority: high, medium` |
| `quadrant` | `1` to `4`, or `urgent and important`, `important not urgent`, `urgent not important`, `neither` | `quadrant: 1` |
| `linked` | `this note`: tasks whose description note holds the block | `linked: this note` |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/MHElnour/logwell/main/docs/images/block-dashboard-dark.png">
  <img src="https://raw.githubusercontent.com/MHElnour/logwell/main/docs/images/block-dashboard-light.png" alt="A task block showing a live list of tasks inside a note">
</picture>

## Install

Logwell is in Obsidian's community plugin directory.

1. In Obsidian, open Settings, then Community plugins. Turn on community plugins if they are off.
2. Choose **Browse**, search for **Logwell** and choose **Install**, then **Enable**.
3. Choose **Create database** in the notice that appears.

You can also open [Logwell in the plugin directory](https://obsidian.md/plugins?id=logwell) and install it from there.

[Getting started](https://github.com/MHElnour/logwell/blob/main/docs/getting-started.md) walks you through these steps and your first task.

## Your data

Your tasks stay in your vault, in one plain text file that works with Git and file-sync tools. Logwell keeps backups and never copies your notes into it. See [Your data](https://github.com/MHElnour/logwell/blob/main/docs/your-data.md).

## Documentation

- [Documentation](https://github.com/MHElnour/logwell/blob/main/docs/README.md): every page, from first steps to reference.
- [Release notes](https://github.com/MHElnour/logwell/blob/main/docs/releases/README.md): what changed in each release.

## License

Logwell is released under the [MIT License](https://github.com/MHElnour/logwell/blob/main/LICENSE).
