import type { ThreadHistory } from './history';
import {
  COLUMNS,
  DECISIONS,
  PROPOSAL_KINDS,
  RULE_NOT_FOLLOWED,
  TARGETS,
  type Column,
  type Decision,
  type Dropped,
  type Evidence,
  type Figures,
  type Proposal,
  type ProposalKind,
  type RetroState,
  type Target,
  type ThreadLabel,
  type WatchItem,
} from './retro';

/** Statistics of a period, computed without a model. */
export interface RetroStats {
  threads: number;
  reopened: number;
  questions: number;
  /** Threads where the user replied again after the agent's reply. */
  backAndForth: number;
  deleted: number;
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
  /** Must be fixed before the proposals can be recorded. */
  rejected: Rejected[];
  /** What the guard rails changed, for the record: moved to the watch list, a keep turned into improve… */
  notes: string[];
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

const ids = (x: unknown): string[] => (Array.isArray(x) ? x.map(text).filter((s) => s !== '') : []);

/**
 * The guard rails of the proposals of a retro, applied by program whatever the agent that wrote them:
 * - at least 2 threads of the period per proposal; a preference seen once goes to the watch list;
 * - no "keep" for a rule the user had to enforce in the period: it becomes "improve";
 * - one subject (one cause) per proposal;
 * - the target is asked when nothing in the threads tells it;
 * - a subject excluded in an earlier retro comes back only with at least 2 new threads.
 *
 * `input` is the agent's output: `{ proposals: [...], watch: [...] }`.
 */
export function checkProposals(input: unknown, ctx: GuardContext): GuardResult {
  const result: GuardResult = { proposals: [], watch: [], dropped: [], rejected: [], notes: [] };
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
    const target = text(raw.target) as Target;
    if (!TARGETS.includes(target)) reasons.push(`"target" must be one of ${TARGETS.join(', ')}`);
    const kind = (text(raw.kind) || 'rule') as ProposalKind;
    if (!PROPOSAL_KINDS.includes(kind)) reasons.push(`"kind" must be one of ${PROPOSAL_KINDS.join(', ')}`);
    if (!subject) reasons.push('"subject" is missing');
    if (!text(raw.why)) reasons.push('"why" is missing: the common cause, and what the change must avoid');
    if (!text(raw.file)) reasons.push('"file" is missing: the file of the rule, or where the change goes');
    // `threads` (a list of ids) is taken for `evidence`, without excerpts.
    const cited = evidenceOf(raw.evidence ?? raw.threads);
    if (cited.length === 0) reasons.push('"evidence" is missing: the threads that support it, with an excerpt each');
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
    if (reasons.length > 0) {
      result.rejected.push({ index, subject, reasons });
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
    if (evidence.length === 0) {
      result.rejected.push({
        index,
        subject,
        reasons: ['none of the threads it cites is in the period: copy their ids exactly'],
      });
      return;
    }

    // An excluded subject comes back only for new feedback: neither proposed nor watched without it.
    const exclusion = excludedBy(subject, evidence, text(raw.reopens));
    if (exclusion && exclusion.newThreads.length < 2) {
      result.dropped.push(droppedFor(subject, exclusion.excluded));
      return;
    }
    if (evidence.length < 2) {
      watchInput.push({ subject, why: raw.why, evidence });
      result.notes.push(`${subject}: a single thread, moved to the watch list`);
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
    const askTarget = finalColumn === 'improve' && !text(raw.rule) && targetEvidence.length === 0;

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
      figures: figuresOf(evidence.map((e) => ctx.threads.get(e.thread)!)),
      target,
      targetWhy: text(raw.targetWhy),
      askTarget,
      confidence,
      recommendation,
      ...(convertedFromKeep ? { convertedFromKeep } : {}),
      ...(reopens ? { reopens } : {}),
    });
  });

  for (const w of watchInput) {
    const subject = text(w.subject);
    const evidence = evidenceOf(w.evidence).filter((e) => inPeriod(e.thread));
    if (!subject || evidence.length === 0) continue;
    const exclusion = excludedBy(subject, evidence, text(w.reopens));
    if (exclusion && exclusion.newThreads.length < 2) {
      result.dropped.push(droppedFor(subject, exclusion.excluded));
      continue;
    }
    result.watch.push({ id: `w${result.watch.length + 1}`, subject, why: text(w.why), evidence });
  }
  return result;
}
