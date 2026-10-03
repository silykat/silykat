# Architecture

How Local Review works, for maintainers and contributors. For using it, see the [README](../README.md).

## Overview

Local Review has one rule: **everything specific to an agent lives in an adapter**. The storage, the command line and the VS Code extension are agent-neutral; Claude Code is plugged in through `adapters/claude-code`. Another agent (e.g. Codex) would come as another adapter, on the same storage, command line and session registry.

```mermaid
flowchart LR
  subgraph neutral["Agent-neutral"]
    core["packages/core<br/>model, journals, stores,<br/>re-anchoring, sessions, topics,<br/>history, retros"]
    cli["packages/cli<br/>lr, the agents' entry point"]
    ext["packages/vscode-extension<br/>the VS Code UI"]
  end
  subgraph claude["adapters/claude-code"]
    plugin["plugin: skills, sub-agents,<br/>commands, hooks, channel server,<br/>bundled lr and lr-retro"]
  end
  cli --> core
  ext --> core
  plugin --> core
  plugin --> cli
```

| Folder                      | Purpose                                                                                                                           | May depend on |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `packages/core`             | Data model, append-only journals, stores, re-anchoring, session registry, topics and routing, history, retros. No VS Code import. | nothing       |
| `packages/cli`              | `lr`: what agents run to read and answer threads, read a project's history, run a retro, and subscribe.                           | `core`        |
| `packages/vscode-extension` | Comment threads in the editor, reviews, diffs, deliveries to agent sessions.                                                      | `core`        |
| `adapters/claude-code`      | The Claude Code plugin (skills, sub-agents, commands, hooks, channel server) and their TypeScript sources.                        | `core`, `cli` |

`scripts/check-boundaries.mjs` (run by `npm test`) fails when a package imports what it must not.

## Storage

Everything is plain files. There is no database and no server.

### A project's store: `<root>/.local-review/`

The root is the git top level of an open folder (or the folder itself outside git).

```text
.local-review/
  schema-version            the format version (1)
  threads/<thread-id>.jsonl one append-only journal per thread
  reviews/<review-id>.jsonl one append-only journal per review
  retros/<retro-id>.jsonl   one append-only journal per retro (see "Retros")
  retros/preferences.jsonl  the user's retro preferences (append-only)
  retros/<retro-id>/        what a retro wrote for its agents (regenerated)
  saved/<slot>/             threads saved from a git worktree before its removal (see below)
```

A thread journal is a list of events: `thread.created` (with its anchor and branch), `comment.added`, `comment.edited`, `comment.deleted`, `status.changed`, `anchor.updated`, `branch.changed`, `thread.deleted`. The state of a thread is the fold of its events (`core/src/fold.ts`). Appending is atomic enough for several writers (the editor and agents), a line cut by a crash is ignored, and nothing is ever rewritten: deleting a thread is an event too. `thread.deleted` carries an optional `reason`: `user` (the user deleted the thread, or its last comment) or `branch-gone` (the editor deleted it because its git branch was deleted). It is an optional field, so the format version is unchanged; journals written before have none (the history says "reason unknown", except when the last comment was deleted in the same write, which can only be the user). In the same way, an agent's `comment.added` carries an optional `session`: `{ id, message? }`, the agent's conversation it was written in (see "The link to the agent's conversation").

A review journal holds `review.started`, `review.branch.changed`, then `review.submitted` or `review.discarded`. A review is about a branch, or, for files not tracked by git (outside git, or ignored), about a folder: the direct parent of the files (`path`, relative to the root). There is at most one review in progress per branch, and per folder. A draft is a comment whose `reviewId` is a review in progress. Reviews started off any branch by earlier versions have no folder: they cover no file, and can still be submitted or discarded.

A thread's **anchor** records its file (relative to the root), the version it is about (working tree, index, `HEAD` or a commit, and which side of a diff), its line range, the commented code and a few lines of context. Re-anchoring (`core/src/reanchor.ts`) finds the code again after changes: exact match, moved, then whitespace-insensitive; otherwise the thread is outdated.

A thread's **branch** (`repo`, `branch`) is the branch of its file when it was created: `repo` is the git common directory, shared by all the worktrees of a repository.

### A project's history

`lr history` (`projectHistory` in `core/src/project.ts`) reads every store of a **project**: a folder, its subfolders (hidden folders, dependencies, build outputs and the macOS `Library` and `Applications` folders skipped), and the git worktrees of the repositories found there (`git worktree list`), even outside the folder. When the folder itself has no store, the closest one above it counts too, as for the other `lr` commands. Each store is read once (by its real path). There is no index: finding the stores and folding a few hundred threads takes well under a second.

