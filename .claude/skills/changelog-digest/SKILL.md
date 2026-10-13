---
name: changelog-digest
description: Write the CHANGELOG digest of an epic pull request (epic/* into main) - one line per change visible to users, in the BEGIN_COMMIT_OVERRIDE block that release-please reads. Use when opening or updating the pull request of an epic branch, or when asked for the changelog of an epic.
---

# Changelog digest of an epic

An epic branch (`epic/<slug>`) gathers several user stories and reaches `main` as **one squashed commit**. release-please builds the CHANGELOG from the commits of `main`, but it reads a `BEGIN_COMMIT_OVERRIDE` … `END_COMMIT_OVERRIDE` block in the pull request description instead of the commit message, when there is one. Each line of that block becomes one CHANGELOG entry.

## 1. Gather what the epic changed

From the repository, with the epic branch fetched:

```bash
git log --no-merges --format='%s%n%b%n---' origin/main..origin/epic/<slug>
gh pr list --base epic/<slug> --state merged --json number,title,body --limit 100
```

The pull requests merged into the epic branch (one per user story) say what changed for the user and why; the commits give the details.

## 2. Write one line per change a user can see

- Conventional Commits, one change per line: `feat(<scope>): <description>`, `fix(<scope>): <description>`, `perf(<scope>): …`. Scopes: `core`, `cli`, `vscode-extension`, `claude-code`, or none.
- **Only the first line of each entry is shown in the CHANGELOG**: no body, no wrapped line. Say what the user gets, in their words ("comment a whole file", not "add FileThread class"), in English, imperative, lower case, no final period.
- Leave out what users do not see (refactoring, tests, CI, docs of the repository): those do not go in the block.
- A breaking change (the `.silykat/` format, the `slk` commands, the settings): `!` after the scope, and a `BREAKING CHANGE: <what to do>` line right after it.
- Several stories that make one feature: one line for the feature.

## 3. Put the block in the pull request description

Keep the rest of the description (what, why, how it was tested). Add or replace the block at the end.

**The two markers must appear only there**, nowhere else in the description, not even in a sentence: release-please takes the text after the first `BEGIN_COMMIT_OVERRIDE` it finds, and a sentence that names it breaks the whole CHANGELOG entry (seen on the first release). Name it "the changelog block" in the prose.

```
BEGIN_COMMIT_OVERRIDE
feat(vscode-extension): browse and reopen past reviews
feat(cli): list past reviews with slk review archive
fix(core): keep drafts when their file is renamed
END_COMMIT_OVERRIDE
```

Update it with `gh pr edit <number> --body-file <file>`, then show the user the lines, so that they check the wording before merging.
