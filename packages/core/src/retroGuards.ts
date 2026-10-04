import type { ThreadHistory } from './history';
import {
  COLUMNS,
  DECISIONS,
  PROPOSAL_KINDS,
  RULE_NOT_FOLLOWED,
  TARGETS,
  type AuditFinding,
  type Column,
  type Decision,
  type Dropped,
  type Evidence,
  type Figures,
  type Proposal,
  type ProposalKind,
  type RetroState,
  type AdoptedChange,
  type Target,
  type ThreadLabel,
  type Verdict,
  type Verification,
  type WatchItem,
  OVERVIEW_KINDS,
  type OverviewItem,
  type OverviewKind,
  type SessionsOverview,
} from './retro';
import { defaultExcerpt, excerptOf, summaryText, type SessionEvidence } from './retroSessions';

/** Statistics of a period, computed without a model. */
export interface RetroStats {
  threads: number;
  reopened: number;
  questions: number;
  /** Threads where the user replied again after the agent's reply. */
  backAndForth: number;
  deleted: number;
  /** Deleted threads by reason: removed by the user (what they asked no longer mattered), or with their branch (work done). */
  deletedByUser: number;
  deletedWithBranch: number;
  /** Per category of the classification, when there is one. */
  categories: Record<number, number>;
  /** Threads flagged by the classification (score of 0.5 or more). */
  missingRule: number;
  ignoredRule: number;
}

/** How a thread went: reopened, questions from the agent, rounds of back-and-forth. */
export function threadSignals(t: ThreadHistory): { reopened: boolean; question: boolean; rounds: number } {
  let reopened = false;
  let question = false;
  let rounds = 0;
  let last: string | null = null;
  let agentSpoke = false;
  for (const e of t.conversation) {
    if (e.kind === 'status') {
      if (e.status === 'needs-info' && e.by === 'agent') question = true;
      if (e.status === 'open' && e.by === 'user' && (last === 'addressed' || last === 'resolved')) reopened = true;
      last = e.status;
    } else if (e.kind === 'comment') {
      if (e.author === 'agent') agentSpoke = true;
      else if (agentSpoke) rounds++;
    }
  }
  return { reopened, question, rounds };
}

export function retroStats(threads: readonly ThreadHistory[], labels: Record<string, ThreadLabel> = {}): RetroStats {
  const s: RetroStats = {
    threads: threads.length,
    reopened: 0,
    questions: 0,
    backAndForth: 0,
    deleted: 0,
    deletedByUser: 0,
    deletedWithBranch: 0,
    categories: {},
    missingRule: 0,
    ignoredRule: 0,
  };
  for (const t of threads) {
    const sig = threadSignals(t);
    if (sig.reopened) s.reopened++;
    if (sig.question) s.questions++;
    if (sig.rounds > 0) s.backAndForth++;
    if (t.state === 'deleted') s.deleted++;
    if (t.deletedReason === 'user') s.deletedByUser++;
    if (t.deletedReason === 'branch-gone') s.deletedWithBranch++;
    const l = labels[t.id];
    if (!l) continue;
    s.categories[l.category] = (s.categories[l.category] ?? 0) + 1;
    if ((l.missingRule ?? 0) >= 0.5) s.missingRule++;
    if ((l.ignoredRule ?? 0) >= 0.5) s.ignoredRule++;
  }
  return s;
}

/** The numbers of a group of threads. */
export function figuresOf(threads: readonly ThreadHistory[]): Figures {
  let reopened = 0;
  let questions = 0;
  let rounds = 0;
  for (const t of threads) {
    const sig = threadSignals(t);
    if (sig.reopened) reopened++;
    if (sig.question) questions++;
    rounds += sig.rounds;
  }
  const first = threads.map((t) => t.createdAt).sort()[0] ?? '';
  const last =
    threads
      .map((t) => t.lastActivityAt)
      .sort()
      .at(-1) ?? '';
  return { threads: threads.length, reopened, questions, rounds, first, last };
}

/** A subject the user excluded in an earlier retro. */
export interface Exclusion {
  retro: string;
  proposal: string;
  subject: string;
  at: string;
  threads: string[];
}

/** Every subject excluded in these retros (the last decision on a proposal counts). */
export function exclusionsOf(retros: readonly RetroState[]): Exclusion[] {
  const out: Exclusion[] = [];
  for (const r of retros)
    for (const p of r.proposals) {
      const d = r.decisions[p.id];
      if (d?.decision === 'excluded')
        out.push({
          retro: r.id,
          proposal: p.id,
          subject: p.subject,
          at: d.at,
          threads: p.evidence.map((e) => e.thread),
        });
    }
  return out;
}

