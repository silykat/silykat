import { randomBytes } from 'node:crypto';

// Crockford base32, as used by ULID.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID-like id: 10 chars of millisecond timestamp + 16 random chars, sortable by creation time. */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % 32];
  return time + rand;
}

export const newThreadId = (): string => `t_${ulid()}`;
export const newCommentId = (): string => `c_${ulid()}`;
export const newReviewId = (): string => `r_${ulid()}`;
