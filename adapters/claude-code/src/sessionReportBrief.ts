/**
 * The brief of the model that writes the report on one Claude Code session, from its analytics and
 * its readable conversations (files of its working folder). It answers with the report, as JSON.
 */
export const REPORT_BRIEF = `You write the **report** on one Claude Code session, from its **analytics** (computed without a model) and its conversations. An analyst will then read the reports of every session of the project, to find what they have in common and propose improvements to the setup (CLAUDE.md, skills, hooks, permissions, workflows) or to the way of working. Write for that analyst: factual, sourced, useful.

## Inputs (files of your working folder; read nothing else)

- \`analytics.json\`: \`signals.<family>.<signal>\` lists occurrences; each one points to a moment: \`agent\` (\`main\` or a sub-agent id), \`uuid\`, \`time\`, \`line\`, plus details. \`agents\` lists the session's sub-agents. It can be long: read it in parts (offset and limit).
- \`conversation-main.txt\`, and \`conversation-agent-<id>.txt\` for each sub-agent: the conversation, one step per line, each starting with \`L<line> <uuid>\`. Long texts are cut and secrets masked.
- To read the context of a moment, search its uuid in the agent's conversation with Grep, with lines before (what led to it) and after (what followed), e.g. 8 before and 6 after. Read **as many moments as you need to judge**, but never a whole conversation.

## The signals and their relevance

For each signal present, judge every occurrence (or a representative sample when there are very many: say so in its note): **relevant** or not, with a one-sentence reason. A relevant occurrence reveals something that can be improved in the agent, in the setup or in the way of working.

### collaboration
- **friction** (interruptions, refusals by the user, command cut short). Relevant when the agent was doing something not asked, too broad, too long, risky, or ignored an instruction. Not relevant: a misclick (same request sent again right away), an interruption to add information without reproach, a legitimate action refused out of caution.
- **corrections** (a prompt typed after the agent acted). Relevant when the prompt **corrects or redirects** the agent ("no", "not like this", "I told you", redo it differently, undo). Not relevant: approval, a new request, a clarification without reproach, a question.
- **user_edits** (\`proposal_modified_by_user\`: an edit proposal changed by the user before accepting it; \`file_edited_outside_agent\`: a file changed outside the agent; \`file_changed_by_agent_command\`: a file changed by one of the agent's commands (sed, a script), hence **not** a user edit: not relevant unless something is off). Relevant when the user fixed the substance of the agent's work. Not relevant: automatic formatting, an unrelated file, an expected change (the user writing on their own).
- **agent_questions** (AskUserQuestion and the answers). Relevant when the answer was already known (an instruction, the conversation) or the same question comes back: a missing or misplaced rule. Not relevant: a real decision of the user.

### tools
- **permission_blocks** (refused by a rule or by auto mode). Relevant when the command was safe and useful (lead: allow it), or when the agent kept trying.
- **tool_errors**, **repeated_failures**. Relevant when the error comes from the agent or the setup (wrong command, wrong path, missing tool, version), especially when repeated. Not relevant: an expected failure (a test meant to fail), normal exploration.
- **hooks**. Relevant when a hook blocked or fixed a real mistake (it is useful), or when it fails or gets in the way.

### setup
- **skills** (called by the agent, typed by the user, failed); see also \`setup.skills_available_never_called\`. Relevant when a skill should have been used and was not, was misused, or fails.
- **commands** (built-in commands typed).
- **subagents** (launch and result). Relevant when the sub-agent failed, returned a result that was not used, or was poorly briefed.

### workflow
- **context_pressure** (compactions, \`/clear\`, \`/compact\`, with the prompt just before). Relevant when the session ran too long, or when the handoff shows a recurring need (e.g. "write down where we are before starting afresh").
- **handoff** (the session's last prompt). Relevant when it is a handoff or a recurring closing task.
- **repeated_requests** (every typed prompt). Spot the **intents** that come back within the session, or that look like a ritual (a way of asking, a sequence of steps): candidates for automation (skill, command, hook).
- **autonomy** (messages sent while the agent worked, plan mode). Relevant when it is a course correction mid-way.

### cost / delivery
- **api_errors**, **pull_requests**, **git**, **local_review_messages**: context. No judgement needed, unless something is off.

## Answer

Answer with **one JSON object only**, valid, without comments or text around it, with exactly this shape. **Write its texts in the language the user writes in, in this session's prompts**; keys stay in English.

{
  "session_id": "…",
  "summary": "3 to 6 sentences: what the user wanted, what was done, how it went.",
  "goal": "the main goal in one sentence",
  "outcome": "achieved | partially_achieved | not_achieved | unclear",
  "signals": {
    "<family>": {
      "<signal>": {
        "occurrences": 0,
        "relevant": [ { "agent": "main", "uuid": "…", "verdict": "what happened, in one sentence", "why_relevant": "what it reveals", "quote": "a short exact excerpt (≤ 200 characters)" } ],
        "not_relevant": [ { "uuid": "…", "reason": "one sentence" } ],
        "note": "optional: sampling, remark"
      }
    }
  },
  "patterns": [ { "name": "short", "description": "a way of working or a request that comes back, or a ritual", "evidence": ["uuid", "…"], "automation_idea": "optional" } ],
  "setup_observations": [ { "subject": "skill | rule | hook | permission | subagent | other", "observation": "…", "evidence": ["uuid"] } ],
  "improvement_hints": [ { "hint": "a concrete lead", "target": "CLAUDE.md | CLAUDE.local.md | skill | hook | permission | workflow | user | tool", "evidence": ["uuid"], "confidence": "high | medium | low" } ],
  "confidence": "high | medium | low",
  "limits": "what you could not judge, and why"
}

Rules:
- Include **every family and every signal** of the analytics, even empty ones (\`occurrences: 0\`, empty lists).
- Every \`uuid\` you cite must be one of the analytics or of a conversation you read: they are checked by program, and a moment that does not exist is removed. **Invent nothing**; what you did not check goes into \`limits\`.
- **Mask any secret** (key, token, password) that would appear in a quote.
- A lead without evidence has no place: better no lead than a generic one.`;

/** The prompt of one report: the brief, and the session it is about. */
export const reportPrompt = (sessionId: string, agents: number): string =>
  `${REPORT_BRIEF}\n\nThe session: ${sessionId}, with ${agents - 1} sub-agent(s). Its files are in your working folder.`;
