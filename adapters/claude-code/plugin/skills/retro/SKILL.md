---
name: retro
description: Run a retro with the user on their work with you since the last retro (the review threads they left in Local Review in VS Code, your sessions with them, an audit of your setup: the sources they choose), to improve your setup together (CLAUDE.md, CLAUDE.local.md, skills, hooks…). Use when the user asks for a retro, a retrospective, or to improve your setup from their feedback.
allowed-tools: Bash(lr:*), Bash(lr-retro:*)
---

# Run a retro of your work with the user

Like a sprint retro, but between the user and you: look back at a period of work, find what in your setup caused the feedback, and decide **together** what to keep, remove or improve. A retro reads up to three **sources**, as the user chooses: their **reviews** (the review threads they left in VS Code), your **sessions** with them, and an **audit of your setup**. It needs at least one. It is a discussion, not a report: nothing changes without the user's say-so, and what they validate, **you** apply.

The heavy work is done by sub-agents with a fresh context (classification, one reading per source, the analysis that weighs them, then applying each validated change in the background); you only see their proposals, so that your context stays free for the discussion. `lr retro` (on your PATH) keeps the retro's journal and checks the proposals by program.

**The project** is the folder this session was started in (your primary working directory), even if you moved since. Pass it as `--root <dir>` to every `lr retro` and `lr-retro` command below. Ask the user questions with the AskUserQuestion tool, the recommended option first, labelled "(Recommended)". Talk in the user's language.

## 1. Where things stand

Run `lr retro scope --root <dir>`. It prints the proposed period (since the last retro), the comment stores found, the threads, the size, an estimate of the time, the **sources** with their settings, the periods to choose from, the last retro and the user's retro preferences.

If it lists an **unfinished retro**, ask whether to continue it (run `lr retro show <id> --root <dir>` and resume at the step where it stopped) or to start a new one.

Run `lr-retro sessions --root <dir>` too: it says, for the same periods, your Claude Code sessions and how the retro reads them (the setting `retro-sessions`): a **report** on each one, written at the start of the retro (it gives the reports to write), or what Claude Code's **`/insights`** knows of them (cheaper). Never both. A period without threads or sessions is not a dead end: the user may leave a source out, and the audit needs no data (step 4 sorts it out).

## 2. Feedback on the last retro (only when there is one)

Before anything else, show in two or three lines what was decided last time (the "Last retro" section). Whether those changes helped is **measured**, not asked: never ask the user how they felt about them. Then ask one AskUserQuestion: "Do you want to change anything in the retro itself (what it looks at, its level of detail, subjects to ignore…)?" — "No, keep it as it is" / "Yes" (then ask what, in their words).

