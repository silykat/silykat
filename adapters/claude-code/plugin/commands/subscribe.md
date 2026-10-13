---
description: Subscribe this session to a branch (or, outside git, a file or folder) for silykat, so that the user's comments there come to it
argument-hint: '[folder or file] [--path]'
allowed-tools: Bash(slk:*)
---

Subscribe this session to silykat comments.

Run `slk subscribe $ARGUMENTS` (with no argument, it subscribes to the branch of the current folder; `--path` subscribes to the folder or file itself, and outside git it is always the path). Then tell the user, in one short sentence, what the session is now subscribed to, as `slk` printed it.

If the user did not say what to subscribe to and the current folder is not what they mean, ask them which repository, branch or folder first.
