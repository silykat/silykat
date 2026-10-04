---
name: retro
description: Run a retro with the user on the review feedback they gave you in Local Review (their code review threads in VS Code) since the last retro, to improve your setup together (CLAUDE.md, CLAUDE.local.md, skills, hooks…). Use when the user asks for a retro, a retrospective, or to improve your setup from their review comments.
allowed-tools: Bash(lr:*), Bash(lr-retro:*)
---

# Run a retro of the review feedback

Like a sprint retro, but between the user and you: look back at the review threads of a period, find what in your setup caused the feedback, and decide **together** what to keep, remove or improve. It is a discussion, not a report: nothing changes without the user's say-so, and what they validate, **you** apply.

The heavy work is done by sub-agents with a fresh context (classification, analysis, then applying each validated change in the background); you only see their proposals, so that your context stays free for the discussion. `lr retro` (on your PATH) keeps the retro's journal and checks the proposals by program.

**The project** is the folder this session was started in (your primary working directory), even if you moved since. Pass it as `--root <dir>` to every `lr retro` and `lr-retro` command below. Ask the user questions with the AskUserQuestion tool, the recommended option first, labelled "(Recommended)". Talk in the user's language.

## 1. Where things stand

Run `lr retro scope --root <dir>`. It prints the period (since the last retro), the comment stores found, the threads, the size, an estimate of the time, the last retro and the user's retro preferences.

If it lists an **unfinished retro**, ask whether to continue it (run `lr retro show <id> --root <dir>` and resume at the step where it stopped) or to start a new one.

If the period holds **no thread** (nothing was commented since the last retro), there is nothing to look back at: say so in one sentence. When there is a last retro, still offer the question of step 2 (changing the retro itself) and save the preferences. Then stop: no retro is started.

## 2. Feedback on the last retro (only when there is one)

Before anything else, show in two or three lines what was decided last time (the "Last retro" section). Whether those changes helped is **measured**, not asked: never ask the user how they felt about them. Then ask one AskUserQuestion: "Do you want to change anything in the retro itself (what it looks at, its level of detail, subjects to ignore…)?" — "No, keep it as it is" / "Yes" (then ask what, in their words).