A thread's history (`threadHistory` in `core/src/history.ts`) is a second fold of its journal, next to `foldThread`: it keeps everything published, in order (comments with their edits and deletions, status changes, the thread's deletion), and leaves out the drafts of reviews in progress or discarded, as well as what was deleted or reworded while still a draft of a review submitted later. A thread is active in a period when something was published in it then; moving its code is not activity.

### Threads saved from git worktrees

`git worktree remove` deletes a linked worktree's folder, and its `.local-review/` with it. `saveWorktreeThreads` (`core/src/worktrees.ts`; `lr worktree save`, the extension's **Save Worktree Threads**, and the Claude Code hook) copies the journals of every store of the worktree (`threads/` and `reviews/`, the latter so that drafts stay drafts) to the store of the repository's **main worktree** (the first of `git worktree list`; none for a bare repository), in `saved/<slot>/`, one slot per store saved (its folder name and a hash of its path). `origin.json` records where they come from: the worktree, the store's folder (anchors are relative to it), the repository, the branch at the last save, and when it was first and last saved. Saving again copies the journals again (they only grow), and never removes anything.

The editor neither reads nor watches `saved/`: the copies are never shown, nor changed when a branch is deleted. The history (`projectStores`) adds the saved stores found in each store of the project, with origin `saved`; a thread found in several stores (its worktree still exists) counts once, from its longest journal (journals only grow), and a saved store whose threads are all still in their worktree is left out. Older versions ignore `saved/`: the format version is unchanged. Creating the main store first adds `.local-review/` to `.git/info/exclude` (`prepareStoreHome`, shared with the retros).

### The machine folder: `~/.local-review/` (or `$LOCAL_REVIEW_HOME`)

```text
~/.local-review/
  config.json                   the settings of this machine (lr config), read by the agent hooks
  files/                        the store of files outside any open folder (rooted at "/")
  sessions/<id>.json            a running agent session
  sessions/<id>.subscriptions.jsonl   what it is subscribed to (append-only)
  sessions/<id>.inbox.jsonl     its message queue (append-only)
  sessions/<id>.note-*          small notes an adapter keeps between two hooks
```

## Retros

A retro looks back at the review feedback of a period and turns it into changes to the agent's setup, decided with the user. The data, the journal, the preferences and the guard rails are agent-neutral (`core`, `lr retro`); the conversation, the sub-agents and the files changed are the agent's (for Claude Code: the `retro` skill, the `retro-classifier` and `retro-analyst` sub-agents, and `lr-retro`).

```mermaid
sequenceDiagram
  participant U as You
  participant S as Retro session (skill)
  participant L as lr retro
  participant C as Classifier sub-agent
  participant A as Analyst sub-agent
  S->>L: scope (period since the last retro, stores, size, time)
  S->>U: feedback on the last retro, then the scope to confirm
  S->>L: start (the period's thread ids are recorded)
  S->>C: classify (Jev through lr-retro jev, or itself)
  C->>L: input --for classify, then classification
  S->>A: analyse (fresh context)
  A->>L: input --for analysis + lr-retro setup, then check and propose
  L->>L: guard rails, numbers of each proposal
  S->>L: show
  S->>U: one proposal at a time
  U->>S: accept, modify, exclude, change the target
  S->>L: decide, then applied (files changed), then finish
```

