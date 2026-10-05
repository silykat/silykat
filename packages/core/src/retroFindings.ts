import { COLUMNS, PROPOSAL_KINDS, TARGETS, type AuditFinding, type Column, type Evidence } from './retro';
import type { ProposalKind, SessionsOverview, Target, Verification } from './retro';
import {
  auditOf,
  checkSession,
  evidenceOf,
  idsOf,
  isRawRecord,
  overviewOf,
  sessionsOf,
  textOf,
  verifyChanges,
  type GuardContext,
  type Rejected,
} from './retroGuards';
import type { SessionEvidence } from './retroSessions';

/**
 * The analysis of a retro, one source at a time: the review threads, the agent's sessions (their
 * reports, or the agent's own summaries) and the audit of the setup are each read by their own agent,
 * which records its findings in one common format. The analysis then weighs them against each other
 * and writes the proposals: a finding is not a proposal, it is what one source shows.
 */
export type FindingSource = 'threads' | 'sessions' | 'audit';

/** The report of the audit of the setup, in the retro's folder: written by the agent's adapter. */
export const AUDIT_FILE = 'audit.md';
export const FINDING_SOURCES: readonly FindingSource[] = ['threads', 'sessions', 'audit'];

/** What one source shows, with its evidence: the material of the proposals. */
export interface Finding {
  /** `T1`, `S1`, `A1`… by source, in the order given. */
  id: string;
  source: FindingSource;
  subject: string;
  /** The one cause in the setup it points at. */
  cause: string;
  /** What it suggests: a column, a kind of change, the file, the existing rule, the change. */
  column: Column | null;
  kind: ProposalKind | null;
  file: string;
  rule: string;
  change: string;
  target: Target | null;
  /** Threads that show where a change belongs (a team convention, a personal habit…). */
  targetEvidence: string[];
  evidence: Evidence[];
  sessions: SessionEvidence[];
  audit: AuditFinding | null;
  confidence: number;
  /** What else the source says about it: how strong, how often, what it is not. */
  note: string;
}

/** The findings of one source, as recorded. */
export interface SourceFindings {
  source: FindingSource;
  findings: Finding[];
  /** Threads only: the check of the changes adopted at the last retro. */
  verifications?: Verification[];
  /** Sessions only: what recurs across them. */
  overview?: SessionsOverview;
}

export interface FindingsResult extends SourceFindings {
  rejected: Rejected[];
  notes: string[];
}

const PREFIX: Record<FindingSource, string> = { threads: 'T', sessions: 'S', audit: 'A' };

/**
 * The findings of a source, checked by program like the proposals: one cause each, a confidence, and
 * evidence from its own source: threads of the period (with an excerpt), sessions the retro reads
 * (words copied from their summary or report, moments their report cites), or a finding of the audit.
 * A single thread or session is enough here: the analysis decides what deserves a proposal. The
 * threads also check the changes adopted at the last retro (`verify`), and the sessions say what
 * recurs across them (`overview`).
 */
