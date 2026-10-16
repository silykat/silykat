---
description: Subscribe this session to the branch of a folder (or, outside git, to a file or folder) for silykat, so that the user's comments there come to it
argument-hint: '[folder or file] [--path]'
allowed-tools: Bash(slk:*)
---

Subscribe this session to silykat comments.

Run `slk subscribe $ARGUMENTS` (with no argument, it subscribes to the branch of the current folder; `--path` subscribes to the folder or file itself, and outside git it is always the path). Then tell the user, in one short sentence, what the session is now subscribed to, as `slk` printed it.

The argument is a folder or a file, never a branch name. To subscribe to another branch, pass a folder where that branch is checked out (a worktree): `slk` refuses a branch name and lists those folders. If the branch is checked out nowhere, tell the user and ask before creating a worktree.

If the user did not say what to subscribe to and the current folder is not what they mean, ask them which repository, branch or folder first.