- **Where**: the store of the project folder when it has one, or when it is outside git; else the store at the top of its git worktree (`retroHome`). Creating that store at the top of a repository adds `.local-review/` to `.git/info/exclude` first. Older versions never read `retros/`, so the store's format version is unchanged; retro events carry their own `v`.
- **The journal** (`RetroBook`, `core/src/retro.ts`): `retro.started` (project folder, period, stores, thread ids, preferences in force), `retro.feedback`, `retro.classified` (labels, possibly in several passes), `retro.proposed` (proposals, watch list, what the guard rails left out), `retro.decided`, `retro.applied` (files changed), `retro.finished`. The next retro starts just after the `until` of the last finished one of the same folder.
- **The inputs** (`core/src/retroScope.ts`): `lr retro input` writes, in `retros/<id>/`, the threads with their conversation (`threadText`), and, for the analysis, the preferences, the previous retros (decisions, exclusions, watch list) and statistics computed without a model (reopened threads, questions of the agent, back-and-forth, deleted: by the user, or with their branch). Threads saved from a removed worktree are read like the others, their store marked as saved. The agent writes its answer as a JSON file next to it, and records it with one plain `lr` command.
- **The guard rails** (`checkProposals`, `core/src/retroGuards.ts`), applied by `lr retro check` and `lr retro propose` whatever the agent: at least 2 threads of the period (a single one goes to the watch list); a "keep" whose rule had to be enforced (cited in `enforcedIn`, or classified as an ignored rule) becomes "improve"; one cause per proposal; a new rule's target is asked unless a thread supports it; a subject excluded earlier (same reference, similar wording, or 2 of its threads) comes back only with 2 new threads, neither proposed nor watched before that. Each proposal's numbers are computed from its threads.
- **The classification**: the labels (one of 14 categories, plus two scores: a project rule missing from the rules files, an existing rule ignored) feed the statistics and the "keep" guard rail. With a key, `lr-retro jev` asks [Jev](https://jevtypesafeai.com/), 4 requests at a time: the only network call of Local Review, in the adapter, never in `core`, `lr` or the extension. The key (`~/.config/local-review/jev-key`, or `$JEV_API_KEY`) is checked without being read by `lr retro key` (owner only, in no repository), and read only by `lr-retro jev`, which never prints it.
- **The agent's conversations** (`lr-retro conversation`, see below): for an ambiguous thread whose replies are linked to a conversation, the analyst reads it back; `retro.conversation` records whether it was still available, and `lr retro show` lists them.
- **The setup** (`lr-retro setup`, `adapters/claude-code/src/retroSetup.ts`): the rules files (`CLAUDE.md` of the folder, its parents and repositories, `CLAUDE.local.md`, `~/.claude/CLAUDE.md`), then the `.claude/` and `.agents/` folders of the project and of the user (`$CLAUDE_CONFIG_DIR` when set): rules, skills, commands, sub-agents, and only the `hooks` of the settings files (the rest may hold secrets). Rules and hooks are given in full; skills, commands and sub-agents too until about 100 KB, then by their header only.

## Agent sessions

### Registration

An adapter registers each agent session (`SessionRegistry` in `core/src/sessions.ts`): id, agent name, folder, branch, process id, and whether messages reach it on their own (`push`). A session whose process is gone is dropped at the next read. For Claude Code, the `SessionStart` and `SessionEnd` hooks do it; `lr session register | unregister` exists for other adapters.

### Topics and subscriptions

A **topic** (`core/src/topics.ts`) is a branch of a repository, or a path outside git (files ignored by git count as outside git: they do not change with the branch). A session subscribes to topics, with a reason kept for debugging: `launch` (started in a worktree), `modified` (it modified a file there), `user` (asked by the user). `subscribersOf` returns every session subscribed to the topic of a file: the extension publishes to all of them and never picks between them.

### Publishing a comment

```mermaid
sequenceDiagram
  participant U as You (VS Code)
  participant X as Extension
  participant Q as Session queue<br/>(sessions/<id>.inbox.jsonl)
  participant C as Channel server
  participant A as Claude Code
  U->>X: Comment / Submit Review / edit / delete
  X->>X: topic of each thread's file → subscribed sessions
  X->>Q: one small message per session: store, thread ids, kind
  C->>Q: polls (0.5 s), batches (1.5 s)
  C->>A: notifications/claude/channel
  A->>A: runs the review skill: lr list / show, edits code
  A->>X: lr reply (written to the thread journal, watched by the extension)
```

The message only points at threads; the agent always reads their current content with `lr`, so it never works on a stale copy. The queue has **one consumer**, the channel server, which acknowledges by advancing a cursor. Claude Code hands a channel message to Claude between two of its steps, even while it works.

### The link to the agent's conversation

`lr reply` records, on the agent's `comment.added`, the session it runs in (`--session`, `$LR_SESSION`, or the registered session among its parent processes) and, when known, the message that runs it (`--message`, or the call its adapter noted: `SessionRegistry.startCall`, picked by `callFor`, the latest recent call naming the thread). It is a best effort: a reply never fails for want of it. `lr history` shows it, and the analysis input of a retro marks the threads whose conversation is linked. Reading a conversation is the adapter's business: `core` and `lr` only keep the ids.

For Claude Code, the session id is Claude Code's own, and the message is the id of the tool call that ran `lr reply`: the `PreToolUse` hook notes it (`call-<id>` note of the session, removed by `PostToolUse` and with the session). `lr-retro conversation` (`adapters/claude-code/src/retroConversation.ts`) finds the transcript (`<claude dir>/projects/*/<session>.jsonl`, sub-agents' ones included), locates the reply (its tool call, else the latest `lr` command naming the thread), and prints the prompt of that turn, the steps up to the reply and right after it (texts, tool calls and the start of their results), the skill in use and the tokens, within about 12,000 characters. Transcripts are an internal format of Claude Code, read nowhere else; Claude Code deletes them after `cleanupPeriodDays` (30 days by default), and then the retro says so and does without.