/** The decisions that adopt a proposal. */
const ADOPTED: readonly Decision[] = ['accepted', 'modified', 'retargeted'];

/**
 * The changes adopted at a retro, to check at the next one: proposals to improve or remove that the
 * user accepted, modified or retargeted ("keep" changes nothing).
 */
export function adoptedChanges(r: RetroState): AdoptedChange[] {
  return r.proposals.flatMap((p): AdoptedChange[] => {
    const d = r.decisions[p.id];
    if (p.column === 'keep' || !d || !ADOPTED.includes(d.decision)) return [];
    return [
      {
        retro: r.id,
        proposal: p.id,
        column: p.column,
        subject: p.subject,
        title: p.title,
        kind: p.kind,
        change: p.change,
        decision: d.decision,
        ...(d.note ? { note: d.note } : {}),
        target: d.target ?? p.target,
        files: r.applied[p.id] ?? [],
        before: { threads: p.figures.threads, total: r.threads.length },
        evidence: p.evidence,
      },
    ];
  });
}

/**
 * The verdict on an adopted change, from the threads on its subject before (in the period of the
 * retro that adopted it) and after (in this one), each as a share of all the threads of its period:
 * the periods differ in length and in activity.
 */
export function verdictOf(
  before: { threads: number; total: number },
  after: { threads: number; total: number },
): Verdict {
  if (after.threads === 0) return 'stopped';
  const share = (x: { threads: number; total: number }) => (x.total > 0 ? x.threads / x.total : 0);
  return share(after) < share(before) ? 'decreased' : 'not-decreased';
}

/** `rt_…/p1`: how the agents name an adopted change. */
export const changeRef = (c: { retro: string; proposal: string }) => `${c.retro}/${c.proposal}`;

const STOPWORDS = new Set(
  (
    'the and for with that this from into when then than are was were has have not use uses using ' +
    'les des une pour avec dans sur par pas que qui est sont aux ses son leur'
  ).split(' '),
);

