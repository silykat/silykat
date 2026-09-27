---
description: Unsubscribe this session from a branch, a path, or everything, for Local Review
argument-hint: '[folder or file] [--path] [--all]'
allowed-tools: Bash(lr:*)
---

Unsubscribe this session from Local Review comments.

Run `lr unsubscribe $ARGUMENTS` (with no argument: the branch of the current folder; `--all`: everything). Then tell the user, in one short sentence, what the session is no longer subscribed to, as `lr` printed it. Run `lr subscriptions` if they want to know what is left.