Save each wish as a short instruction, one per preference, with one plain command (no heredoc, nothing chained: those need the user's approval):

```bash
lr retro prefs add --root <dir> --body "Show at most 5 proposals, the most important first."
```

Remove the ones they no longer want with `lr retro prefs remove <id> --root <dir>`. **Apply the preferences from now on**, in this retro too.

When `lr retro scope` says that this retro **will check the changes adopted** last time, tell the user in one sentence: the analysis will measure whether the feedback on their subject went down, and you will show it with its numbers.

## 3. The period: first validation

`lr retro scope` and `lr-retro sessions` (step 1) list the same **periods to choose from**, at every retro: since the last retro (or, for a first retro, the last 7 days), the last 30 days and the whole history, the proposed one first. For each, `lr retro scope` gives its threads and size (and says when it **reads again threads of the last retro**), and `lr-retro sessions` its Claude Code sessions and, when the retro reads them through reports, the **reports** to write (a separate Claude Code with Opus reads each session, at the start of the retro), those already written (kept from an earlier retro), and the estimated time and cost of the new ones.

Announce, in a few lines: the project, the comment stores found, and the sources a retro can read, each by its own sub-agent: the review threads, your sessions (as `lr retro scope` says: a report on each one, or what `/insights` knows of them; the setting `retro-sessions` of `lr config`, or VS Code's "Retro Sessions", chooses) and the audit of your setup. When `lr retro scope` says the **history is not kept** on this machine, say so: the threads the user deleted are erased, so the retro does not see them.

Then ask **one AskUserQuestion**: "Which period should the retro cover?", with **one option per period listed** (the proposed one first, "(Recommended)") and a last option "Cancel". Each option's description gives **its own numbers**, from both commands: threads, sessions, and, when the retro reads them through reports, the reports to write with their estimated time and cost (an equivalent at the API list price: on a subscription, tokens counted against the usage limits, not a bill), reports already written, and "reads again the threads of the last retro" when it does. Never write a vague number ("and more sessions"): every option has its figures. The period comes first: what each source has to read depends on it. When the user types another date instead, run `lr retro scope --root <dir> --since <date>` and `lr-retro sessions --root <dir> --since <date>`, give its numbers the same way, and ask to confirm: "This period" / "Cancel". Then go on with the sources (step 4).

## 4. The sources: second validation

The three sources, with their numbers **for the period chosen**:

- **Reviews**: the threads of the period (`lr retro scope`); they have data when there is at least one thread;
- **Sessions**: your sessions of the period (`lr-retro sessions`), with, when the retro reads them through reports, the reports to write, their time and cost; they have data when there is at least one session;
- **Audit of the setup**: a command run on your setup, which needs no data; it takes about 8 minutes (`lr retro scope` gives the estimate).

**1. The project's settings, only when it has none.** Only when `lr retro scope` says that **this project has no retro settings yet** (not because it is the project's first retro: its settings may be saved already, and `lr retro scope` then says to follow them), ask first how it wants each source, in **one AskUserQuestion with three questions**, one per source ("In the retros of this project, read your reviews?", then the sessions, then the audit), each with the options "Always (yes)", "Never (no)", "Ask at each retro (ask)", the recommendation first: "Always" for the reviews and the sessions, "Ask at each retro" for the audit (it is long, and the setup changes less often than the work). Say in one sentence that these are the project's settings, kept for its next retros, and that they can change them later with `lr config set retro-source-<source> <yes|no|ask> --project`, or for every project in VS Code's "Retro Sources" settings. Save them in one command:

```bash
lr retro sources --root <dir> --set reviews=<yes|no|ask> --set sessions=<yes|no|ask> --set audit=<yes|no|ask>
```

It prints the settings in force. Otherwise, the settings are those `lr retro scope` printed (the project's, else the machine's).

**2. What each setting gives**, for the period chosen:

- `yes`: included, without a question. A review or session source **without data** in the period is left out, without a question ("no thread in this period");
- `no`: left out, without a question;
- `ask`: the reviews and the sessions are asked about **only when they have data** in the period (without data: left out, without a question); the audit is **always** asked about.

Ask the sources in `ask` in **one AskUserQuestion**, one question per source ("Include your reviews in this retro?", "Include your sessions?", "Include the audit of your setup?"), each with the options "Include (Recommended)" and "Leave out". The description of "Include" gives **the numbers of the source** for the period: the threads; the sessions, the reports to write, their time and cost (or "read by /insights, about a minute"), the reports already written; the audit's duration.

**3. The recap, then GO.** Write a short recap of what will run, in a visible message: for each source, **included or left out, and why** (the setting, the user's answer, or no data in the period: "Reviews: none in this period"), with its numbers; then **the estimated time** of the whole: the included sources are read at the same time (the classification of the threads, the reports on the sessions, the audit), so count the longest of them, then the analysis (the times of `lr retro scope` and `lr-retro sessions`). Then ask one AskUserQuestion: "Start the retro (Recommended)" / "Leave out a source" / "Cancel". "Leave out a source": ask which (one question, the included sources as options), then write the recap again and ask again.

**No source left** (all left out, or nothing to read and no audit): say in one sentence that there is nothing to look back at, and stop. No retro is started.

## 5. Start

```bash
lr retro start --root <dir> [--since <date> | --all] --sources <the sources included, e.g. reviews,sessions,audit>
```

with the option of the period chosen (as listed: none for "since the last retro", `--since 30d`, `--all`…), and the sources of the recap. Only those are read: the steps below skip the others.

It prints the retro id (`rt_…`). If the user said something about the last retro's changes anyway, record it in a sentence: `lr retro feedback <id> --root <dir> --body "<their words>"`.

## 6. The audit, the sessions and the classification

Run only what the sources included need: the audit and the usage of the tools for **the audit**, the reports or `/insights` for **the sessions**, the classification for **the reviews**. (`lr-retro` and `lr` skip or refuse a step on a source the retro does not read.)

First, when the retro includes the audit, start **the audit of your setup** in the background: run `lr-retro audit <id> --root <dir>` with the Bash tool's `run_in_background` option. It runs `/doctor prompt-audit` in a separate Claude Code, read-only, which looks for stale, contradictory or duplicated rules in the CLAUDE.md files, skills, agents and commands. It takes several minutes: it runs while the rest goes on. Say so in one sentence.

When the retro includes the sessions, start **the reading of your sessions** in the background too, the way `lr retro scope` said (never both):

- **reports**: run `lr-retro reports <id> --root <dir>` with `run_in_background`. It writes a report on each of your sessions of the project and of the period (a separate Claude Code with Opus each, several at once, read-only, on the session's records with secrets masked), and reuses those already written. Tell the user in one sentence that it runs, and how long it should take (the estimate of step 3);
- **insights**: run `lr-retro insights <id> --root <dir>` with `run_in_background`. It runs Claude Code's `/insights` in a separate Claude Code (about a minute), then keeps what it knows of the sessions **of this project and of this period** only (this session left out). Its report, which covers every project of the machine, is never read. Nothing to say about it to the user.

With the audit, run `lr-retro usage <id> --root <dir>` too (a few seconds): it counts how many times each skill, command and sub-agent of the setup was used in your sessions, without a model, for the reading of the audit.

Then, when the retro includes the reviews, the classification (a sub-agent). Run `lr retro key`. It tells whether a key of **Jev** is set up (a classification service: faster and cheaper than a model of the user's subscription; without it, Haiku does the job).

- **Ready**: the classifier is `jev`.
- **No key**: in two sentences, say what Jev brings and that Haiku works without it, then ask: "Continue with Haiku (Recommended)" / "Set up a Jev key first". To set one up:
  - propose the place `lr retro key` printed (`~/.config/local-review/jev-key`), and give the command it printed, to run **in their own terminal**, not here and not with `!`: it asks for the key without showing it and saves it in a file only they can read;
  - **the key must never go through this conversation**: never ask for it, never read, print or open the key file. If the user pastes a key here anyway, tell them it is now in the conversation's transcript and that they should create a new one;
  - when they say it is done, run `lr retro key` again; if it says the file is not safe, give them the fix it prints.
- **Not safe** (readable by others, or inside a repository): give the fix `lr retro key` prints; use Haiku until it is fixed.

Then launch the sub-agent **`local-review:retro-classifier`** (Agent tool), with this prompt: `Retro <id>, project <dir>, classifier: jev` (or `haiku`). Wait for its one-line summary before going on. If Jev failed for every thread, launch it again with `classifier: haiku`.

## 7. Analysis: one sub-agent per source, then one that weighs them

Wait for **the audit** and **the reading of the sessions** to end, when the retro includes them (you are told when each background command finishes). The audit prints the path of its report (`Written: …/audit.md`), or says it was skipped or failed: then go on without it, and tell the user why in one sentence. The reading of the sessions needs nothing more when it succeeds. If `/insights` failed, go on without the sessions and say so in one sentence; if it says the format of `/insights` could not be read, ask the user to report it as a bug of Local Review. When some reports could not be written, it lists them: say how many in one sentence, and go on with the others.

Then launch, **in one message, so that they run at the same time**, one sub-agent per source included (Agent tool, prompt: `Retro <id>, project <dir>.`):

- **`local-review:retro-threads-analyst`**: the review threads, when the retro includes the reviews;
- **`local-review:retro-sessions-analyst`**: your sessions, when the retro reads some (reports written or kept, or sessions found by `/insights`);
- **`local-review:retro-audit-analyst`**: the audit, when it wrote its report.

Each reads its source whole and alone, and records its findings in a common format with `lr retro findings` (checked by program). Wait for all of them; each answers in one line. Then launch **`local-review:retro-analyst`** with the prompt `Retro <id>, project <dir>.`: it weighs the findings of every source against each other, goes back to a source to settle a doubt, and records the proposals with `lr retro propose`, which applies the guard rails by program.

**Never do the analysis yourself**, and never read the threads, the inputs, the findings or the audit: your context is for the discussion. If a sub-agent was blocked (a command refused), tell the user which command it needs (they can allow `lr` and `lr-retro` commands, and the writing of the retro's files in `.local-review/retros/`), then launch it again. If the reading of the sessions or of the audit failed, go on without it and say so in one sentence; if the reading of the threads failed, launch it again. If no source could be read at all, tell the user and stop (`lr retro finish`).

## 8. The proposals

Run `lr retro show <id> --root <dir>`.

**First, the check of the last retro's changes** (section "The last retro's changes: did they help?", when there is one): for each change adopted last time, give its numbers, source by source (the threads on its subject out of all the threads, and the sessions that show it out of all the sessions, before and since) and the verdict: the feedback **stopped** or **decreased** (the change is kept), **did not decrease** (the retro proposes to revise it: the proposal marked "Revises"), or **not measured** (none of the sources it rested on has data in this period, or it came from the audit alone: say so, no verdict).

Say in a few words which sources this retro read (the line "Sources" of `lr retro show`). Then give an overview of the proposals: how many proposals in **To keep**, **To remove** and **To improve** (and how many come from the audit of the setup, how many ask whether to keep a tool you never used, and how many rest on your sessions: the line "The agent's sessions" of `lr retro show`), and the subjects **to watch** (leads seen in a single thread or session: not proposed, kept for the next retros).

When `lr retro show` has the section **"Your sessions with the agent: what recurs"** (patterns, frictions and rituals seen across your sessions, for the user to find leads of their own, such as tasks to automate), write it **word for word** in your message, before the proposals: it is not a proposal, nothing is decided on it. When it lists **the agent's conversations read back**, say in one sentence which ambiguous threads the analysis explained from your conversation where you replied, and which conversations were no longer available (it did without them).

## 9. The discussion: third validation, one proposal at a time

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

   **A tool never used** (the proposal has a "Never used" part: the audit flagged a skill, command or sub-agent nobody used): the question is whether to keep it, not how to fix it. Ask instead: "Remove it" (preview: the path removed) / "Keep it and fix it" (preview: the `diff` of the fix, "The fix, if you keep it"; leave this option out when there is no fix) / "Keep it as is" (preview: "No change.") / "Discuss". Its description repeats in a few words what the "Never used" part says the count rests on, and its limits (this machine only, sessions kept 30 days by default). Record "Remove it" as `accepted`, "Keep it and fix it" as `modified` with the note "kept and fixed", "Keep it as is" as `excluded` with the note "kept" and the user's reason.

4. **A modified change, or another target, is shown again**: the whole new `diff` in the message and in the preview of "Apply this version", then ask again: "Apply this version" / "Change it again" / "Exclude". Never apply a version the user has not read.
5. **Record the decision** at once (step 10), then **hand the change to a sub-agent in the background** (step 10) and go straight on with the next proposal, in a new message: the user never waits for a change to be written.

An excluded subject is never proposed again, unless new feedback raises it. Record it with the user's reason when they give one.

## 10. Apply what was validated, in the background

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

or, for a new file, `New file: <absolute path>` followed by its whole content; for a tool the user chose to remove, `Remove: <absolute path>` (the path the proposal names: the file, or the skill's folder). Several files: one block per file.

- **One file at a time**: before you show the diff of a proposal whose file a sub-agent is still changing, wait for that sub-agent to finish, so that the diff is computed on the file as it now is.
- When a sub-agent finishes, tell the user in **one line**, between two proposals (e.g. "p3 applied to `src/CLAUDE.md`."). If it could not apply the change (the file changed meanwhile), tell the user, show the diff again on the file as it is, and ask again.
- The sub-agent records the files changed itself (`lr retro applied`).

Never commit, and never change what the user did not validate.

`<proposal>` is the proposal's **id**, in parentheses in its heading (`Proposal 4/6 (p5)` is `p5`), never its position. A decision recorded on the wrong proposal is undone with `lr retro undo <id> <proposal> --root <dir>` (it forgets its files too). **Never edit the retro's files by hand**: the journal is append-only.

## 11. Finish

Wait for every `retro-applier` still running to finish. Then run `lr retro finish <id> --root <dir>` and show the user what it printed: **the list of files changed**, the subjects to watch, and what reading the sessions and writing the reports on them took (an equivalent at the API list price: on a subscription, tokens counted against the usage limits, not a bill). Tell them the next retro will start from this one, and will measure whether these changes helped from the feedback that follows. Local Review reminds them when it is due (VS Code's status bar, and you at the start of a session).
