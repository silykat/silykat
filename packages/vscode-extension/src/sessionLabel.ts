import { topicLabel, type Session } from '@local-review/core';

/** A session as the user tells it apart: its agent and short id, e.g. "Claude a1b2c3d4". */
export const sessionLabel = (s: Session): string => `${s.agent} ${s.id.slice(0, 8)}`;

/** What a session is subscribed to, e.g. "app · feature-x, /specs/plan.md". */
export const sessionTopics = (s: Session): string =>
  s.subscriptions.length === 0
    ? 'not subscribed to anything'
    : s.subscriptions.map((x) => topicLabel(x.topic)).join(', ');
