---
name: retro
description: Run a retro with the user on the review feedback they gave you in Local Review (their code review threads in VS Code) since the last retro, to improve your setup together (CLAUDE.md, CLAUDE.local.md, skills, hooks…). Use when the user asks for a retro, a retrospective, or to improve your setup from their review comments.
allowed-tools: Bash(lr:*), Bash(lr-retro:*), Bash(claude --version)
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

When `lr retro scope` says that this retro **will check the changes adopted** last time, tell the user in one sentence: the analysis will measure whether the feedback on their subject went down, and you will show it next to their answer.

## 3. The scope: first validation

Announce, in a few lines: the project, the comment stores found, the period, the number of threads, the size and the estimated time. For a **first retro**, `lr retro scope` lists periods to choose from: ask which one (the proposed one recommended). Then ask to confirm: "Start the retro" / "Change the period" / "Cancel". For another period, run `lr retro scope --root <dir> --since <date>` (or `--all`) and announce it again.

## 4. Start

```bash
lr retro start --root <dir> [--since <date> | --all]
```

It prints the retro id (`rt_…`). If the user answered question 1 of step 2, record it in a sentence: `lr retro feedback <id> --root <dir> --body "<their answer>"`.

## 5. Classification (a sub-agent)

Run `lr retro key`. It tells whether a key of **Jev** is set up (a classification service: faster and cheaper than a model of the user's subscription; without it, Haiku does the job).

- **Ready**: the classifier is `jev`.
- **No key**: in two sentences, say what Jev brings and that Haiku works without it, then ask: "Continue with Haiku (Recommended)" / "Set up a Jev key first". To set one up:
  - propose the place `lr retro key` printed (`~/.config/local-review/jev-key`), and give the command it printed, to run **in their own terminal**, not here and not with `!`: it asks for the key without showing it and saves it in a file only they can read;
  - **the key must never go through this conversation**: never ask for it, never read, print or open the key file. If the user pastes a key here anyway, tell them it is now in the conversation's transcript and that they should create a new one;
  - when they say it is done, run `lr retro key` again; if it says the file is not safe, give them the fix it prints.
- **Not safe** (readable by others, or inside a repository): give the fix `lr retro key` prints; use Haiku until it is fixed.

Then launch the sub-agent **`local-review:retro-classifier`** (Agent tool), with this prompt: `Retro <id>, project <dir>, classifier: jev` (or `haiku`). Wait for its one-line summary before going on. If Jev failed for every thread, launch it again with `classifier: haiku`.

## 6. Analysis (another sub-agent, fresh context)

Launch the sub-agent **`local-review:retro-analyst`** with this prompt: `Retro <id>, project <dir>.` It reads every thread of the period together, your whole setup, the classification, the statistics, the previous retros and the preferences, and records its proposals with `lr retro propose`, which applies the guard rails by program.

**Never do the analysis yourself**, and never read the threads or the inputs: your context is for the discussion. If a sub-agent was blocked (a command refused), tell the user which command it needs (they can allow `lr` and `lr-retro` commands, and the writing of the retro's files in `.local-review/retros/`), then launch it again. If nothing could be recorded, tell the user and stop (`lr retro finish`).

## 7. The proposals

Run `lr retro show <id> --root <dir>`.

**First, the check of the last retro's changes** (section "The last retro's changes: did they help?", when there is one): for each change adopted last time, give its numbers (the threads on its subject, out of all the threads, before and since) and the verdict: the feedback **stopped** or **decreased** (the change is kept), or **did not decrease** (the retro proposes to revise it: the proposal marked "Revises"). Show it side by side with what the user felt (their answer to question 1 of step 2): say plainly when the numbers and their feeling disagree.

Then give an overview of the proposals: how many proposals in **To keep**, **To remove** and **To improve**, and the subjects **to watch** (preferences seen in a single thread: not proposed, kept for the next retros). When it lists **the agent's conversations read back**, say in one sentence which ambiguous threads the analysis explained from your conversation where you replied, and which conversations were no longer available (it did without them).

For stale or contradictory rules (the **To remove** column), Claude Code has `/doctor prompt-audit` since version 2.1.283: run `claude --version`, and when it is recent enough, suggest that the user runs `/doctor prompt-audit` after the retro (it audits CLAUDE.md files, skills, agents and commands, and proposes edits without applying them).

## 8. The discussion: second validation, one proposal at a time

Go through the proposals one by one: those that revise a change of the last retro first, then To improve, To remove and To keep. For each one, show:

- its title and column;
- its **source**: the threads cited, with their excerpt;
- its **numbers** (threads, reopened, questions, back-and-forth, since when);
- the **rule or file** concerned;
- the **why**: the common cause, and what the change must avoid;
- the change, the **target** and why, and its **confidence**.

Then ask one AskUserQuestion, the recommendation first: "Accept" / "Modify" / "Exclude" / "Change the target". When `lr` says the target is **to ask**, ask the target first: "Project, shared (committed, for the team)" / "Project, personal (yours, not committed)" / "You, in every project", the suggested one first. The user may also answer freely and discuss: answer, refine the proposal with them, then ask again.

Record each decision as soon as it is taken:

```bash
lr retro decide <id> <proposal> accepted --root <dir>
lr retro decide <id> <proposal> modified --root <dir> --note "what changed"
lr retro decide <id> <proposal> retargeted --root <dir> --target project-personal
lr retro decide <id> <proposal> excluded --root <dir> --note "why, in the user's words"
```

An excluded subject is never proposed again, unless new feedback raises it.

## 9. Apply what was validated

For each proposal accepted, modified or retargeted, **make the change yourself**, one change per subject, exactly as validated:

- **project, shared**: the `CLAUDE.md` of the repository concerned, or its `.claude/` (skills, commands, agents; hooks in `.claude/settings.json`);
- **project, personal**: `CLAUDE.local.md` in that repository (check that git ignores it: `git check-ignore -q CLAUDE.local.md`, else add `CLAUDE.local.md` to `.git/info/exclude`, never to `.gitignore`), or the `CLAUDE.md` of a parent folder that is in no repository; hooks in `.claude/settings.local.json`;
- **you, in every project**: `~/.claude/CLAUDE.md`, `~/.claude/` (skills, agents; hooks in `~/.claude/settings.json`).

Keep rules short, concrete and next to the related ones; to remove a rule, delete or reword it. A "keep" changes nothing. A hook must work: run its script once on a sample input. Never commit, and never change what the user did not validate. Then record the files changed:

```bash
lr retro applied <id> <proposal> --root <dir> --file <path> [--file <path>…]
```

## 10. Finish

Run `lr retro finish <id> --root <dir>` and show the user what it printed: **the list of files changed**, and the subjects to watch. Tell them the next retro will start from this one: it will check, with numbers, whether these changes reduced the feedback, and ask how they felt about them. Local Review reminds them when it is due (VS Code's status bar, and you at the start of a session).
