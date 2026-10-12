# Repeating tasks

A repeating task, such as "Pay rent" every month, stays one task: each time you complete it, Logwell records that date and moves the task to its next date.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/repeat-dark.png">
  <img src="images/repeat-light.png" alt="The details of a task with the custom repeat editor open, set to every week on Friday">
</picture>

## Make a task repeat

Type `every …` in Quick Add, such as `Pay rent every month on the 1st #Home`, or use the picker: the **Repeat** row in the add bar's date popover, or the **Repeat** field under **All fields** in the **Quick add task** window or in the details pane.

Pick **Never**, **Daily**, **Every weekday**, **Weekly**, **Monthly**, **Yearly** or **Custom…**. Weekly, Monthly and Yearly follow the task's date, which is also the first date (today if it has none). A yearly repeat on Feb 29 falls on Feb 28 in other years. Changing an existing repeat to Yearly keeps the month and day of the series' first date, which the picker shows. A task's time applies to every occurrence.

A subtask cannot repeat, but a repeating task can have subtasks: they come back unchecked each time. A repeating task has no deadline, so Logwell removes one and says so.

## Type a repeat

| You type | It repeats |
| --- | --- |
| `every day`, `every weekday`, `every weekend` | Daily, Monday to Friday, or Saturday and Sunday |
| `every morning`, `every evening`, `every night` | Daily, with no time |
| `every week`, `every month`, `every year` | On the task's weekday, day of the month, or month and day |
| `every 3 days`, `every 2 weeks`, `every 6 months`, `every 2 years` | At that interval, up to 999 |
| `every other day`, `every other week`, `every other friday` | Every second day, week or Friday |
| `every mon wed fri`, `every mon, wed and fri`, `every tuesday & thursday` | On those weekdays |
| `every week on mon, fri`, `every 2 weeks on tuesday` | On those weekdays, every week or every N weeks |
| `every 15th`, `every 1st of the month`, `every month on the 15th`, `every 3 months on day 5` | On that day of the month |
| `every first monday`, `every last friday of the month`, `last friday of the month` | On that weekday of the month: first to fourth, or last |
| `every last day of the month` | On the month's last day |
| `every year on May 5`, `every year on the 29th of February` | Yearly, starting on that date. A date with no year starts on its next one, so Feb 29 starts on the next leap day |

At the end of the text, after the title, a single word also repeats: `daily`, `weekly`, `fortnightly`, `monthly`, `yearly`, `annually`, `weekdays`, `weekends`, or weekdays in the plural such as `mondays` or `mondays and fridays`. So `Stretch daily` repeats, but `Daily standup` keeps its title.

Add a time with `at`, such as `every monday at 9am`. For a bare hour from 1 to 12, such as `at 9`, Quick Add asks whether you mean 09:00 or 21:00. Start on another date with `starting`, such as `every monday starting next week`.

End the repeat in the same line:

| You type | It ends |
| --- | --- |
| `until Dec 1`, `till Dec 1`, `ending Dec 1`, `ends on Dec 1` | On that date, the last occurrence included |
| `for 5 times`, `5 times` | After 5 times |
| `for 2 weeks`, `for 3 mondays`, `for 6 months` | After that many weeks, Mondays or months from the task's first date: the date you type, pick or the view gives, else today. Only after the repeat: `Plan meals for 7 days every sunday` keeps "for 7 days" in the title |

An end that leaves no occurrence, such as `every friday until Wednesday` typed on a Monday, is refused: its chip says so, the text stays in the title, and the task cannot be saved until you fix the end or remove its chip. A count goes up to 999 times. Without a repeat, `until Dec 1` is a deadline, `ending` and `starting` stay part of the title, and `for 30m` is always a duration. If you picked the repeat in the picker, a typed `until` date ends it (`for …` stays text), and an end that leaves the picked repeat no occurrence is refused the same way; when the picked repeat already has an end, the typed one is offered as a replacement.

A repeat Quick Add cannot make yet, such as `every 3 hours` or `every 2nd and 4th tuesday`, stays in the title marked "Recurrence not supported yet", and is never read as a date. Counting from completion is set in the picker.

## Set a custom repeat

Choose **Custom…** in the picker:

- **Every**: a number from 1 to 999, and days, weeks, months or years. Years repeat on the month and day of the task's date; for a task that already repeats, the month and day of the series' first date, as the summary shows.
- **On**: for weeks, the weekday buttons; pick none to use the weekday of the task's date. For months, **Day N**, such as Day 15 (from the 29th on, a shorter month uses its last day), **The** first to fourth or last weekday, or **The last day of the month**.
- **Count from when I complete it**: see below.
- **Ends**: **Never**, **On date** or **After** 1 to 999 times.

Choose **Done** or **Back**. **Done** is off while a value is missing or the repeat would end before its first date.

Weeks begin on the **Week starts on** [setting](settings-and-commands.md) in force when you make the repeat.

## Count from when you complete it

By default the schedule is fixed: "every Monday" stays on Mondays however late you finish. With **Count from when I complete it**, the next date counts from the day you finish. With every 3 days, finishing on Oct 5 gives Oct 8, and finishing late on Oct 10 gives Oct 13. A skip counts from the day you skip. The option is off for fixed days: picked weekdays, a weekday of the month or the last day.

## End a repeat

**On date** allows occurrences up to that date. **After** N times counts completed and skipped occurrences. At the end, the task is completed and the notice says "The series has ended." Logwell also completes series with no dates left, on open and hourly; an unfinished last occurrence stays overdue.

## Complete or skip an occurrence

Tick the checkbox, press Cmd+Enter (Ctrl+Enter) on the row, or choose **Complete** in the row menu. The task moves to its next date.

If you fall behind on a fixed schedule, completing marks the earliest missed date done and skips the others before today, and the notice says how many. A repeat that counts from completion never skips dates on its own.

**Skip this occurrence** in the row menu records the date as skipped. Every notice has an Undo button.

## Change or stop a repeat

**Edit repeat…** in the row menu opens the picker in the details pane. A change applies from today; past records keep their rule. **Never** turns the task into a plain task on its current date.

**Stop repeating** asks you to confirm, then completes the task, keeping its history. Reopening it makes it repeat again.

## Move a repeating task to another day

Changing the date in the **Scheduled** field, with **Schedule for today**, **Schedule for tomorrow** or **Schedule for next week**, or by dragging on a board or list moves the whole series to repeat from that date. An end that leaves no occurrence is removed. You cannot move one occurrence alone or clear the date.

## Review and reopen past occurrences

Each completed occurrence adds a row to the Completed group of the task's views. Right-click it for **Open details** or **Reopen**, which makes the date due again and reopens a series that record had ended. Skipped occurrences are not listed. See [Views](views.md).

## In lists and the calendar

**Today** lists the task while its current date is today or earlier, and **Upcoming** lists it once. The [matrix](matrix.md) uses its current date. The [calendar](calendar.md) shows its occurrences.

## Duplicate or delete a repeating task

**Duplicate** makes a copy without history, starting on the current occurrence if that is not past, else the next date from today. It keeps the end, unless the end would come before the copy's first date: then the copy never ends. A copy of a yearly repeat on Feb 29 repeats on Feb 28, so in leap years it is one day before the original. **Delete** moves the task and its history to the Trash; deleting it for good removes both. The [CSV export](export.md) lists every done or skipped occurrence.
