import { readFile } from 'node:fs/promises';
import { FEEDBACK_CATEGORIES, jevKeyStatus, type ThreadLabel } from '@silykat/core';

/**
 * Classification of a retro's threads by Jev (jevtypesafeai.com), when the user has a key: one
 * decision per thread, with the category of the feedback and two yes/no detectors. It is the only
 * network call of silykat, made only here, at the user's request, and the key goes nowhere
 * else: it is never printed, logged or written.
 */
export const JEV_URL = 'https://jevtypesafeai.com/api/v1/decide';

const INTRO = 'Code review thread between a developer and their AI coding agent. ';
const QUESTIONS = {
  category: {
    type: 'choice',
    instructions: INTRO + 'Which category best explains why the developer commented (the root cause, not the symptom)?',
    criteria: Object.fromEntries(Object.entries(FEEDBACK_CATEGORIES).map(([n, d]) => [n, d])),
  },
  missing_rule: {
    type: 'noul',
    instructions:
      INTRO +
      "Does the developer's feedback reveal a constraint, convention or fact specific to THIS project (not general good practice) that the rules files do not state?",
  },
  ignored_rule: {
    type: 'noul',
    instructions:
      INTRO +
      "Does the developer's feedback point to something the rules files already state, that the agent did not follow?",
  },
};

/** The key: `$JEV_API_KEY`, or the key file once it is safe (only the user can read it, in no repository). */
export async function readJevKey(env: Record<string, string | undefined> = process.env): Promise<string> {
  const fromEnv = env.JEV_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const s = await jevKeyStatus(env);
  if (!s.exists) throw new Error(`no Jev key: ${s.path} does not exist (slk retro key tells how to add one)`);
  if (!s.ok) throw new Error(`the Jev key file is not safe, fix it first: ${s.fixes.join('; ')}`);
  const key = (await readFile(s.path, 'utf8')).trim();
  if (!key) throw new Error(`the Jev key file ${s.path} is empty`);
  return key;
}

export interface JevDeps {
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  key: string;
  url?: string;
  /** Requests at a time. */
  concurrency?: number;
  timeoutMs?: number;
}

export interface JevResult {
  labels: Record<string, ThreadLabel>;
  failed: { thread: string; error: string }[];
  costUsd: number;
}

interface Answer {
  choice?: string | number;
  confidence?: number;
  noul?: number;
}

const unit = (x: unknown) => (typeof x === 'number' && x >= 0 && x <= 1 ? x : undefined);

/** One decision: the label of a thread, or why it failed (never with the key in it). */
async function decide(text: string, rules: string, deps: JevDeps): Promise<{ label: ThreadLabel; cost: number }> {
  const res = await deps.fetch(deps.url ?? JEV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deps.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: `Rules files of the project:\n${rules}\n\n---\n\n${text}`, questions: QUESTIONS }),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000),
  });
  if (!res.ok) throw new Error(`Jev answered HTTP ${res.status}`);
  const o = (await res.json()) as { answers?: Record<string, Answer>; usage?: { cost_usd?: number } };
  const a = o.answers ?? {};
  const category = Number(a.category?.choice);
  if (!FEEDBACK_CATEGORIES[category]) throw new Error('Jev gave no category');
  const label: ThreadLabel = { category };
  const conf = unit(a.category?.confidence);
  const missing = unit(a.missing_rule?.noul);
  const ignored = unit(a.ignored_rule?.noul);
  if (conf !== undefined) label.confidence = conf;
  if (missing !== undefined) label.missingRule = missing;
  if (ignored !== undefined) label.ignoredRule = ignored;
  return { label, cost: typeof o.usage?.cost_usd === 'number' ? o.usage.cost_usd : 0 };
}

/** Classifies threads, a few requests at a time; a failed thread is retried once. */
export async function classifyWithJev(
  threads: readonly { id: string; text: string }[],
  rules: string,
  deps: JevDeps,
): Promise<JevResult> {
  const result: JevResult = { labels: {}, failed: [], costUsd: 0 };
  const queue = [...threads];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      let error = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { label, cost } = await decide(t.text, rules, deps);
          result.labels[t.id] = label;
          result.costUsd += cost;
          error = '';
          break;
        } catch (err) {
          // Only our own messages, or the error's name: never a message that could echo the request.
          error =
            err instanceof Error && err.message.startsWith('Jev ')
              ? err.message
              : `request failed (${(err as Error)?.name ?? 'error'})`;
        }
      }
      if (error) result.failed.push({ thread: t.id, error });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, deps.concurrency ?? 4) }, worker));
  return result;
}