`lr reply --rev <version>` guards against races: a thread's version (`AgentThreadView.rev`) changes only when the user publishes, edits or deletes a comment in it, and a reply to an older version is refused (exit code 3).

## The Claude Code adapter

`adapters/claude-code/plugin` is what Claude Code installs (from the marketplace in `.claude-plugin/marketplace.json`):

| Part                                              | Role                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills/review/SKILL.md`                          | How Claude handles a review: read, act, reply with `--rev`, subscriptions, special cases, the history.                                                                                                                                                                                                                                                                          |
| `skills/retro/SKILL.md`, `agents/retro-*.md`      | `/local-review:retro`: the retro's conversation, and its two sub-agents (classification with Haiku, analysis with Sonnet).                                                                                                                                                                                                                                                      |
| `commands/subscribe.md`, `unsubscribe.md`         | `/local-review:subscribe` and `/local-review:unsubscribe`.                                                                                                                                                                                                                                                                                                                      |
| `hooks/hooks.json` → `hooks/local-review-hook.js` | `SessionStart` (register, subscribe to the worktree of launch), `PreToolUse`/`PostToolUse` (subscribe on file changes, including shell commands via `git status`), `SessionEnd`. A new subscription is told to Claude (`additionalContext`). `PreToolUse` also saves the threads of a git worktree about to be removed (see below), and notes the tool call running `lr reply`. |
| `.mcp.json` → `channel/local-review-channel.js`   | The channel server: a minimal MCP server over stdio (no SDK), serving the session of the Claude Code process that started it.                                                                                                                                                                                                                                                   |
| `bin/lr`                                          | The bundled command line, on Claude's `PATH`.                                                                                                                                                                                                                                                                                                                                   |
| `bin/lr-retro`                                    | What is Claude Code's in a retro: its setup files (`setup`), the classification by Jev (`jev`), and the conversation of a thread's replies (`conversation`).                                                                                                                                                                                                                    |

The bundles are built by `adapters/claude-code/build.mjs` and **committed**, because Claude Code installs plugins from git. `scripts/check-plugin-bundle.mjs` (run by `npm test`) rebuilds them elsewhere and fails when the committed ones are stale.

**Before a worktree is removed**: `PreToolUse` runs before the tool, and Claude Code waits for it. On `Bash`, the hook reads the command (`worktreeRemovals` in `adapters/claude-code/src/hook.ts`, a best effort: simple commands split on `&&`, `;`, `|`…, quotes, `cd`, `git -C`; not globs nor variables) for `git worktree remove <path>` (a path, or the end of a worktree's path, as git allows) and `rm -r <path>` of a worktree's top folder; on `ExitWorktree` with `action: "remove"`, the session's own worktree. For each linked worktree found, it saves its threads, unless `autoSaveWorktrees` is off in the machine settings (`config.json`, on by default); then it only tells Claude that they will be lost. The hook never blocks the command.

Whether a session was launched with the channel cannot be asked to Claude Code: the `SessionStart` hook reads the command line of the `claude` process instead. `lr` finds the session it runs in by walking up its parent processes to a registered process id.

## The VS Code extension

- `controller.ts`: the comment controller: creating, replying, editing, reviews (one per branch; off any branch, one per folder), re-anchoring as documents change, git versions and aliases, rename following, branch tracking (threads of other branches are kept but hidden; anchors are never written from another branch's content).
- `deliveries.ts`: publishing to subscribed sessions, the "nobody is subscribed" prompt, `pushToAgents`.
- `branches.ts`: which branch is checked out where (polled every 2 s).
- `sessions.ts`, `agentReplies.ts`, `review.ts`: the status bar items and their menus.
- `roots.ts`: stores of the open folders, plus the machine store as the last resort.
- Worktrees (`controller.ts`): the first time an open linked git worktree has comments (at load, or on a new comment), a message says that removing it deletes them, with **Save Threads Now**; each worktree is warned once (remembered in the extension's global state). **Save Worktree Threads** saves the open worktree (or one picked among them). A branch deleted while VS Code runs deletes its threads with the reason `branch-gone`.
- `watcher.ts`: stores are watched for writes by agents, with Node's watcher (VS Code's misses some writes of other processes on Linux). A store that does not exist yet, or was removed, is waited for from its parent folder.
