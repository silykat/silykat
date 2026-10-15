---
description: Read back every review thread of a project, archive finished ones, export them to JSON, delete old ones for good, or keep no history at all.
section: guide
order: 3
---

# History, archive and clean-up

silykat keeps every thread you write, even after you resolve or delete it. That history is what your [retros](./retros.md) learn from. You decide what stays in VS Code, and what is kept on disk.

## Read your history

Ask Claude, for example: `show me this week's review comments`.

Or run it yourself, in a Claude Code session started in your project, with the `!` prefix:

```text
! slk review history --since 7d
```

You get every thread of the project, whatever its state: open, addressed, resolved, deleted or archived. Each one comes with its whole conversation, its branch, its file and the commented code. It starts with a summary: how many threads in each state.

- **The project** is the current folder, its subfolders, and the git worktrees of its repositories. Run it from a parent folder to cover several repositories.
- **`--since`** takes a date (`2026-10-01`) or a number of days (`7d`). Without it, you get everything.
- **Deleted threads** say why: **removed by you**, or **gone with their branch**.
- **Drafts** of a review you have not submitted never show.

`slk` comes with the Claude Code plugin. See [The slk command line](./cli.md) for how to run it.

## Archive finished threads

Archiving clears a thread from VS Code without losing it. Archived threads leave VS Code and what your agent sees, and stay in your history and in retros.

- **One thread**: click **Archive Thread** (the archive icon in its header).
- **Many threads**: run **silykat: Archive Resolved Threads…** and give a date: every thread resolved before it is archived. `2026-10-01` or `30d` (30 days ago) both work. It tells you how many first.
- **Bring some back**: run **silykat: Show Archived Threads** and pick them.

## Export your threads

Run **silykat: Export Threads (JSON)…**. Every thread of the open folders goes to a JSON file, whatever its state, archived ones included. Keep one before a clean-up.

## Delete old threads for good

Run **silykat: Delete Old Threads Permanently…** and give a date (`2026-10-01`, or `90d` for 90 days ago). It deletes the **finished** threads (resolved, archived or deleted) where nothing happened since that date. A confirmation tells you how many first.

It keeps:

- the threads still in progress, however old;
- the threads that hold a draft reply of your review in progress;
- the threads your next retro will read, once the project had a retro.

> [!WARNING]
> This cannot be undone. Deleted threads are gone from your history and from your retros too.

## Ask Claude

Claude can do all of this for you. Ask it to `archive my resolved comments of last month` or to `delete the comments older than 3 months`. It tells you how many threads it found and waits for your yes. For a deletion, Claude Code then asks you to allow it.

## Keep or erase what you delete

By default, silykat keeps what you delete, for your history and your retros. A deleted thread leaves VS Code and what your agent sees, but stays on disk.

If you do not want that (for example, if you do not run retros), turn the **`silykat.keepHistory`** setting off. Then:

- deleting a thread **erases** it for good;
- nothing is saved when an agent removes a worktree (you can still run **Save Worktree Threads** yourself);
- VS Code offers to erase the history already kept in your folders;
- your retros say that they do not see deleted threads.

The setting is for the whole machine.

## Good to know

- These commands act on each open folder (its subfolders and the worktrees of its repositories), and on the files outside the open folders.
- Without VS Code: `slk config set keep-history off` turns history off, and `slk review purge --history --yes` erases what was kept. See [The slk command line](./cli.md).
- An older version of silykat shows an archived thread read-only, and asks to be updated.
