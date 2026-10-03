import { parseArgs } from 'node:util';

/** A mistake in the command line: the usage is printed with it. */
export class UsageError extends Error {}

export type Values = Record<string, string | boolean | string[] | undefined>;

export function parse(
  rest: string[],
  options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>,
): { values: Values; positionals: string[] } {
  try {
    const parsed = parseArgs({ args: rest, options: { root: { type: 'string' }, ...options }, allowPositionals: true });
    return { values: parsed.values as Values, positionals: parsed.positionals };
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

export const str = (v: Values[string]): string | undefined => (typeof v === 'string' ? v : undefined);
