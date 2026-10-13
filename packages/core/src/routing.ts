import type { Session } from './sessions';
import { isWithin, topicCovers, type Topic } from './topics';

export { isWithin };

/**
 * Sessions that matter to some folders: started in, above or below one of them, or subscribed to
 * something inside one.
 */
export function relevantSessions(sessions: readonly Session[], folders: readonly string[]): Session[] {
  const inside = (p: string | undefined) => p !== undefined && folders.some((f) => isWithin(p, f));
  return sessions.filter(
    (s) =>
      folders.some((f) => isWithin(s.cwd, f) || isWithin(f, s.cwd)) ||
      s.subscriptions.some((sub) => inside(sub.topic.kind === 'branch' ? sub.topic.worktree : sub.topic.path)),
  );
}

/**
 * The sessions a comment on `file` (whose own topic is `topic`) is published to: every session
 * subscribed to that topic. silykat publishes; what each session does with it is up to it.
 */
export function subscribersOf(sessions: readonly Session[], file: string, topic: Topic): Session[] {
  return sessions.filter((s) => s.subscriptions.some((sub) => topicCovers(sub.topic, topic, file)));
}