Save each wish as a short instruction, one per preference, with one plain command (no heredoc, nothing chained: those need the user's approval):

```bash
lr retro prefs add --root <dir> --body "Show at most 5 proposals, the most important first."
```

Remove the ones they no longer want with `lr retro prefs remove <id> --root <dir>`. **Apply the preferences from now on**, in this retro too.

When `lr retro scope` says that this retro **will check the changes adopted** last time, tell the user in one sentence: the analysis will measure whether the feedback on their subject went down, and you will show it with its numbers.

## 3. The scope: first validation

Run `lr-retro sessions --root <dir>` (with the same `--since <date>` or `--all` as `lr retro scope`, if any): it counts your Claude Code sessions of the project in that period. Announce, in a few lines: the project, the comment stores found, the period, the number of threads, **the number of your sessions** (the retro reads what `/insights` knows of them), the size and the estimated time. When `lr retro scope` says the **history is not kept** on this machine, say so: the threads the user deleted are erased, so the retro does not see them. For a **first retro**, `lr retro scope` lists periods to choose from: ask which one (the proposed one recommended). Then ask to confirm: "Start the retro" / "Change the period" / "Cancel". For another period, run `lr retro scope --root <dir> --since <date>` (or `--all`) and `lr-retro sessions` with the same option, and announce it again.

## 4. Start

```bash
lr retro start --root <dir> [--since <date> | --all]
```

It prints the retro id (`rt_…`). If the user said something about the last retro's changes anyway, record it in a sentence: `lr retro feedback <id> --root <dir> --body "<their words>"`.

## 5. The audit and the classification

First, start **the audit of your setup** in the background: run `lr-retro audit <id> --root <dir>` with the Bash tool's `run_in_background` option. It runs `/doctor prompt-audit` in a separate Claude Code, read-only, which looks for stale, contradictory or duplicated rules in the CLAUDE.md files, skills, agents and commands. It takes several minutes: it runs while the threads are classified. Say so in one sentence.

Start **the reading of your sessions** in the background too: run `lr-retro insights <id> --root <dir>` with `run_in_background`. It runs Claude Code's `/insights` in a separate Claude Code (about a minute), then keeps what it knows of the sessions **of this project and of this period** only, for the analysis. Its report, which covers every project of the machine, is never read. Nothing to say about it to the user.

Then the classification (a sub-agent). Run `lr retro key`. It tells whether a key of **Jev** is set up (a classification service: faster and cheaper than a model of the user's subscription; without it, Haiku does the job).

- **Ready**: the classifier is `jev`.
- **No key**: in two sentences, say what Jev brings and that Haiku works without it, then ask: "Continue with Haiku (Recommended)" / "Set up a Jev key first". To set one up:
  - propose the place `lr retro key` printed (`~/.config/local-review/jev-key`), and give the command it printed, to run **in their own terminal**, not here and not with `!`: it asks for the key without showing it and saves it in a file only they can read;
  - **the key must never go through this conversation**: never ask for it, never read, print or open the key file. If the user pastes a key here anyway, tell them it is now in the conversation's transcript and that they should create a new one;
  - when they say it is done, run `lr retro key` again; if it says the file is not safe, give them the fix it prints.
- **Not safe** (readable by others, or inside a repository): give the fix `lr retro key` prints; use Haiku until it is fixed.

Then launch the sub-agent **`local-review:retro-classifier`** (Agent tool), with this prompt: `Retro <id>, project <dir>, classifier: jev` (or `haiku`). Wait for its one-line summary before going on. If Jev failed for every thread, launch it again with `classifier: haiku`.

## 6. Analysis (another sub-agent, fresh context)

Wait for **the audit** and **the reading of the sessions** to end (you are told when each background command finishes). The audit prints the path of its report (`Written: …/audit.md`), or says it was skipped or failed: then go on without it, and tell the user why in one sentence. The reading of the sessions needs nothing more when it succeeds: the analysis input includes the sessions. If it failed, go on without them and say so in one sentence; if it says the format of `/insights` could not be read, ask the user to report it as a bug of Local Review.

Launch the sub-agent **`local-review:retro-analyst`** with this prompt: `Retro <id>, project <dir>, audit: <path of the report>` (without the audit: `Retro <id>, project <dir>.`). It reads every thread of the period together, your whole setup, the audit, the classification, the statistics, the previous retros and the preferences, and records its proposals with `lr retro propose`, which applies the guard rails by program.

**Never do the analysis yourself**, and never read the threads, the inputs or the audit: your context is for the discussion. If a sub-agent was blocked (a command refused), tell the user which command it needs (they can allow `lr` and `lr-retro` commands, and the writing of the retro's files in `.local-review/retros/`), then launch it again. If nothing could be recorded, tell the user and stop (`lr retro finish`).

## 7. The proposals

Run `lr retro show <id> --root <dir>`.

**First, the check of the last retro's changes** (section "The last retro's changes: did they help?", when there is one): for each change adopted last time, give its numbers (the threads on its subject, out of all the threads, before and since) and the verdict: the feedback **stopped** or **decreased** (the change is kept), or **did not decrease** (the retro proposes to revise it: the proposal marked "Revises").

Then give an overview of the proposals: how many proposals in **To keep**, **To remove** and **To improve** (and how many come from the audit of the setup, and how many rest on your sessions: the line "The agent's sessions" of `lr retro show`), and the subjects **to watch** (preferences seen in a single thread: not proposed, kept for the next retros). When it lists **the agent's conversations read back**, say in one sentence which ambiguous threads the analysis explained from your conversation where you replied, and which conversations were no longer available (it did without them).

## 8. The discussion: second validation, one proposal at a time

The user decides on what they read: **always the same presentation, and always the exact change**. For each proposal, until `lr retro show` says all are decided (those that revise a change of the last retro come first: `--next` gives them in that order):

The user sees **neither the output of your commands nor your thinking**: only the text of your messages and your questions. Everything they must read goes there.

1. **A new visible message for each proposal**, never in your thinking. Run `lr retro show <id> --next --root <dir>` and write its output **word for word** as your message, from its `---` separator: the title, the source (threads with their excerpt, or the audit), the numbers, the file, the existing rule, the why, the target and the confidence. No recap of the previous proposal in it, no part skipped, no summary instead, nothing said as done before it is.
2. **The exact change**: read the file concerned and work out precisely what will change in it: the lines removed (`-`) and added (`+`), with two or three unchanged lines around to show where, as a `diff`. A new file: its whole content, with its path. A skill, a hook or a script: every file, in full. A "keep": "No change." Write it in the message, under the proposal.
3. **One AskUserQuestion**, always these four options, the recommendation first: "Accept" / "Discuss or modify" (description: "We talk it through or change the text; nothing is decided yet") / "Exclude" / "Change the target". When `lr` says the target is **to choose**, the "Accept" option names the suggested target (e.g. "Accept, in your personal rules (suggested)"). **Every option shows in its `preview` the exact change it leads to**, so that the user reads it next to the choice:
   - "Accept" and "Discuss or modify": the `diff` above (in the suggested target's file);
   - "Change the target": where it would go instead;
   - "Exclude": "No change."

   "Change the target" asks a second question: "Project, shared (committed, for the team)" / "Project, personal (yours, not committed)" / "You, in every project", each with the `diff` in **that** target's file in its `preview`.

   At the first proposal, say in one sentence that "Discuss or modify" (or typing their answer in the question) is how to talk a proposal through: it decides nothing. "Discuss or modify", "Chat about this" or a question typed in: discuss with them, refine the change, then ask again.

4. **A modified change, or another target, is shown again**: the whole new `diff` in the message and in the preview of "Apply this version", then ask again: "Apply this version" / "Change it again" / "Exclude". Never apply a version the user has not read.
5. **Record the decision** at once (step 9), then **hand the change to a sub-agent in the background** (step 9) and go straight on with the next proposal, in a new message: the user never waits for a change to be written.

An excluded subject is never proposed again, unless new feedback raises it. Record it with the user's reason when they give one.

## 9. Apply what was validated, in the background

Each change is applied as soon as the user validates it, **exactly the text they read**, by the sub-agent **`local-review:retro-applier`** (Agent tool, in the background), so that the discussion goes on meanwhile. Where it goes:

- **project, shared**: the `CLAUDE.md` of the repository concerned, or its `.claude/` (skills, commands, agents; hooks in `.claude/settings.json`);
- **project, personal**: `CLAUDE.local.md` in that repository, or the `CLAUDE.md` of a parent folder that is in no repository; hooks in `.claude/settings.local.json`;
- **you, in every project**: `~/.claude/CLAUDE.md`, `~/.claude/` (skills, agents; hooks in `~/.claude/settings.json`).

First record the decision:

```bash
lr retro decide <id> <proposal> accepted --root <dir>
lr retro decide <id> <proposal> modified --root <dir> --note "what changed"
lr retro decide <id> <proposal> retargeted --root <dir> --target project-personal
lr retro decide <id> <proposal> excluded --root <dir> --note "why, in the user's words"
```

Then, for a change to write (not for "keep" or "exclude"), launch `local-review:retro-applier` with a prompt that holds **the exact change the user read**, never a summary of it:

```text
Retro <id>, project <dir>, proposal <proposal>.
File: <absolute path>
Replace exactly:
<the text to replace, word for word, as in the file>
With:
<its replacement, word for word>
```

or, for a new file, `New file: <absolute path>` followed by its whole content. Several files: one block per file.

- **One file at a time**: before you show the diff of a proposal whose file a sub-agent is still changing, wait for that sub-agent to finish, so that the diff is computed on the file as it now is.
- When a sub-agent finishes, tell the user in **one line**, between two proposals (e.g. "p3 applied to `src/CLAUDE.md`."). If it could not apply the change (the file changed meanwhile), tell the user, show the diff again on the file as it is, and ask again.
- The sub-agent records the files changed itself (`lr retro applied`).

Never commit, and never change what the user did not validate.

`<proposal>` is the proposal's **id**, in parentheses in its heading (`Proposal 4/6 (p5)` is `p5`), never its position. A decision recorded on the wrong proposal is undone with `lr retro undo <id> <proposal> --root <dir>` (it forgets its files too). **Never edit the retro's files by hand**: the journal is append-only.

## 10. Finish

Wait for every `retro-applier` still running to finish. Then run `lr retro finish <id> --root <dir>` and show the user what it printed: **the list of files changed**, the subjects to watch, and what reading the sessions took (an equivalent at the API list price: on a subscription, tokens counted against the usage limits, not a bill). Tell them the next retro will start from this one, and will measure whether these changes helped from the feedback that follows. Local Review reminds them when it is due (VS Code's status bar, and you at the start of a session).