function words(text: string): Set<string> {
  return new Set(
    (
      text
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .match(/[\p{L}\p{N}]+/gu) ?? []
    ).filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

/** How alike two subjects are (shared words), from 0 to 1. */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / (x.size + y.size - common);
}

/** Two subjects at least this alike are the same subject. */
export const SAME_SUBJECT = 0.5;

/** What the guard rails need to know about the retro. */
export interface GuardContext {
  /** The threads of the period, by id. */
  threads: ReadonlyMap<string, ThreadHistory>;
  labels: Record<string, ThreadLabel>;
  exclusions: readonly Exclusion[];
  /** The changes adopted at the last retro: each must be checked against the threads of this period. */
  adopted?: readonly AdoptedChange[];
  /**
   * The agent's sessions the retro reads (by id), with their summary when there is one, and their
   * report: its text (excerpts are words of it) and the moments it knows.
   */
  sessions?: ReadonlyMap<string, GuardSession>;
}

export interface GuardSession {
  start: string;
  summary: Record<string, unknown> | null;
  report?: { text: string; moments: ReadonlySet<string>; summary: string };
}

export interface Rejected {
  /** Position in the input (1-based). */
  index: number;
  subject: string;
  reasons: string[];
}

export interface GuardResult {
  proposals: Proposal[];
  watch: WatchItem[];
  /** Left out on purpose (an excluded subject without new feedback). */
  dropped: Dropped[];
  /** The check of the changes adopted at the last retro. */
  verifications: Verification[];
  /** Must be fixed before the proposals can be recorded. */
  rejected: Rejected[];
  /** What the guard rails changed, for the record: moved to the watch list, a keep turned into improve… */
  notes: string[];
  /** What recurs across the agent's sessions, when the analysis wrote it. */
  overview: SessionsOverview | null;
}

type Raw = Record<string, unknown>;

const isRecord = (x: unknown): x is Raw => typeof x === 'object' && x !== null && !Array.isArray(x);
const text = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');

function evidenceOf(x: unknown): Evidence[] {
  if (!Array.isArray(x)) return [];
  const out: Evidence[] = [];
  for (const e of x) {
    if (typeof e === 'string') out.push({ thread: e.trim(), excerpt: '' });
    else if (isRecord(e) && text(e.thread)) out.push({ thread: text(e.thread), excerpt: text(e.excerpt) });
  }
  return out;
}

function auditOf(x: unknown): AuditFinding | null {
  if (!isRecord(x)) return null;
  const location = text(x.location);
  const finding = text(x.finding);
  return location && finding ? { location, finding } : null;
}

/** The sessions a proposal cites: `[{session, excerpt, moments}]`, or ids alone. */
function sessionsOf(x: unknown): { session: string; excerpt: string; moments: string[] }[] {
  if (!Array.isArray(x)) return [];
  const out: { session: string; excerpt: string; moments: string[] }[] = [];
  for (const e of x) {
    if (typeof e === 'string' && e.trim()) out.push({ session: e.trim(), excerpt: '', moments: [] });
    else if (isRecord(e) && text(e.session))
      out.push({ session: text(e.session), excerpt: text(e.excerpt), moments: [...new Set(ids(e.moments))] });
  }
  return out;
}

const ids = (x: unknown): string[] => (Array.isArray(x) ? x.map(text).filter((s) => s !== '') : []);

/**
 * A session the retro reads, as a proposal cites it, checked: its excerpt words of its summary or of
 * its report, its moments ones its report knows.
 */
function checkSession(
  c: { session: string; excerpt: string; moments: string[] },
  known: GuardSession,
  reasons: string[],
): SessionEvidence {
  const sources = [known.summary ? summaryText(known.summary) : '', known.report?.text ?? ''].filter(Boolean);
  let excerpt = '';
  if (!c.excerpt) excerpt = (known.summary ? defaultExcerpt(known.summary) : '') || (known.report?.summary ?? '');
  else if (sources.some((t) => excerptOf(c.excerpt, t))) excerpt = c.excerpt;
  else if (sources.length > 0)
    reasons.push(
      `the excerpt of session ${c.session} is not in its summary or report: copy their words exactly ("${c.excerpt.slice(0, 60)}")`,
    );
  const unknown = c.moments.filter((m) => !known.report?.moments.has(m));
  if (unknown.length > 0)
    reasons.push(
      known.report
        ? `session ${c.session}: moment(s) ${unknown.join(', ')} not in its report: copy the "uuid" of a moment its report cites`
        : `session ${c.session} has no report: it cannot cite moments`,
    );
  return { session: c.session, start: known.start, excerpt, ...(c.moments.length ? { moments: c.moments } : {}) };
}

/** What recurs across the sessions, as the analysis wrote it: items on sessions the retro reads only. */
function overviewOf(x: unknown, ctx: GuardContext, result: GuardResult): SessionsOverview | null {
  if (!isRecord(x)) return null;
  const items: OverviewItem[] = [];
  for (const raw of Array.isArray(x.items) ? x.items.filter(isRecord) : []) {
    const title = text(raw.title);
    const kind = text(raw.kind).toLowerCase() as OverviewKind;
    const all = [...new Set(ids(raw.sessions))];
    const sessions = all.filter((id) => ctx.sessions?.has(id));
    for (const id of all.filter((id) => !ctx.sessions?.has(id)))
      result.notes.push(`overview "${title}": session ${id} is not one the retro reads, left out`);
    if (!title || sessions.length === 0) continue;
    items.push({
      kind: OVERVIEW_KINDS.includes(kind) ? kind : 'pattern',
      title,
      description: text(raw.description),
      sessions,
      ...(text(raw.idea) ? { idea: text(raw.idea) } : {}),
    });
  }
  const summary = text(x.summary);
  return summary || items.length ? { summary, items } : null;
}

/**
 * The guard rails of the proposals of a retro, applied by program whatever the agent that wrote them:
 * - at least 2 threads of the period per proposal; a preference seen once goes to the watch list;
 * - no "keep" for a rule the user had to enforce in the period: it becomes "improve";
 * - one subject (one cause) per proposal;
 * - the target is asked when nothing in the threads tells it;
 * - a subject excluded in an earlier retro comes back only with at least 2 new threads.
 *
 * A proposal may rest on the agent's sessions of the period too (`sessions`): each must be one the
 * retro reads, its excerpt words of the session's summary or report, as written there, and its
 * moments ones its report cites. They count as evidence like threads; a proposal on sessions only
 * says so (`sessionsOnly`). What recurs across the sessions (`overview`) cites sessions the retro
 * reads only.
 *
 * A proposal that comes from an audit of the setup (`audit`: a stale or contradictory rule…) rests on
 * that finding: it needs no thread, and only removes or rewrites what exists ("remove" or "improve").
 *
 * `input` is the agent's output: `{ proposals: [...], watch: [...] }`.
 */
export function checkProposals(input: unknown, ctx: GuardContext): GuardResult {
  const result: GuardResult = {
    proposals: [],
    watch: [],
    dropped: [],
    verifications: [],
    rejected: [],
    notes: [],
    overview: null,
  };
  if (!isRecord(input) || !Array.isArray(input.proposals)) {
    result.rejected.push({ index: 0, subject: '', reasons: ['expected a JSON object with a "proposals" array'] });
    return result;
  }
  const inPeriod = (id: string) => ctx.threads.has(id);
  const watchInput: Raw[] = Array.isArray(input.watch) ? input.watch.filter(isRecord) : [];

  /**
   * The excluded subject this one is, if any: said so (`reopens`), worded alike, or resting on 2 of
   * its threads; with the threads that raise it again since (new feedback).
   */
  const excludedBy = (subject: string, evidence: readonly Evidence[], reopenRef: string) => {
    const cites = new Set(evidence.map((e) => e.thread));
    const shared = (x: Exclusion) => x.threads.filter((id) => cites.has(id)).length;
    const excluded = ctx.exclusions.find(
      (x) =>
        reopenRef === `${x.retro}/${x.proposal}` || similarity(x.subject, subject) >= SAME_SUBJECT || shared(x) >= 2,
    );
    if (!excluded) return null;
    const newThreads = [...cites].filter(
      (id) => !excluded.threads.includes(id) && ctx.threads.get(id)!.lastActivityAt > excluded.at,
    );
    return { excluded, newThreads };
  };
  const droppedFor = (subject: string, x: Exclusion): Dropped => ({
    subject,
    reason: `you excluded "${x.subject}" on ${x.at.slice(0, 10)}, and fewer than 2 new threads raise it again`,
  });

  const verifications = verify(input.verify, ctx, result);
  const revisable = new Map(verifications.map((v) => [changeRef(v), v]));
  const revisionsRejected = new Set<string>();

  input.proposals.forEach((raw, i) => {
    const index = i + 1;
    if (!isRecord(raw)) {
      result.rejected.push({ index, subject: '', reasons: ['not an object'] });
      return;
    }
    const subject = text(raw.subject) || text(raw.title);
    const reasons: string[] = [];
    // "To improve", "Improve": the column's name as people write it.
    const column = text(raw.column)
      .toLowerCase()
      .replace(/^to\s+/, '') as Column;
    if (!COLUMNS.includes(column)) reasons.push(`"column" must be one of ${COLUMNS.join(', ')}`);
    const revisitRef = text(raw.revisits);
    const revisited = revisitRef ? revisable.get(revisitRef) : undefined;
    // A change that revises one adopted at the last retro stays where that one was made.
    const target = (text(raw.target) || revisited?.target || '') as Target;
    if (!TARGETS.includes(target)) reasons.push(`"target" must be one of ${TARGETS.join(', ')}`);
    const kind = (text(raw.kind) || 'rule') as ProposalKind;
    if (!PROPOSAL_KINDS.includes(kind)) reasons.push(`"kind" must be one of ${PROPOSAL_KINDS.join(', ')}`);
    if (!subject) reasons.push('"subject" is missing');
    if (!text(raw.why)) reasons.push('"why" is missing: the common cause, and what the change must avoid');
    if (!text(raw.file)) reasons.push('"file" is missing: the file of the rule, or where the change goes');
    const audit = auditOf(raw.audit);
    if (raw.audit != null && !audit) reasons.push('"audit" needs a "location" and a "finding"');
    if (audit && column === 'keep') reasons.push('an audit finding removes or rewrites a rule: "remove" or "improve"');
    // `threads` (a list of ids) is taken for `evidence`, without excerpts.
    const cited = evidenceOf(raw.evidence ?? raw.threads);
    const citedSessions = sessionsOf(raw.sessions);
    if (cited.length === 0 && citedSessions.length === 0 && !audit)
      reasons.push('"evidence" is missing: the threads that support it, with an excerpt each');
    // Sessions: ones the retro reads, quoted from their summary or report (never the analysis' own
    // words), at moments their report knows.
    const sessions: SessionEvidence[] = [];
    for (const c of citedSessions) {
      if (sessions.some((x) => x.session === c.session)) continue;
      const known = ctx.sessions?.get(c.session);
      if (!known) {
        result.notes.push(`${subject}: session ${c.session} is not one the retro reads, left out of its evidence`);
        continue;
      }
      sessions.push(checkSession(c, known, reasons));
    }
    if (column !== 'keep' && !text(raw.change)) reasons.push('"change" is missing: the exact change');
    if (column === 'keep' && !text(raw.rule)) reasons.push('a "keep" names the existing rule it keeps ("rule")');
    const causes = ids(raw.causes);
    if (causes.length === 0) reasons.push('"causes" is missing: the one cause this proposal addresses');
    if (causes.length > 1)
      reasons.push(`one subject per proposal: it mixes ${causes.length} causes, split it into one proposal per cause`);
    const confidence = typeof raw.confidence === 'number' ? raw.confidence : NaN;
    if (!(confidence >= 0 && confidence <= 1)) reasons.push('"confidence" must be a number from 0 to 1');
    const recommendation = (text(raw.recommendation) || 'accepted') as Decision;
    if (!DECISIONS.includes(recommendation)) reasons.push(`"recommendation" must be one of ${DECISIONS.join(', ')}`);
    if (revisitRef && !revisited)
      reasons.push(
        `"revisits" names "${revisitRef}", which is not a change adopted at the last retro (${[...revisable.keys()].join(', ') || 'none'})`,
      );
    if (reasons.length > 0) {
      result.rejected.push({ index, subject, reasons });
      // Its own rejection says what to fix: no need to ask for a revision again.
      if (revisited) revisionsRejected.add(revisitRef);
      return;
    }

    // Evidence: distinct threads of the period only.
    const seen = new Set<string>();
    const evidence: Evidence[] = [];
    for (const e of cited) {
      if (seen.has(e.thread)) continue;
      seen.add(e.thread);
      if (inPeriod(e.thread)) evidence.push(e);
      else result.notes.push(`${subject}: thread ${e.thread} is not in the period, left out of its evidence`);
    }
    if (evidence.length === 0 && sessions.length === 0 && !audit) {
      result.rejected.push({
        index,
        subject,
        reasons: ['none of the threads or sessions it cites is in the period: copy their ids exactly'],
      });
      return;
    }

    // An excluded subject comes back only for new feedback: neither proposed nor watched without it.
    const exclusion = excludedBy(subject, evidence, text(raw.reopens));
    if (exclusion && exclusion.newThreads.length < 2) {
      result.dropped.push(droppedFor(subject, exclusion.excluded));
      return;
    }
    if (evidence.length + sessions.length < 2 && !audit) {
      watchInput.push({ subject, why: raw.why, evidence, sessions });
      result.notes.push(`${subject}: a single thread or session, moved to the watch list`);
      return;
    }
    const reopens: Proposal['reopens'] = exclusion
      ? {
          retro: exclusion.excluded.retro,
          proposal: exclusion.excluded.proposal,
          at: exclusion.excluded.at,
          newThreads: exclusion.newThreads,
        }
      : undefined;

    // No "keep" for a rule the user had to enforce in the period.
    let finalColumn = column;
    let change = text(raw.change);
    let finalKind = kind;
    let convertedFromKeep: Proposal['convertedFromKeep'];
    if (column === 'keep') {
      const enforced = new Set(ids(raw.enforcedIn).filter(inPeriod));
      for (const e of evidence) {
        const l = ctx.labels[e.thread];
        if (l && (l.category === RULE_NOT_FOLLOWED || (l.ignoredRule ?? 0) >= 0.5)) enforced.add(e.thread);
      }
      if (enforced.size > 0) {
        finalColumn = 'improve';
        finalKind = kind === 'rule' ? 'hook' : kind;
        convertedFromKeep = { threads: [...enforced] };
        change ||=
          'The rule exists, but you had to enforce it in this period: make it a hook (checked every time), ' +
          'or reword it to be concrete and move it up.';
        result.notes.push(
          `${subject}: "keep" turned into "improve", the rule had to be enforced in ${enforced.size} thread(s)`,
        );
      }
    }

    // The target is asked when nothing tells it: an existing rule stays where it is; a new one
    // needs a thread that shows where it belongs.
    const targetEvidence = ids(raw.targetEvidence).filter(inPeriod);
    // A change that revises one adopted at the last retro stays where that one is.
    const askTarget = finalColumn === 'improve' && !text(raw.rule) && targetEvidence.length === 0 && !revisited;

    result.proposals.push({
      id: `p${result.proposals.length + 1}`,
      column: finalColumn,
      subject,
      title: text(raw.title) || subject,
      kind: finalKind,
      file: text(raw.file),
      rule: text(raw.rule) || null,
      change,
      why: text(raw.why),
      cause: causes[0]!,
      evidence,
      ...(sessions.length ? { sessions } : {}),
      ...(evidence.length === 0 && sessions.length > 0 && !audit ? { sessionsOnly: true } : {}),
      figures: figuresOf(evidence.map((e) => ctx.threads.get(e.thread)!)),
      target,
      targetWhy: text(raw.targetWhy),
      askTarget,
      confidence,
      recommendation,
      ...(convertedFromKeep ? { convertedFromKeep } : {}),
      ...(reopens ? { reopens } : {}),
      ...(audit ? { audit } : {}),
      ...(revisited
        ? { revisits: { retro: revisited.retro, proposal: revisited.proposal, verdict: revisited.verdict } }
        : {}),
    });
  });

  // A change that did not reduce the feedback is revised, when there is enough to go on (2 threads).
  for (const v of verifications) {
    if (v.verdict !== 'not-decreased' || v.after.threads < 2) continue;
    if (result.proposals.some((p) => p.revisits && changeRef(p.revisits) === changeRef(v))) continue;
    if (revisionsRejected.has(changeRef(v))) continue;
    result.rejected.push({
      index: 0,
      subject: `check of ${changeRef(v)}`,
      reasons: [
        `"${v.title}" did not reduce the feedback on its subject (${v.before.threads} of ${v.before.total} threads before, ${v.after.threads} of ${v.after.total} now): add a proposal to revise it, with "revisits": "${changeRef(v)}" (reword it, move it up, make it a hook, or remove it)`,
      ],
    });
  }
  result.verifications = verifications;
  result.overview = overviewOf(input.overview, ctx, result);

  for (const w of watchInput) {
    const subject = text(w.subject);
    const evidence = evidenceOf(w.evidence).filter((e) => inPeriod(e.thread));
    // Sessions come checked from a proposal moved here; the agent's own watch items cite threads.
    const sessions = Array.isArray(w.sessions) ? (w.sessions as SessionEvidence[]) : [];
    if (!subject || evidence.length + sessions.length === 0) continue;
    const exclusion = excludedBy(subject, evidence, text(w.reopens));
    if (exclusion && exclusion.newThreads.length < 2) {
      result.dropped.push(droppedFor(subject, exclusion.excluded));
      continue;
    }
    result.watch.push({
      id: `w${result.watch.length + 1}`,
      subject,
      why: text(w.why),
      evidence,
      ...(sessions.length ? { sessions } : {}),
    });
  }
  return result;
}

/**
 * The check of the changes adopted at the last retro: the analysis names, for each one, the threads
 * of this period on the same subject (`verify: [{ change, threads, note }]`); the numbers and the
 * verdict are computed here. A change left unchecked is rejected.
 */
function verify(input: unknown, ctx: GuardContext, result: GuardResult): Verification[] {
  const adopted = ctx.adopted ?? [];
  const given = new Map<string, Raw>();
  for (const x of Array.isArray(input) ? input.filter(isRecord) : []) given.set(text(x.change), x);
  const total = ctx.threads.size;
  const out: Verification[] = [];
  for (const c of adopted) {
    const ref = changeRef(c);
    const x = given.get(ref);
    given.delete(ref);
    if (!x || !Array.isArray(x.threads)) {
      result.rejected.push({
        index: 0,
        subject: `check of ${ref}`,
        reasons: [
          `"verify" must check "${c.title}", adopted at the last retro: { "change": "${ref}", "threads": [the threads of this period on the same subject, [] when none] }`,
        ],
      });
      continue;
    }
    const all = [...new Set(ids(x.threads))];
    const kept = all.filter((id) => ctx.threads.has(id));
    for (const id of all.filter((id) => !ctx.threads.has(id)))
      result.notes.push(`check of ${ref}: thread ${id} is not in the period, left out`);
    const after = { threads: kept.length, total, ids: kept };
    out.push({
      ...c,
      after,
      verdict: verdictOf(c.before, after),
      ...(text(x.note) ? { note: text(x.note) } : {}),
    });
  }
  for (const ref of given.keys())
    if (ref) result.notes.push(`check of ${ref}: not a change adopted at the last retro, ignored`);
  return out;
}
