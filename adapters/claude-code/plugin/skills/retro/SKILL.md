---
name: retro
description: Run a retro with the user on the review feedback they gave you in Local Review (their code review threads in VS Code) since the last retro, to improve your setup together (CLAUDE.md, CLAUDE.local.md, skills, hooks…). Use when the user asks for a retro, a retrospective, or to improve your setup from their review comments.
allowed-tools: Bash(lr:*), Bash(lr-retro:*)
---

# Run a retro of the review feedback

Like a sprint retro, but between the user and you: look back at the review threads of a period, find what in your setup caused the feedback, and decide **together** what to keep, remove or improve. It is a discussion, not a report: nothing changes without the user's say-so, and what they validate, **you** apply.

The heavy reading is done by two sub-agents with a fresh context (classification, then analysis); you only see their proposals, so that your context stays free for the discussion. `lr retro` (on your PATH) keeps the retro's journal and checks the proposals by program.

**The project** is the folder this session was started in (your primary working directory), even if you moved since. Pass it as `--root <dir>` to every `lr retro` and `lr-retro` command below. Ask the user questions with the AskUserQuestion tool, the recommended option first, labelled "(Recommended)". Talk in the user's language.

## 1. Where things stand

Run `lr retro scope --root <dir>`. It prints the period (since the last retro), the comment stores found, the threads, the size, an estimate of the time, the last retro and the user's retro preferences.

If it lists an **unfinished retro**, ask whether to continue it (run `lr retro show <id> --root <dir>` and resume at the step where it stopped) or to start a new one.

If the period holds **no thread** (nothing was commented since the last retro), there is nothing to look back at: say so in one sentence. When there is a last retro, still offer question 2 of step 2 (changing the retro itself) and save the preferences; skip question 1, which the next retro will ask once there is new feedback. Then stop: no retro is started.

## 2. Feedback on the last retro (only when there is one)

Before anything else, show in two or three lines what was decided last time (the "Last retro" section), then ask, in one AskUserQuestion call:

1. "Did you notice the improvements decided last time?" — "Yes, they helped" / "Partly" / "Not really" / "Not noticed yet".
2. "Do you want to change anything in the retro itself (what it looks at, its level of detail, subjects to ignore…)?" — "No, keep it as it is" / "Yes" (then ask what, in their words).