export function checkFindings(input: unknown, source: FindingSource, ctx: GuardContext): FindingsResult {
  const result: FindingsResult = { source, findings: [], rejected: [], notes: [] };
  if (!isRawRecord(input) || !Array.isArray(input.findings)) {
    result.rejected.push({ index: 0, subject: '', reasons: ['expected a JSON object with a "findings" array'] });
    return result;
  }
  input.findings.forEach((raw, i) => {
    const index = i + 1;
    if (!isRawRecord(raw)) {
      result.rejected.push({ index, subject: '', reasons: ['not an object'] });
      return;
    }
    const subject = textOf(raw.subject);
    const reasons: string[] = [];
    if (!subject) reasons.push('"subject" is missing');
    const cause = textOf(raw.cause) || (idsOf(raw.causes).length === 1 ? idsOf(raw.causes)[0]! : '');
    if (!cause)
      reasons.push(
        idsOf(raw.causes).length > 1
          ? 'one cause per finding: split it into one finding per cause'
          : '"cause" is missing: the one cause in the setup it points at',
      );
    const confidence = typeof raw.confidence === 'number' ? raw.confidence : NaN;
    if (!(confidence >= 0 && confidence <= 1)) reasons.push('"confidence" must be a number from 0 to 1');
    const column = (textOf(raw.column)
      .toLowerCase()
      .replace(/^to\s+/, '') || null) as Column | null;
    if (column !== null && !COLUMNS.includes(column)) reasons.push(`"column" must be one of ${COLUMNS.join(', ')}`);
    const kind = (textOf(raw.kind) || null) as ProposalKind | null;
    if (kind !== null && !PROPOSAL_KINDS.includes(kind))
      reasons.push(`"kind" must be one of ${PROPOSAL_KINDS.join(', ')}`);
    const target = (textOf(raw.target) || null) as Target | null;
    if (target !== null && !TARGETS.includes(target)) reasons.push(`"target" must be one of ${TARGETS.join(', ')}`);

    // Evidence from its own source.
    const evidence: Evidence[] = [];
    const sessions: SessionEvidence[] = [];
    let audit: AuditFinding | null = null;
    if (source === 'threads') {
      for (const e of evidenceOf(raw.evidence ?? raw.threads)) {
        if (evidence.some((x) => x.thread === e.thread)) continue;
        if (ctx.threads.has(e.thread)) evidence.push(e);
        else result.notes.push(`${subject}: thread ${e.thread} is not in the period, left out`);
      }
      if (evidence.length === 0)
        reasons.push('"evidence" needs at least one thread of the period, with an excerpt: copy its id exactly');
    } else if (source === 'sessions') {
      for (const c of sessionsOf(raw.sessions)) {
        if (sessions.some((x) => x.session === c.session)) continue;
        const known = ctx.sessions?.get(c.session);
        if (known) sessions.push(checkSession(c, known, reasons));
        else result.notes.push(`${subject}: session ${c.session} is not one the retro reads, left out`);
      }
      if (sessions.length === 0)
        reasons.push('"sessions" needs at least one session the retro reads, with words copied from it');
    } else {
      audit = auditOf(raw.audit);
      if (!audit) reasons.push('"audit" needs a "location" and a "finding": where the audit saw it, and what');
    }
    if (reasons.length > 0) {
      result.rejected.push({ index, subject, reasons });
      return;
    }
    result.findings.push({
      id: `${PREFIX[source]}${result.findings.length + 1}`,
      source,
      subject,
      cause,
      column,
      kind,
      file: textOf(raw.file),
      rule: textOf(raw.rule),
      change: textOf(raw.change),
      target,
      targetEvidence: idsOf(raw.targetEvidence).filter((id) => ctx.threads.has(id)),
      evidence,
      sessions,
      audit,
      confidence,
      note: textOf(raw.note),
    });
  });
  if (source === 'threads') {
    const verifications = verifyChanges(input.verify, ctx, result);
    if (verifications.length) result.verifications = verifications;
  }
  if (source === 'sessions') {
    const overview = overviewOf(input.overview, ctx, result);
    if (overview) result.overview = overview;
  }
  return result;
}

/** The common format of the findings, as each source's agent is given it. */
export function findingsFormat(source: FindingSource): string[] {
  const evidence =
    source === 'threads'
      ? '"evidence": [{ "thread": "t_…", "excerpt": "a short quote of the thread" }]'
      : source === 'sessions'
        ? '"sessions": [{ "session": "<id>", "excerpt": "words copied exactly from its report or summary", "moments": ["<uuid its report cites>"] }]'
        : '"audit": { "location": "CLAUDE.md:2-3", "finding": "what the audit says is wrong there" }';
  return [
    '## Your answer: findings, in the common format',
    '',
    'Write a JSON file (the path is given below) with what this source shows, then record it with the command given below. A finding is not a proposal: the analysis weighs the findings of every source against each other, then decides what becomes a proposal. Give each finding even when it rests on a single thread or session: say how strong it is in "confidence" and "note".',
    '',
    '```json',
    '{',
    '  "findings": [',
    '    {',
    '      "subject": "a few words",',
    '      "cause": "the ONE cause in the setup it points at (a rule missing, a rule ignored, a skill that misleads…)",',
    `      ${evidence},`,
    '      "column": "keep | remove | improve (what you would suggest)",',
    '      "kind": "rule | hook | skill | command | agent | doc | setting | other",',
    '      "file": "the file of the existing rule, or where a change would go",',
    '      "rule": "the existing text concerned, word for word, if any",',
    '      "change": "the change you would suggest, if any",',
    '      "target": "project-shared | project-personal | user (only when the source tells it)",',
    ...(source === 'threads' ? ['      "targetEvidence": ["the threads that tell where it belongs"],'] : []),
    '      "confidence": 0.8,',
    '      "note": "how strong it is, how often it came back, what it is not"',
    '    }',
    '  ]' +
      (source === 'threads'
        ? ',\n  "verify": [{ "change": "<ref>", "threads": ["t_…"], "note": "what you saw" }]'
        : source === 'sessions'
          ? ',\n  "overview": { "summary": "2 or 3 sentences", "items": [{ "kind": "pattern | friction | ritual", "title": "…", "description": "…", "sessions": ["<id>"], "idea": "optional lead" }] }'
          : ''),
    '}',
    '```',
    '',
    '- One cause per finding: two causes are two findings.',
    '- Copy ids, excerpts and moments exactly: they are checked by program.',
    ...(source === 'threads'
      ? ['- "verify": one item per change adopted at the last retro, when the input lists some (else leave it out).']
      : []),
    ...(source === 'sessions'
      ? ['- "overview": what recurs across the sessions (8 items at most), for the user to find leads of their own.']
      : []),
    '- Write in the language of the user (the threads and their prompts), with its accents.',
  ];
}