Save each wish as a short instruction, one per preference, with one plain command (no heredoc, nothing chained: those need the user's approval):

```bash
lr retro prefs add --root <dir> --body "Show at most 5 proposals, the most important first."
```

Remove the ones they no longer want with `lr retro prefs remove <id> --root <dir>`. **Apply the preferences from now on**, in this retro too. Keep their answer to question 1 for step 4.

## 3. The scope: first validation

Announce, in a few lines: the project, the comment stores found, the period, the number of threads, the size and the estimated time. For a **first retro**, `lr retro scope` lists periods to choose from: ask which one (the proposed one recommended). Then ask to confirm: "Start the retro" / "Change the period" / "Cancel". For another period, run `lr retro scope --root <dir> --since <date>` (or `--all`) and announce it again.

## 4. Start

```bash
lr retro start --root <dir> [--since <date> | --all]
```

It prints the retro id (`rt_…`). If the user answered question 1 of step 2, record it in a sentence: `lr retro feedback <id> --root <dir> --body "<their answer>"`.

## 5. The audit and the classification

First, start **the audit of your setup** in the background: run `lr-retro audit <id> --root <dir>` with the Bash tool's `run_in_background` option. It runs `/doctor prompt-audit` in a separate Claude Code, read-only, which looks for stale, contradictory or duplicated rules in the CLAUDE.md files, skills, agents and commands. It takes several minutes: it runs while the threads are classified. Say so in one sentence.

Then the classification (a sub-agent). Run `lr retro key`. It tells whether a key of **Jev** is set up (a classification service: faster and cheaper than a model of the user's subscription; without it, Haiku does the job).

- **Ready**: the classifier is `jev`.
- **No key**: in two sentences, say what Jev brings and that Haiku works without it, then ask: "Continue with Haiku (Recommended)" / "Set up a Jev key first". To set one up:
  - propose the place `lr retro key` printed (`~/.config/local-review/jev-key`), and give the command it printed, to run **in their own terminal**, not here and not with `!`: it asks for the key without showing it and saves it in a file only they can read;
  - **the key must never go through this conversation**: never ask for it, never read, print or open the key file. If the user pastes a key here anyway, tell them it is now in the conversation's transcript and that they should create a new one;
  - when they say it is done, run `lr retro key` again; if it says the file is not safe, give them the fix it prints.
- **Not safe** (readable by others, or inside a repository): give the fix `lr retro key` prints; use Haiku until it is fixed.

Then launch the sub-agent **`local-review:retro-classifier`** (Agent tool), with this prompt: `Retro <id>, project <dir>, classifier: jev` (or `haiku`). Wait for its one-line summary before going on. If Jev failed for every thread, launch it again with `classifier: haiku`.

## 6. Analysis (another sub-agent, fresh context)

Wait for **the audit** to end (you are told when the background command finishes). It prints the path of its report (`Written: …/audit.md`), or says it was skipped or failed: then go on without it, and tell the user why in one sentence.

Launch the sub-agent **`local-review:retro-analyst`** with this prompt: `Retro <id>, project <dir>, audit: <path of the report>` (without the audit: `Retro <id>, project <dir>.`). It reads every thread of the period together, your whole setup, the audit, the classification, the statistics, the previous retros and the preferences, and records its proposals with `lr retro propose`, which applies the guard rails by program.

**Never do the analysis yourself**, and never read the threads, the inputs or the audit: your context is for the discussion. If a sub-agent was blocked (a command refused), tell the user which command it needs (they can allow `lr` and `lr-retro` commands, and the writing of the retro's files in `.local-review/retros/`), then launch it again. If nothing could be recorded, tell the user and stop (`lr retro finish`).

## 7. The proposals

Run `lr retro show <id> --root <dir>`. Give an overview first: how many proposals in **To keep**, **To remove** and **To improve** (and how many come from the audit of the setup), and the subjects **to watch** (preferences seen in a single thread: not proposed, kept for the next retros).

## 8. The discussion: second validation, one proposal at a time

The user decides on what they read: **always the same presentation, and always the exact change**. For each proposal, until `lr retro show` says all are decided:

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
5. **Apply it right away**, exactly as shown, then record the decision and the files (step 9). Then confirm in **one line** (e.g. "p3 applied to `src/CLAUDE.md`."), and go on with the next proposal in a new message.

An excluded subject is never proposed again, unless new feedback raises it. Record it with the user's reason when they give one.

## 9. Apply what was validated

Each change is applied as soon as the user validates it (step 8), **exactly the text they read**: no rewording, nothing more. Where it goes:

- **project, shared**: the `CLAUDE.md` of the repository concerned, or its `.claude/` (skills, commands, agents; hooks in `.claude/settings.json`);
- **project, personal**: `CLAUDE.local.md` in that repository (check that git ignores it: `git check-ignore -q CLAUDE.local.md`, else add `CLAUDE.local.md` to `.git/info/exclude`, never to `.gitignore`), or the `CLAUDE.md` of a parent folder that is in no repository; hooks in `.claude/settings.local.json`;
- **you, in every project**: `~/.claude/CLAUDE.md`, `~/.claude/` (skills, agents; hooks in `~/.claude/settings.json`).

A "keep" changes nothing. A hook or a script must work: run it once on a sample input (a scratch copy for anything that writes data). Never commit, and never change what the user did not validate. Record each decision and the files changed as soon as it is applied:

```bash
lr retro decide <id> <proposal> accepted --root <dir>
lr retro decide <id> <proposal> modified --root <dir> --note "what changed"
lr retro decide <id> <proposal> retargeted --root <dir> --target project-personal
lr retro decide <id> <proposal> excluded --root <dir> --note "why, in the user's words"
lr retro applied <id> <proposal> --root <dir> --file <path> [--file <path>…]
```

`<proposal>` is the proposal's **id**, in parentheses in its heading (`Proposal 4/6 (p5)` is `p5`), never its position. A decision recorded on the wrong proposal is undone with `lr retro undo <id> <proposal> --root <dir>` (it forgets its files too). **Never edit the retro's files by hand**: the journal is append-only.

## 10. Finish

Run `lr retro finish <id> --root <dir>` and show the user what it printed: **the list of files changed**, and the subjects to watch. Tell them the next retro will start from this one: it will ask whether these changes helped.
