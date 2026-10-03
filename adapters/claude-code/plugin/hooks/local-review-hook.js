#!/usr/bin/env node
"use strict";

// src/hookMain.ts
var import_node_os3 = require("node:os");

// ../../packages/core/src/types.ts
var SCHEMA_VERSION = 2;
var STORE_DIR = ".local-review";
var DELETE_REASONS = ["user", "branch-gone"];
function sessionRefOf(raw) {
  if (typeof raw !== "object" || raw === null) return void 0;
  const { id, message } = raw;
  if (typeof id !== "string" || id.trim() === "") return void 0;
  return typeof message === "string" && message.trim() !== "" ? { id, message } : { id };
}
var branchKey = (b) => b ? `${b.repo}#${b.branch}` : "";
var reviewScopeKey = (s) => s.branch ? branchKey(s.branch) : s.path ? `path:${s.path}` : "";

// ../../packages/core/src/ids.ts
var import_node_crypto = require("node:crypto");
var ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(now = Date.now()) {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = (0, import_node_crypto.randomBytes)(16);
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % 32];
  return time + rand;
}
var newThreadId = () => `t_${ulid()}`;
var newCommentId = () => `c_${ulid()}`;
var newReviewId = () => `r_${ulid()}`;

// ../../packages/core/src/events.ts
var THREAD_EVENT_TYPES = /* @__PURE__ */ new Set([
  "thread.created",
  "comment.added",
  "comment.edited",
  "comment.deleted",
  "status.changed",
  "anchor.updated",
  "branch.changed",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived"
]);
var FIRST_VERSION = 1;
var ARCHIVE_VERSION = 2;
var REVIEW_EVENT_TYPES = /* @__PURE__ */ new Set([
  "review.started",
  "review.branch.changed",
  "review.submitted",
  "review.discarded"
]);
function serializeEvents(events) {
  return events.map((e) => JSON.stringify(e) + "\n").join("");
}
function parseJournal(text, source = "journal") {
  return parseEvents(text, source, THREAD_EVENT_TYPES);
}
function parseReviewJournal(text, source = "review") {
  return parseEvents(text, source, REVIEW_EVENT_TYPES);
}
function parseEvents(text, source, types) {
  const events = [];
  const warnings = [];
  let futureVersion = false;
  const lastNewline = text.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : text.slice(0, lastNewline);
  const lines = complete === "" ? [] : complete.split("\n");
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      warnings.push(`${source}:${i + 1}: invalid JSON, line skipped`);
      return;
    }
    if (!isRecord(raw) || typeof raw.v !== "number" || typeof raw.type !== "string") {
      warnings.push(`${source}:${i + 1}: not an event, line skipped`);
      return;
    }
    if (raw.v > SCHEMA_VERSION) {
      futureVersion = true;
      return;
    }
    if (raw.by === "claude") {
      raw.by = "agent";
      raw.agent ??= "Claude";
    }
    if (!types.has(raw.type)) {
      warnings.push(`${source}:${i + 1}: unknown event type "${raw.type}", line skipped`);
      return;
    }
    events.push(raw);
  });
  return { events, warnings, futureVersion };
}
function isRecord(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// ../../packages/core/src/fold.ts
function foldThread(events, opts = {}) {
  const first = events[0];
  if (!first || first.type !== "thread.created") return null;
  const reviews = opts.reviews ?? /* @__PURE__ */ new Map();
  const isDraft = (reviewId) => reviewId !== null && reviews.get(reviewId)?.state !== "submitted";
  const state = {
    id: first.threadId,
    anchor: first.anchor,
    branch: first.branch ?? null,
    status: "open",
    comments: [],
    createdAt: first.at,
    deleted: false,
    archived: false,
    archivedAt: null,
    readOnly: opts.futureVersion ?? false,
    lastAuthor: null,
    lastAgentName: null,
    hasPublished: false,
    onlyDrafts: false
  };
  const byId = /* @__PURE__ */ new Map();
  const discarded = (reviewId) => reviewId !== null && reviews.get(reviewId)?.state === "discarded";
  for (const e of events.slice(1)) {
    switch (e.type) {
      case "comment.added": {
        if (discarded(e.reviewId)) break;
        const c = {
          id: e.commentId,
          author: e.by,
          ...e.by === "agent" && e.agent ? { agentName: e.agent } : {},
          body: e.body,
          createdAt: e.at,
          reviewId: e.reviewId,
          isDraft: isDraft(e.reviewId)
        };
        byId.set(c.id, c);
        state.comments.push(c);
        break;
      }
      case "comment.edited": {
        const c = byId.get(e.commentId);
        if (c && c.author === e.by) {
          c.body = e.body;
          c.editedAt = e.at;
        }
        break;
      }
      case "comment.deleted": {
        const c = byId.get(e.commentId);
        if (c && c.author === e.by) {
          byId.delete(e.commentId);
          state.comments = state.comments.filter((x) => x.id !== e.commentId);
        }
        break;
      }
      case "status.changed":
        state.status = e.status;
        break;
      case "anchor.updated":
        state.anchor = e.anchor;
        break;
      case "branch.changed":
        state.branch = e.branch;
        break;
      case "thread.deleted":
        state.deleted = true;
        break;
      // Only the user archives: an event by anyone else is not valid.
      case "thread.archived":
        if (e.by === "user") {
          state.archived = true;
          state.archivedAt = e.at;
        }
        break;
      case "thread.unarchived":
        if (e.by === "user") {
          state.archived = false;
          state.archivedAt = null;
        }
        break;
      case "thread.created":
        break;
    }
  }
  if (state.comments.length === 0) state.deleted = true;
  const last = state.comments[state.comments.length - 1];
  state.lastAuthor = last ? last.author : null;
  state.lastAgentName = [...state.comments].reverse().find((c) => c.agentName)?.agentName ?? null;
  state.hasPublished = state.comments.some((c) => !c.isDraft);
  state.onlyDrafts = state.comments.length > 0 && !state.hasPublished;
  return state;
}
function foldReview(events) {
  const first = events[0];
  if (!first || first.type !== "review.started") return null;
  const state = {
    id: first.reviewId,
    state: "active",
    branch: first.branch ?? null,
    path: first.branch ? null : first.path ?? null,
    startedAt: first.at
  };
  for (const e of events.slice(1)) {
    if (state.state !== "active") break;
    if (e.type === "review.branch.changed") state.branch = e.branch;
    else if (e.type === "review.submitted") {
      state.state = "submitted";
      state.submittedAt = e.at;
      if (e.summary) state.summary = e.summary;
    } else if (e.type === "review.discarded") {
      state.state = "discarded";
    }
  }
  return state;
}

// ../../packages/core/src/store.ts
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");

// ../../packages/core/src/history.ts
var HISTORY_STATES = ["open", "needs-info", "addressed", "resolved", "deleted"];
function threadHistory(events, opts = {}) {
  const first = events[0];
  if (!first || first.type !== "thread.created") return null;
  const reviews = opts.reviews ?? /* @__PURE__ */ new Map();
  const published = (reviewId, at) => {
    if (reviewId === null) return at;
    const review = reviews.get(reviewId);
    return review?.state === "submitted" ? review.submittedAt ?? at : null;
  };
  let anchor = first.anchor;
  let branch = first.branch ?? null;
  let status = "open";
  let deletedAt = null;
  let deletedReason = null;
  let archivedAt = null;
  let resolvedAt = null;
  let lastCommentDeletedAt = null;
  const conversation = [];
  const comments = /* @__PURE__ */ new Map();
  const publishedAt = /* @__PURE__ */ new Map();
  const drop = (id) => {
    comments.delete(id);
    const i = conversation.findIndex((x) => x.kind === "comment" && x.id === id);
    if (i >= 0) conversation.splice(i, 1);
  };
  const agentOf = (e) => e.by === "agent" && e.agent ? { agent: e.agent } : {};
  for (const e of events.slice(1)) {
    switch (e.type) {
      case "comment.added": {
        const at = published(e.reviewId, e.at);
        if (at === null) break;
        const session = e.by === "agent" ? sessionRefOf(e.session) : void 0;
        const c = {
          kind: "comment",
          id: e.commentId,
          author: e.by,
          ...agentOf(e),
          body: e.body,
          at: e.at,
          ...at !== e.at ? { publishedAt: at } : {},
          ...session ? { session } : {}
        };
        comments.set(c.id, c);
        publishedAt.set(c.id, at);
        conversation.push(c);
        break;
      }
      case "comment.edited": {
        const c = comments.get(e.commentId);
        if (c && c.author === e.by && !c.deletedAt) {
          c.body = e.body;
          if (e.at >= publishedAt.get(c.id)) c.editedAt = e.at;
        }
        break;
      }
      case "comment.deleted": {
        const c = comments.get(e.commentId);
        if (!c || c.author !== e.by) break;
        if (e.at < publishedAt.get(c.id)) drop(c.id);
        else c.deletedAt ??= e.at;
        lastCommentDeletedAt = e.at;
        break;
      }
      case "status.changed":
        status = e.status;
        resolvedAt = e.status === "resolved" ? e.at : null;
        conversation.push({ kind: "status", status: e.status, by: e.by, ...agentOf(e), at: e.at });
        break;
      case "anchor.updated":
        anchor = e.anchor;
        break;
      case "branch.changed":
        branch = e.branch;
        break;
      case "thread.deleted":
        if (deletedAt === null) {
          deletedAt = e.at;
          deletedReason = knownReason(e.reason) ?? (lastCommentDeletedAt === e.at ? "user" : null);
          conversation.push({
            kind: "deleted",
            by: e.by,
            ...agentOf(e),
            at: e.at,
            ...deletedReason ? { reason: deletedReason } : {}
          });
        }
        break;
      case "thread.archived":
        if (e.by === "user") archivedAt = e.at;
        break;
      case "thread.unarchived":
        if (e.by === "user") archivedAt = null;
        break;
      case "thread.created":
        break;
    }
  }
  if (deletedAt !== null) {
    for (const [id, at] of publishedAt) if (at > deletedAt && comments.has(id)) drop(id);
  }
  if (comments.size === 0) return null;
  const all = [...comments.values()];
  if (deletedAt === null && all.every((c) => c.deletedAt)) {
    deletedAt = all.map((c) => c.deletedAt).sort().at(-1);
    deletedReason = "user";
  }
  const activity = conversation.flatMap(
    (x) => x.kind === "comment" ? [x.publishedAt ?? x.at, x.editedAt ?? "", x.deletedAt ?? ""] : [x.at]
  );
  if (deletedAt) activity.push(deletedAt);
  return {
    id: first.threadId,
    state: deletedAt ? "deleted" : status,
    status,
    anchor,
    branch,
    createdAt: first.at,
    lastActivityAt: activity.reduce((a, b) => b > a ? b : a, first.at),
    deletedAt,
    archivedAt,
    resolvedAt,
    deletedReason: deletedAt ? deletedReason : null,
    readOnly: opts.futureVersion ?? false,
    conversation,
    bytes: opts.bytes ?? 0
  };
}
function activeSince(thread, sinceMs) {
  return sinceMs === null || Date.parse(thread.lastActivityAt) >= sinceMs;
}
function countStates(threads) {
  const counts = Object.fromEntries(HISTORY_STATES.map((s) => [s, 0]));
  for (const t of threads) counts[t.state]++;
  return counts;
}
var knownReason = (r) => DELETE_REASONS.includes(r) ? r : null;
var countArchived = (threads) => threads.filter((t) => t.archivedAt !== null).length;
function countDeletions(threads) {
  const counts = { user: 0, "branch-gone": 0, unknown: 0 };
  for (const t of threads) if (t.state === "deleted") counts[t.deletedReason ?? "unknown"]++;
  return counts;
}

// ../../packages/core/src/store.ts
var Store = class {
  /**
   * A store of the files under `root`, kept in `<root>/.local-review/` by default. `dir` puts it
   * elsewhere (e.g. the machine store of the files outside any open folder).
   */
  constructor(root, dir = (0, import_node_path.join)(root, STORE_DIR)) {
    this.root = root;
    this.dir = dir;
  }
  root;
  dir;
  get threadsDir() {
    return (0, import_node_path.join)(this.dir, "threads");
  }
  threadFile(threadId) {
    if (!THREAD_ID.test(threadId)) throw new Error(`Invalid thread id: ${threadId}`);
    return (0, import_node_path.join)(this.threadsDir, `${threadId}.jsonl`);
  }
  get reviewsDir() {
    return (0, import_node_path.join)(this.dir, "reviews");
  }
  reviewFile(reviewId) {
    if (!REVIEW_ID.test(reviewId)) throw new Error(`Invalid review id: ${reviewId}`);
    return (0, import_node_path.join)(this.reviewsDir, `${reviewId}.jsonl`);
  }
  /** Thread id of a journal file name, or `null` if the name is not a thread journal. */
  static threadIdOf(fileName) {
    const id = fileName.endsWith(".jsonl") ? fileName.slice(0, -".jsonl".length) : "";
    return THREAD_ID.test(id) ? id : null;
  }
  /**
   * Loads every thread in use (neither deleted nor archived) and every review. A missing store is
   * simply empty: reading never creates it.
   */
  async loadAll() {
    const { reviews, warnings } = await this.loadReviews();
    const threads = [];
    for (const file of await listJournals(this.threadsDir)) {
      const { state, warnings: w } = await this.readJournal((0, import_node_path.join)(this.threadsDir, file), `threads/${file}`, reviews);
      warnings.push(...w);
      if (state && !state.deleted && !state.archived) threads.push(state);
    }
    return { threads, reviews: [...reviews.values()], warnings };
  }
  /**
   * The whole history of every thread, whatever its state (deleted ones included), for reading
   * back what happened. Threads holding only drafts are left out. Reading never creates the store.
   */
  async loadHistory() {
    const { reviews, warnings } = await this.loadReviews();
    const files = await listJournals(this.threadsDir);
    const read = await Promise.all(files.map((f) => (0, import_promises.readFile)((0, import_node_path.join)(this.threadsDir, f), "utf8")));
    const threads = [];
    files.forEach((file, i) => {
      const text = read[i];
      const label = `threads/${file}`;
      const parsed = parseJournal(text, label);
      warnings.push(...parsed.warnings);
      if (parsed.events[0]?.type !== "thread.created") {
        warnings.push(`${label}: no thread.created event, file skipped`);
        return;
      }
      const history = threadHistory(parsed.events, {
        reviews,
        futureVersion: parsed.futureVersion,
        bytes: Buffer.byteLength(text)
      });
      if (history) threads.push(history);
    });
    return { threads, warnings };
  }
  async loadThread(threadId) {
    const { reviews } = await this.loadReviews();
    try {
      return await this.readJournal(this.threadFile(threadId), `threads/${threadId}.jsonl`, reviews);
    } catch (err) {
      if (isNotFound(err)) return { state: null, warnings: [] };
      throw err;
    }
  }
  async loadReviews() {
    const reviews = /* @__PURE__ */ new Map();
    const warnings = [];
    for (const file of await listJournals(this.reviewsDir)) {
      const label = `reviews/${file}`;
      const parsed = parseReviewJournal(await (0, import_promises.readFile)((0, import_node_path.join)(this.reviewsDir, file), "utf8"), label);
      warnings.push(...parsed.warnings);
      const state = foldReview(parsed.events);
      if (state) reviews.set(state.id, state);
      else warnings.push(`${label}: no review.started event, file skipped`);
    }
    return { reviews, warnings };
  }
  /** The review in progress for a branch, or off any branch (`null`) for a folder, if any. */
  async activeReview(branch = null, path = null) {
    const { reviews } = await this.loadReviews();
    return latestActive(reviews, { branch, path });
  }
  /** Every review in progress: at most one per branch, and off any branch one per folder. */
  async activeReviews() {
    const { reviews } = await this.loadReviews();
    const latest = /* @__PURE__ */ new Map();
    for (const r of reviews.values()) {
      if (r.state !== "active") continue;
      const current = latest.get(reviewScopeKey(r));
      if (!current || r.startedAt > current.startedAt) latest.set(reviewScopeKey(r), r);
    }
    return [...latest.values()];
  }
  /**
   * Starts a review of a branch, or off any branch (`branch` = `null`) of the folder at `path`;
   * or returns the one already in progress there.
   */
  async startReview(branch = null, path = null) {
    const active = await this.activeReview(branch, path);
    if (active) return active;
    await this.ensureInitialized();
    const reviewId = newReviewId();
    const event = {
      v: FIRST_VERSION,
      type: "review.started",
      at: (/* @__PURE__ */ new Date()).toISOString(),
      by: "user",
      reviewId,
      ...branch ? { branch } : path ? { path } : {}
    };
    await (0, import_promises.appendFile)(this.reviewFile(reviewId), serializeEvents([event]), { flag: "a" });
    return foldReview([event]);
  }
  /** A review in progress follows its renamed branch. */
  async setReviewBranch(reviewId, branch) {
    await this.assertActiveReview(reviewId);
    const event = {
      v: FIRST_VERSION,
      type: "review.branch.changed",
      at: (/* @__PURE__ */ new Date()).toISOString(),
      by: "user",
      branch
    };
    await (0, import_promises.appendFile)(this.reviewFile(reviewId), serializeEvents([event]), { flag: "a" });
  }
  async submitReview(reviewId, summary) {
    await this.assertActiveReview(reviewId);
    const { threads: before } = await this.loadAll();
    const text = summary?.trim();
    const event = {
      v: FIRST_VERSION,
      type: "review.submitted",
      at: (/* @__PURE__ */ new Date()).toISOString(),
      by: "user",
      ...text ? { summary: text } : {}
    };
    await (0, import_promises.appendFile)(this.reviewFile(reviewId), serializeEvents([event]), { flag: "a" });
    for (const t of before) {
      const repliesInReview = t.comments.some((c) => c.reviewId === reviewId && c.author === "user");
      if (repliesInReview && t.status !== "open" && !t.readOnly) await this.setStatus(t.id, "open", "user");
    }
    const { reviews } = await this.loadReviews();
    return reviews.get(reviewId);
  }
  /** Abandons a review: its draft comments are dropped, and threads holding only drafts disappear. */
  async discardReview(reviewId) {
    await this.assertActiveReview(reviewId);
    const event = {
      v: FIRST_VERSION,
      type: "review.discarded",
      at: (/* @__PURE__ */ new Date()).toISOString(),
      by: "user"
    };
    await (0, import_promises.appendFile)(this.reviewFile(reviewId), serializeEvents([event]), { flag: "a" });
    const { reviews } = await this.loadReviews();
    return reviews.get(reviewId);
  }
  /**
   * Adds a comment, optionally changing the status in the same write so that readers never
   * observe the comment without its status.
   *
   * A published reply from the user hands the thread back to the agent: unless a status is
   * given, a thread that is `needs-info`, `addressed` or `resolved` goes back to `open`.
   */
  async addComment(threadId, c, opts = {}) {
    const body = c.body.trim();
    if (body === "") throw new Error("Comment body is empty");
    if (opts.status) assertCanSetStatus(opts.status, c.author);
    if (c.reviewId !== null) await this.assertCanDraft(c.reviewId, c.author);
    const current = await this.writableThread(threadId, c.author);
    const who = actor(c.author, c.agent);
    const reopens = c.author === "user" && c.reviewId === null && current.status !== "open";
    const status = opts.status ?? (reopens ? "open" : void 0);
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const session = c.author === "agent" ? sessionRefOf(c.session) : void 0;
    const events = [
      {
        v: FIRST_VERSION,
        type: "comment.added",
        at,
        ...who,
        commentId: newCommentId(),
        body,
        reviewId: c.reviewId,
        ...session ? { session } : {}
      }
    ];
    if (status) events.push({ v: FIRST_VERSION, type: "status.changed", at, ...who, status });
    return this.appendAndReload(threadId, events);
  }
  async setStatus(threadId, status, by, agent) {
    assertCanSetStatus(status, by);
    const who = actor(by, agent);
    await this.writableThread(threadId, by);
    const event = {
      v: FIRST_VERSION,
      type: "status.changed",
      at: (/* @__PURE__ */ new Date()).toISOString(),
      ...who,
      status
    };
    return this.appendAndReload(threadId, [event]);
  }
  /** Records where the thread's code now is (after the file changed). */
  async updateAnchor(threadId, anchor, by, agent) {
    const who = actor(by, agent);
    await this.writableThread(threadId, by);
    const event = {
      v: FIRST_VERSION,
      type: "anchor.updated",
      at: (/* @__PURE__ */ new Date()).toISOString(),
      ...who,
      anchor
    };
    return this.appendAndReload(threadId, [event]);
  }
  /** A thread follows its renamed branch (or is given one). */
  async setBranch(threadId, branch) {
    await this.writableThread(threadId, "user");
    const event = {
      v: FIRST_VERSION,
      type: "branch.changed",
      at: (/* @__PURE__ */ new Date()).toISOString(),
      by: "user",
      branch
    };
    return this.appendAndReload(threadId, [event]);
  }
  /** Edits a comment. Only its author can edit it. */
  async editComment(threadId, commentId, body, by, agent) {
    const text = body.trim();
    if (text === "") throw new Error("Comment body is empty");
    const who = actor(by, agent);
    const current = await this.writableThread(threadId, by);
    assertOwnComment(current, commentId, by);
    const comment = current.comments.find((c) => c.id === commentId);
    if (comment.body === text) return current;
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const events = [{ v: FIRST_VERSION, type: "comment.edited", at, ...who, commentId, body: text }];
    const handled = current.status === "addressed" || current.status === "needs-info";
    if (by === "user" && !comment.isDraft && handled)
      events.push({ v: FIRST_VERSION, type: "status.changed", at, ...who, status: "open" });
    return this.appendAndReload(threadId, events);
  }
  /**
   * Deletes a comment. Only its author can delete it. Deleting the last comment deletes the
   * thread too, in the same write: a thread never exists without comments.
   */
  async deleteComment(threadId, commentId, by, agent) {
    const who = actor(by, agent);
    const current = await this.writableThread(threadId, by);
    assertOwnComment(current, commentId, by);
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const events = [{ v: FIRST_VERSION, type: "comment.deleted", at, ...who, commentId }];
    if (current.comments.length === 1)
      events.push({ v: FIRST_VERSION, type: "thread.deleted", at, ...who, reason: "user" });
    return this.appendAndReload(threadId, events);
  }
  /**
   * Deletes a whole thread, agent replies included. Only the user can (the editor also does it for
   * them when the thread's branch was deleted: `reason` tells which). The journal keeps its history
   * (append-only): the thread is simply never shown again.
   */
  async deleteThread(threadId, by, reason = "user") {
    if (by !== "user") throw new Error("Only the user can delete a thread");
    await this.writableThread(threadId, by);
    const event = {
      v: FIRST_VERSION,
      type: "thread.deleted",
      at: (/* @__PURE__ */ new Date()).toISOString(),
      by,
      reason
    };
    return this.appendAndReload(threadId, [event]);
  }
  /**
   * Archives a thread (the user only, e.g. through the editor or an agent asked to): it leaves the
   * editor and what agents see, and stays in the history. Archiving an archived thread does nothing.
   */
  async archiveThread(threadId) {
    const current = await this.writableThread(threadId, "user", { archived: true });
    if (current.archived) return current;
    return this.appendArchiveEvent(threadId, "thread.archived");
  }
  /** Brings an archived thread back. Unarchiving a thread that is not archived does nothing. */
  async unarchiveThread(threadId) {
    const current = await this.writableThread(threadId, "user", { archived: true });
    if (!current.archived) return current;
    return this.appendArchiveEvent(threadId, "thread.unarchived");
  }
  async appendArchiveEvent(threadId, type) {
    await this.ensureInitialized();
    return this.appendAndReload(threadId, [{ v: ARCHIVE_VERSION, type, at: (/* @__PURE__ */ new Date()).toISOString(), by: "user" }]);
  }
  /**
   * Deletes a thread's journal for good: unlike `deleteThread`, nothing is left, not even in the
   * history. Returns whether there was one.
   */
  async purgeThread(threadId) {
    try {
      await (0, import_promises.rm)(this.threadFile(threadId));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }
  /**
   * A thread `by` may write to. Agents never see threads that only hold drafts, nor archived ones;
   * the user must unarchive a thread before changing it (`archived`: archiving or unarchiving it).
   */
  async writableThread(threadId, by, opts = {}) {
    const { state } = await this.loadThread(threadId);
    if (!state || state.deleted || by === "agent" && (!state.hasPublished || state.archived)) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    if (opts.archived && !state.hasPublished) throw new Error(`Thread not found: ${threadId} (only drafts)`);
    if (state.archived && !opts.archived && !state.readOnly)
      throw new Error(`Thread ${threadId} is archived: unarchive it first`);
    if (state.readOnly)
      throw new Error(
        `Thread ${threadId} was written by a newer version of Local Review, so it is read-only: update Local Review to change it`
      );
    return state;
  }
  async appendAndReload(threadId, events) {
    await (0, import_promises.appendFile)(this.threadFile(threadId), serializeEvents(events), { flag: "a" });
    const { state } = await this.loadThread(threadId);
    if (!state) throw new Error(`Thread vanished while writing: ${threadId}`);
    return state;
  }
  /** Drafts belong to the user: only the user writes them, and only in the review in progress. */
  async assertCanDraft(reviewId, by) {
    if (by !== "user") throw new Error("Only the user writes draft comments");
    await this.assertActiveReview(reviewId);
  }
  async assertActiveReview(reviewId) {
    const { reviews } = await this.loadReviews();
    const review = reviews.get(reviewId);
    if (!review) throw new Error(`Review not found: ${reviewId}`);
    if (review.state !== "active") throw new Error(`Review ${reviewId} is already ${review.state}`);
  }
  async readJournal(file, label, reviews) {
    const text = await (0, import_promises.readFile)(file, "utf8");
    const parsed = parseJournal(text, label);
    const state = foldThread(parsed.events, { futureVersion: parsed.futureVersion, reviews });
    const warnings = [...parsed.warnings];
    if (!state) warnings.push(`${label}: no thread.created event, file skipped`);
    return { state, warnings };
  }
  async createThread(anchor, first, branch = null) {
    const body = first.body.trim();
    if (body === "") throw new Error("Comment body is empty");
    if (first.reviewId !== null) await this.assertCanDraft(first.reviewId, first.author);
    await this.ensureInitialized();
    const who = actor(first.author, first.agent);
    const threadId = newThreadId();
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const events = [
      { v: FIRST_VERSION, type: "thread.created", at, ...who, threadId, anchor, ...branch ? { branch } : {} },
      {
        v: FIRST_VERSION,
        type: "comment.added",
        at,
        ...who,
        commentId: newCommentId(),
        body,
        reviewId: first.reviewId
      }
    ];
    await (0, import_promises.appendFile)(this.threadFile(threadId), serializeEvents(events), { flag: "a" });
    const { reviews } = await this.loadReviews();
    const state = foldThread(events, { reviews });
    if (!state) throw new Error("unreachable: freshly created thread failed to fold");
    return state;
  }
  /**
   * Creates the store's folders and schema version, if missing, and migrates an older store: the
   * journals of version 1 are valid in version 2 as they are (version 2 only adds the archive
   * events), so migrating only records the new version. A newer version is never lowered.
   */
  async ensureInitialized() {
    await (0, import_promises.mkdir)(this.threadsDir, { recursive: true });
    await (0, import_promises.mkdir)(this.reviewsDir, { recursive: true });
    const file = (0, import_node_path.join)(this.dir, "schema-version");
    try {
      await (0, import_promises.writeFile)(file, `${SCHEMA_VERSION}
`, { flag: "wx" });
      return;
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
    const version = await this.schemaVersion();
    if (version !== null && version >= SCHEMA_VERSION) return;
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await (0, import_promises.writeFile)(tmp, `${SCHEMA_VERSION}
`);
    await (0, import_promises.rename)(tmp, file);
  }
  /** The format version recorded by the store; `null` when there is none (or it is unreadable). */
  async schemaVersion() {
    const text = await (0, import_promises.readFile)((0, import_node_path.join)(this.dir, "schema-version"), "utf8").catch(() => "");
    const n = Number.parseInt(text.trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
};
var THREAD_ID = /^t_[0-9A-HJKMNP-TV-Z]{26}$/;
var REVIEW_ID = /^r_[0-9A-HJKMNP-TV-Z]{26}$/;
async function listJournals(dir) {
  try {
    return (await (0, import_promises.readdir)(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}
function latestActive(reviews, scope) {
  const key = reviewScopeKey(scope);
  const active = [...reviews.values()].filter((r) => r.state === "active" && reviewScopeKey(r) === key);
  active.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  return active[0] ?? null;
}
function actor(by, agent) {
  if (by === "user") return { by };
  const name = agent?.trim();
  if (!name) throw new Error("An agent must give its name");
  return { by, agent: name };
}
function assertOwnComment(thread, commentId, by) {
  const comment = thread.comments.find((c) => c.id === commentId);
  if (!comment) throw new Error(`Comment not found: ${commentId}`);
  if (comment.author !== by) throw new Error("You can only change your own comments");
}
function assertCanSetStatus(status, by) {
  if (status === "resolved" && by !== "user") throw new Error("Only the user can resolve a thread");
}
function isNotFound(err) {
  return err?.code === "ENOENT";
}
function isAlreadyExists(err) {
  return err?.code === "EEXIST";
}

// ../../packages/core/src/agentView.ts
var import_node_fs = require("node:fs");
var import_node_path4 = require("node:path");

// ../../packages/core/src/sessions.ts
var import_promises3 = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path3 = require("node:path");

// ../../packages/core/src/topics.ts
var import_node_child_process = require("node:child_process");
var import_promises2 = require("node:fs/promises");
var import_node_path2 = require("node:path");
var topicKey = (t) => t.kind === "branch" ? `branch:${t.repo}#${t.branch}` : `path:${t.path}`;
function topicLabel(t) {
  if (t.kind === "path") return t.path;
  const repoName = (0, import_node_path2.basename)(t.repo) === ".git" ? (0, import_node_path2.basename)((0, import_node_path2.dirname)(t.repo)) : (0, import_node_path2.basename)(t.repo).replace(/\.git$/, "");
  return `${repoName} \xB7 ${t.branch}`;
}
function git(args, cwd, raw = false) {
  return new Promise(
    (done) => (0, import_node_child_process.execFile)(
      "git",
      args,
      { cwd, timeout: 3e3, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => done(err ? null : raw ? stdout : stdout.trim())
    )
  );
}
async function existingDir(path) {
  let dir = path;
  for (; ; ) {
    const s = await (0, import_promises2.stat)(dir).catch(() => null);
    if (s) return s.isDirectory() ? dir : (0, import_node_path2.dirname)(dir);
    const parent = (0, import_node_path2.dirname)(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}
async function currentBranch(dir) {
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], dir);
  if (branch) return branch;
  for (const state of ["rebase-merge/head-name", "rebase-apply/head-name"]) {
    const file = await git(["rev-parse", "--path-format=absolute", "--git-path", state], dir);
    const head = file ? (await (0, import_promises2.readFile)(file, "utf8").catch(() => "")).trim() : "";
    if (head.startsWith("refs/heads/")) return head.slice("refs/heads/".length);
  }
  return null;
}
async function gitWorktreeOf(path) {
  const dir = await existingDir(path);
  const out = await git(["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], dir);
  if (!out) return null;
  const [commonDir, worktree] = out.split("\n");
  if (!commonDir || !worktree) return null;
  const branch = await currentBranch(dir);
  if (!branch) return null;
  return { repo: await (0, import_promises2.realpath)(commonDir).catch(() => commonDir), branch, worktree };
}
async function topicOf(path, opts = {}) {
  if (!opts.asPath) {
    const dir = await existingDir(path);
    const wt = await gitWorktreeOf(dir);
    const ignored = wt && await git(["check-ignore", "-q", path], dir) !== null;
    if (wt && !ignored) return { kind: "branch", ...wt };
  }
  return { kind: "path", path };
}
async function filesChangedSince(dir, sinceMs) {
  const top = await git(["rev-parse", "--show-toplevel"], dir);
  const status = top ? await git(["status", "--porcelain", "-z"], dir, true) : null;
  if (!top || !status) return [];
  const entries = status.split("\0");
  const paths = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    if (entry[0] === "R" || entry[0] === "C") i++;
    if (entry[1] !== "D" && entry[0] !== "D") paths.push((0, import_node_path2.join)(top, entry.slice(3)));
  }
  const recent = await Promise.all(
    paths.map(async (p) => ((await (0, import_promises2.stat)(p).catch(() => null))?.mtimeMs ?? 0) >= sinceMs - 1e3)
  );
  return paths.filter((_, i) => recent[i]);
}

// ../../packages/core/src/sessions.ts
var CURSOR_HEAD_BYTES = 256;
var CALL_NOTE = "call-";
var CALL_MAX_AGE_MS = 15 * 6e4;
var LOOSE_ROOT = "/";
function looseStore(env = process.env) {
  return new Store(LOOSE_ROOT, (0, import_node_path3.join)(localReviewHome(env), "files"));
}
function storeAt(root, env = process.env) {
  return root === LOOSE_ROOT ? looseStore(env) : new Store(root);
}
function localReviewHome(env = process.env) {
  return env.LOCAL_REVIEW_HOME?.trim() || (0, import_node_path3.join)((0, import_node_os.homedir)(), ".local-review");
}
var SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
var SessionRegistry = class {
  constructor(home = localReviewHome(), isAlive = isProcessAlive) {
    this.isAlive = isAlive;
    this.dir = (0, import_node_path3.join)(home, "sessions");
  }
  isAlive;
  dir;
  file(id, kind) {
    if (!SESSION_ID.test(id)) throw new Error(`Invalid session id: ${id}`);
    return (0, import_node_path3.join)(this.dir, kind === "json" ? `${id}.json` : `${id}.${kind}.jsonl`);
  }
  /** Registers (or refreshes) a session. Written atomically: readers never see half a file. */
  async register(record) {
    await (0, import_promises3.mkdir)(this.dir, { recursive: true });
    const target = this.file(record.id, "json");
    const tmp = `${target}.${process.pid}.tmp`;
    await (0, import_promises3.writeFile)(tmp, JSON.stringify(record, null, 2) + "\n");
    await (0, import_promises3.rename)(tmp, target);
  }
  /** Everything the registry keeps about a session goes with it. */
  async unregister(id) {
    this.file(id, "json");
    let names = [];
    try {
      names = await (0, import_promises3.readdir)(this.dir);
    } catch {
      return;
    }
    await Promise.all(names.filter((n) => n.startsWith(`${id}.`)).map((n) => (0, import_promises3.rm)((0, import_node_path3.join)(this.dir, n), { force: true })));
  }
  /** A small note an adapter keeps about a session between two hooks (removed with the session). */
  async setNote(id, key, value) {
    await (0, import_promises3.mkdir)(this.dir, { recursive: true });
    await (0, import_promises3.writeFile)(this.note(id, key), value);
  }
  /** Reads and removes a note; `undefined` when there is none. */
  async takeNote(id, key) {
    const file = this.note(id, key);
    try {
      const value = await (0, import_promises3.readFile)(file, "utf8");
      await (0, import_promises3.rm)(file, { force: true });
      return value;
    } catch {
      return void 0;
    }
  }
  /**
   * Notes a command an agent starts (e.g. `lr reply …`), written by its adapter before it runs: `lr`
   * then knows which message of the agent's conversation runs it. Removed by `endCall`, or with the
   * session.
   */
  async startCall(id, call) {
    await this.setNote(id, `${CALL_NOTE}${call.message}`, JSON.stringify(call));
  }
  async endCall(id, message) {
    await this.takeNote(id, `${CALL_NOTE}${message}`);
  }
  /** The commands of a session that are running (as noted by its adapter). */
  async calls(id) {
    this.file(id, "json");
    let names;
    try {
      names = await (0, import_promises3.readdir)(this.dir);
    } catch {
      return [];
    }
    const prefix = `${id}.note-${CALL_NOTE}`;
    const calls = await Promise.all(
      names.filter((n) => n.startsWith(prefix)).map(async (n) => {
        try {
          const raw = JSON.parse(await (0, import_promises3.readFile)((0, import_node_path3.join)(this.dir, n), "utf8"));
          return typeof raw.message === "string" && typeof raw.command === "string" && typeof raw.at === "string" ? { message: raw.message, command: raw.command, at: raw.at } : null;
        } catch {
          return null;
        }
      })
    );
    return calls.filter((c) => c !== null);
  }
  note(id, key) {
    if (!SESSION_ID.test(key)) throw new Error(`Invalid note key: ${key}`);
    this.file(id, "json");
    return (0, import_node_path3.join)(this.dir, `${id}.note-${key}`);
  }
  /**
   * Subscribes a session to a topic. Resolves to `true` when it was not subscribed yet (e.g. to tell
   * the agent). Appended, so concurrent hooks never lose an entry.
   */
  async subscribe(id, topic, reason) {
    const already = (await this.subscriptions(id)).some((s) => topicKey(s.topic) === topicKey(topic));
    if (already) return false;
    await this.appendSubscription(id, { op: "add", topic, reason, at: (/* @__PURE__ */ new Date()).toISOString() });
    return true;
  }
  /** Unsubscribes a session from a topic, or from everything. Resolves to what it was subscribed to. */
  async unsubscribe(id, topic) {
    const current = await this.subscriptions(id);
    const gone = topic === "all" ? current : current.filter((s) => topicKey(s.topic) === topicKey(topic));
    for (const s of gone)
      await this.appendSubscription(id, { op: "remove", topic: s.topic, at: (/* @__PURE__ */ new Date()).toISOString() });
    return gone;
  }
  /** What a session is subscribed to, oldest first. */
  async subscriptions(id) {
    let text;
    try {
      text = await (0, import_promises3.readFile)(this.file(id, "subscriptions"), "utf8");
    } catch {
      return [];
    }
    const current = /* @__PURE__ */ new Map();
    for (const line of text.split("\n")) {
      try {
        const e = JSON.parse(line);
        if (!e.topic || e.topic.kind !== "branch" && e.topic.kind !== "path") continue;
        const key = topicKey(e.topic);
        if (e.op === "remove") current.delete(key);
        else if (e.op === "add" && !current.has(key))
          current.set(key, { topic: e.topic, reason: e.reason ?? "user", at: e.at ?? "" });
      } catch {
      }
    }
    return [...current.values()];
  }
  async appendSubscription(id, event) {
    await (0, import_promises3.mkdir)(this.dir, { recursive: true });
    await (0, import_promises3.appendFile)(this.file(id, "subscriptions"), JSON.stringify(event) + "\n");
  }
  /** Hands threads to a session. Appended to its inbox, which its agent's adapter watches. */
  async deliver(id, delivery) {
    await (0, import_promises3.mkdir)(this.dir, { recursive: true });
    await (0, import_promises3.appendFile)(this.file(id, "inbox"), JSON.stringify(delivery) + "\n");
  }
  /**
   * Deliveries appended to a session's inbox since `cursor` (none: from the start), and the cursor
   * to read from next time. A line still being written is left for next time.
   */
  async readInbox(id, cursor) {
    let handle;
    try {
      handle = await (0, import_promises3.open)(this.file(id, "inbox"), "r");
    } catch (err) {
      if (err.code === "ENOENT")
        return { deliveries: [], cursor: { file: 0, head: "", offset: 0 } };
      throw err;
    }
    try {
      const { ino, size } = await handle.stat();
      const start = Buffer.alloc(Math.min(size, CURSOR_HEAD_BYTES));
      await handle.read(start, 0, start.length, 0);
      const newline = start.indexOf(10);
      const head = start.subarray(0, newline < 0 ? start.length : newline).toString("utf8");
      const same = cursor && cursor.file === ino && cursor.head === head && cursor.offset <= size;
      const from = same ? cursor.offset : 0;
      const buffer = Buffer.alloc(size - from);
      await handle.read(buffer, 0, buffer.length, from);
      const end = buffer.lastIndexOf(10) + 1;
      const deliveries = [];
      for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
        const delivery = parseDelivery(line);
        if (delivery) deliveries.push(delivery);
      }
      return { deliveries, cursor: { file: ino, head, offset: from + end } };
    } finally {
      await handle.close();
    }
  }
  /** Running sessions. Sessions whose process is gone (e.g. after a crash) are removed on the way. */
  async list() {
    let names;
    try {
      names = (await (0, import_promises3.readdir)(this.dir)).filter((n) => n.endsWith(".json"));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    const sessions = [];
    for (const name of names.sort()) {
      const record = await readRecord((0, import_node_path3.join)(this.dir, name));
      if (!record || !SESSION_ID.test(record.id)) continue;
      if (record.pid !== null && !this.isAlive(record.pid)) {
        await this.unregister(record.id).catch(() => void 0);
        continue;
      }
      sessions.push({ ...record, subscriptions: await this.subscriptions(record.id) });
    }
    return sessions;
  }
};
async function readRecord(file) {
  try {
    const raw = JSON.parse(await (0, import_promises3.readFile)(file, "utf8"));
    if (typeof raw.id !== "string" || typeof raw.agent !== "string" || typeof raw.cwd !== "string") return null;
    return {
      id: raw.id,
      agent: raw.agent,
      cwd: raw.cwd,
      branch: typeof raw.branch === "string" ? raw.branch : null,
      pid: typeof raw.pid === "number" ? raw.pid : null,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
      push: typeof raw.push === "boolean" ? raw.push : null,
      pushCommand: typeof raw.pushCommand === "string" ? raw.pushCommand : null
    };
  } catch {
    return null;
  }
}
function parseDelivery(line) {
  if (line.trim() === "") return null;
  try {
    const raw = JSON.parse(line);
    if (typeof raw.id !== "string" || typeof raw.root !== "string" || !Array.isArray(raw.threadIds)) return null;
    const kinds = ["comment", "reply", "review", "edit", "delete"];
    const kind = kinds.includes(raw.kind) ? raw.kind : "comment";
    return {
      id: raw.id,
      at: typeof raw.at === "string" ? raw.at : "",
      root: raw.root,
      kind,
      threadIds: raw.threadIds.filter((t) => typeof t === "string"),
      ...typeof raw.reviewId === "string" ? { reviewId: raw.reviewId } : {},
      ...Array.isArray(raw.recipients) ? { recipients: raw.recipients.filter((r) => typeof r === "string") } : {}
    };
  } catch {
    return null;
  }
}

// ../../packages/core/src/agentView.ts
function isStoreRoot(dir, env = process.env) {
  const store = (0, import_node_path4.join)(dir, STORE_DIR);
  if (!(0, import_node_fs.existsSync)((0, import_node_path4.join)(store, "schema-version")) && !(0, import_node_fs.existsSync)((0, import_node_path4.join)(store, "threads"))) return false;
  return realpath2(store) !== realpath2(localReviewHome(env));
}
function findStoreRoot(fromDir, env = process.env) {
  let dir = (0, import_node_path4.resolve)(fromDir);
  for (; ; ) {
    if (isStoreRoot(dir, env)) return dir;
    const parent = (0, import_node_path4.dirname)(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function realpath2(path) {
  try {
    return (0, import_node_fs.realpathSync)(path);
  } catch {
    return (0, import_node_path4.resolve)(path);
  }
}

// ../../packages/core/src/project.ts
var import_node_child_process2 = require("node:child_process");
var import_promises5 = require("node:fs/promises");
var import_node_path6 = require("node:path");

// ../../packages/core/src/saved.ts
var import_promises4 = require("node:fs/promises");
var import_node_path5 = require("node:path");
var SAVED_DIR = "saved";
async function savedStores(storeDir) {
  let slots;
  try {
    slots = (await (0, import_promises4.readdir)((0, import_node_path5.join)(storeDir, SAVED_DIR), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
  const found = [];
  for (const slot of slots) {
    const dir = (0, import_node_path5.join)(storeDir, SAVED_DIR, slot);
    const origin = parseOrigin(await (0, import_promises4.readFile)((0, import_node_path5.join)(dir, "origin.json"), "utf8").catch(() => ""));
    if (origin) found.push({ ...origin, dir });
  }
  return found;
}
function parseOrigin(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw;
  const str = (k) => typeof o[k] === "string" ? o[k] : null;
  const [worktree, root, repo, savedAt] = [str("worktree"), str("root"), str("repo"), str("savedAt")];
  if (!worktree || !root || !repo || !savedAt) return null;
  return { worktree, root, repo, branch: str("branch"), firstSavedAt: str("firstSavedAt") ?? savedAt, savedAt };
}

// ../../packages/core/src/project.ts
var SKIPPED = /* @__PURE__ */ new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "target",
  "vendor",
  "coverage",
  "__pycache__",
  "venv",
  "Library",
  "Applications"
]);
async function projectStores(root, env = process.env) {
  if (root === LOOSE_ROOT) return [{ root, origin: "root" }];
  const top = (0, import_node_path6.resolve)(root);
  const found = [];
  const seen = /* @__PURE__ */ new Set();
  const add = async (dir, origin) => {
    const key = await (0, import_promises5.realpath)((0, import_node_path6.join)(dir, STORE_DIR)).catch(() => (0, import_node_path6.join)(dir, STORE_DIR));
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ root: dir, origin });
  };
  const repos = [];
  const below = [];
  await walk(top, env, below, repos);
  for (const dir of below) await add(dir, dir === top ? "root" : "below");
  if (!below.includes(top)) {
    const above = findStoreRoot(top, env);
    if (above) {
      await add(above, "above");
      repos.push(above);
    }
  }
  const realTop = await (0, import_promises5.realpath)(top).catch(() => top);
  const worktrees = /* @__PURE__ */ new Set();
  for (const list of await Promise.all(repos.map(worktreesOf)))
    for (const wt of list) if (!walked(realTop, wt)) worktrees.add(wt);
  for (const wt of [...worktrees].sort()) {
    const stores = [];
    await walk(wt, env, stores, []);
    for (const dir of stores) await add(dir, "worktree");
  }
  for (const s of [...found]) {
    for (const saved of await savedStores((0, import_node_path6.join)(s.root, STORE_DIR))) {
      const key = await (0, import_promises5.realpath)(saved.dir).catch(() => saved.dir);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ root: saved.root, origin: "saved", saved });
    }
  }
  const order = { root: 0, below: 1, above: 2, worktree: 3, saved: 4 };
  return found.sort((a, b) => order[a.origin] - order[b.origin] || a.root.localeCompare(b.root));
}
function walked(top, dir) {
  const rel = (0, import_node_path6.relative)(top, dir);
  if (rel === "") return true;
  if (rel.startsWith("..") || (0, import_node_path6.isAbsolute)(rel)) return false;
  return rel.split(import_node_path6.sep).every((part) => !part.startsWith(".") && !SKIPPED.has(part));
}
async function storesUnder(dir, env = process.env) {
  const stores = [];
  await walk((0, import_node_path6.resolve)(dir), env, stores, []);
  return stores.sort();
}
async function walk(dir, env, stores, repos) {
  let entries;
  try {
    entries = await (0, import_promises5.readdir)(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.name === ".git")) repos.push(dir);
  if (entries.some((e) => e.name === STORE_DIR && e.isDirectory()) && isStoreRoot(dir, env)) stores.push(dir);
  const children = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIPPED.has(e.name));
  await Promise.all(children.map((e) => walk((0, import_node_path6.join)(dir, e.name), env, stores, repos)));
}
function worktreesOf(dir) {
  return new Promise(
    (done) => (0, import_node_child_process2.execFile)("git", ["worktree", "list", "--porcelain"], { cwd: dir, timeout: 3e3 }, (err, stdout) => {
      if (err) return done([]);
      const paths = stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
      void Promise.all(paths.map((p) => (0, import_promises5.realpath)(p).catch(() => null))).then(
        (real2) => done(real2.filter((p) => p !== null))
      );
    })
  );
}
async function projectHistory(root, opts = {}) {
  const env = opts.env ?? process.env;
  const sinceMs = opts.since ? opts.since.getTime() : null;
  const loaded = await Promise.all(
    (await projectStores(root, env)).map(async (s) => ({
      s,
      ...await (s.saved ? new Store(s.root, s.saved.dir) : storeAt(s.root, env)).loadHistory()
    }))
  );
  const best = /* @__PURE__ */ new Map();
  for (const { threads } of loaded)
    for (const t of threads) if (t.bytes > (best.get(t.id)?.bytes ?? -1)) best.set(t.id, t);
  const stores = loaded.filter(({ s, threads }) => !s.saved || threads.some((t) => best.get(t.id) === t)).map(({ s, threads, warnings }) => {
    const kept = threads.filter((t) => best.get(t.id) === t && activeSince(t, sinceMs)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return {
      ...s,
      threads: kept,
      bytes: kept.reduce((n, t) => n + t.bytes, 0),
      states: countStates(kept),
      deletions: countDeletions(kept),
      archived: countArchived(kept),
      warnings
    };
  });
  const all = stores.flatMap((s) => s.threads);
  return {
    root: root === LOOSE_ROOT ? root : (0, import_node_path6.resolve)(root),
    since: opts.since ? opts.since.toISOString() : null,
    stores,
    threads: all.length,
    bytes: stores.reduce((n, s) => n + s.bytes, 0),
    states: countStates(all),
    deletions: countDeletions(all),
    archived: countArchived(all)
  };
}

// ../../packages/core/src/retro.ts
var import_promises6 = require("node:fs/promises");
var import_node_path7 = require("node:path");
var RETRO_SCHEMA_VERSION = 1;
var RETROS_DIR = "retros";
var RETRO_EVENTS = /* @__PURE__ */ new Set([
  "retro.started",
  "retro.feedback",
  "retro.classified",
  "retro.proposed",
  "retro.decided",
  "retro.applied",
  "retro.conversation",
  "retro.finished"
]);
var RETRO_ID = /^rt_[0-9A-HJKMNP-TV-Z]{26}$/;
function parseLines(text, source, types) {
  const events = [];
  const warnings = [];
  let future = false;
  const end = text.lastIndexOf("\n");
  const lines = end === -1 ? [] : text.slice(0, end).split("\n");
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      warnings.push(`${source}:${i + 1}: invalid JSON, line skipped`);
      return;
    }
    const e = raw;
    if (typeof raw !== "object" || raw === null || typeof e.v !== "number" || typeof e.type !== "string") {
      warnings.push(`${source}:${i + 1}: not an event, line skipped`);
      return;
    }
    if (e.v > RETRO_SCHEMA_VERSION) {
      future = true;
      return;
    }
    if (!types.has(e.type)) {
      warnings.push(`${source}:${i + 1}: unknown event type "${e.type}", line skipped`);
      return;
    }
    events.push(raw);
  });
  return { events, warnings, future };
}
function foldRetro(events, warnings = [], future = false) {
  const first = events[0];
  if (!first || first.type !== "retro.started") return null;
  const r = {
    id: first.retroId,
    root: first.root,
    since: first.since,
    until: first.until,
    startedAt: first.at,
    stores: first.stores,
    threads: first.threads,
    bytes: first.bytes,
    preferences: first.preferences ?? [],
    feedback: [],
    classification: null,
    proposals: [],
    watch: [],
    dropped: [],
    verifications: [],
    decisions: {},
    applied: {},
    conversations: {},
    finishedAt: null,
    readOnly: future,
    warnings
  };
  for (const e of events.slice(1)) {
    switch (e.type) {
      case "retro.feedback":
        r.feedback.push(e.body);
        break;
      case "retro.classified": {
        const c = r.classification ??= { by: [], labels: {} };
        if (!c.by.includes(e.by)) c.by.push(e.by);
        Object.assign(c.labels, e.labels);
        break;
      }
      case "retro.proposed":
        r.proposals = e.proposals;
        r.watch = e.watch;
        r.dropped = e.dropped;
        r.verifications = e.verifications ?? [];
        r.decisions = {};
        r.applied = {};
        break;
      case "retro.decided":
        r.decisions[e.proposal] = {
          decision: e.decision,
          at: e.at,
          ...e.target ? { target: e.target } : {},
          ...e.note ? { note: e.note } : {}
        };
        break;
      case "retro.applied":
        r.applied[e.proposal] = [.../* @__PURE__ */ new Set([...r.applied[e.proposal] ?? [], ...e.files])];
        break;
      case "retro.conversation":
        if (!r.conversations[e.thread]?.available)
          r.conversations[e.thread] = { sessions: e.sessions, available: e.available, at: e.at };
        break;
      case "retro.finished":
        r.finishedAt ??= e.at;
        break;
      case "retro.started":
        break;
    }
  }
  return r;
}
async function readRetros(dir) {
  let files;
  try {
    files = (await (0, import_promises6.readdir)(dir)).filter((f) => f.endsWith(".jsonl") && RETRO_ID.test(f.slice(0, -".jsonl".length)));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const retros = await Promise.all(files.map((f) => readRetro(dir, f.slice(0, -".jsonl".length))));
  return retros.filter((r) => r !== null).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}
async function readRetro(dir, id) {
  if (!RETRO_ID.test(id)) throw new Error(`Invalid retro id: ${id}`);
  let text;
  try {
    text = await (0, import_promises6.readFile)((0, import_node_path7.join)(dir, `${id}.jsonl`), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const parsed = parseLines(text, `retros/${id}.jsonl`, RETRO_EVENTS);
  return foldRetro(parsed.events, parsed.warnings, parsed.future);
}

// ../../packages/core/src/retroGuards.ts
var STOPWORDS = new Set(
  "the and for with that this from into when then than are was were has have not use uses using les des une pour avec dans sur par pas que qui est sont aux ses son leur".split(" ")
);

// ../../packages/core/src/config.ts
var import_promises7 = require("node:fs/promises");
var import_node_path8 = require("node:path");
var DEFAULT_CONFIG = {
  autoSaveWorktrees: true,
  retroReminder: true,
  retroReminderDays: 7,
  retroReminderSizeKB: 1e3,
  retroReminderMaxDays: 25
};
var CONFIG_KEYS = {
  "auto-save-worktrees": {
    key: "autoSaveWorktrees",
    kind: "boolean",
    help: "on|off \u2014 before an agent removes a git worktree, its hook saves the worktree's threads (default: on)"
  },
  "retro-reminder": {
    key: "retroReminder",
    kind: "boolean",
    help: "on|off \u2014 when a retro is due, the agent says so at the start of a session (default: on)"
  },
  "retro-reminder-days": {
    key: "retroReminderDays",
    kind: "number",
    help: "days \u2014 a retro is due this many days after the last one (default: 7)"
  },
  "retro-reminder-size": {
    key: "retroReminderSizeKB",
    kind: "number",
    help: "KB \u2014 or sooner, once the threads since the last one weigh this much (default: 1000, i.e. 1 MB)"
  },
  "retro-reminder-max-days": {
    key: "retroReminderMaxDays",
    kind: "number",
    help: "days \u2014 and never later than this, to keep the agent conversations linked to replies (default: 25)"
  }
};
var configFile = (env = process.env) => (0, import_node_path8.join)(localReviewHome(env), "config.json");
var validSettingNumber = (x) => typeof x === "number" && Number.isInteger(x) && x >= 1;
async function readConfig(env = process.env) {
  const config = { ...DEFAULT_CONFIG };
  let raw;
  try {
    raw = JSON.parse(await (0, import_promises7.readFile)(configFile(env), "utf8"));
  } catch {
    return config;
  }
  if (typeof raw !== "object" || raw === null) return config;
  const values = raw;
  for (const setting of Object.values(CONFIG_KEYS)) {
    const value = values[setting.key];
    if (setting.kind === "boolean" && typeof value === "boolean") config[setting.key] = value;
    if (setting.kind === "number" && validSettingNumber(value)) config[setting.key] = value;
  }
  return config;
}

// ../../packages/core/src/worktrees.ts
var import_node_child_process4 = require("node:child_process");
var import_node_crypto2 = require("node:crypto");
var import_promises9 = require("node:fs/promises");
var import_node_os2 = require("node:os");
var import_node_path10 = require("node:path");

// ../../packages/core/src/storeHome.ts
var import_node_child_process3 = require("node:child_process");
var import_promises8 = require("node:fs/promises");
var import_node_path9 = require("node:path");
async function prepareStoreHome(home) {
  const store = (0, import_node_path9.join)(home, STORE_DIR);
  if (await (0, import_promises8.stat)(store).catch(() => null)) return;
  const exclude = await new Promise(
    (done) => (0, import_node_child_process3.execFile)(
      "git",
      ["rev-parse", "--git-path", "info/exclude"],
      { cwd: home, timeout: 3e3 },
      (err, out) => done(err ? null : out.trim())
    )
  );
  if (exclude) {
    const file = (0, import_node_path9.isAbsolute)(exclude) ? exclude : (0, import_node_path9.join)(home, exclude);
    const current = await (0, import_promises8.readFile)(file, "utf8").catch(() => "");
    const accepted = [`${STORE_DIR}/`, STORE_DIR, `/${STORE_DIR}/`, `/${STORE_DIR}`];
    if (!current.split("\n").some((l) => accepted.includes(l.trim()))) {
      await (0, import_promises8.mkdir)((0, import_node_path9.join)(file, ".."), { recursive: true });
      await (0, import_promises8.appendFile)(file, `${current === "" || current.endsWith("\n") ? "" : "\n"}${STORE_DIR}/
`);
    }
  }
  await (0, import_promises8.mkdir)(store, { recursive: true });
}

// ../../packages/core/src/worktrees.ts
function git2(args, cwd) {
  return new Promise(
    (done) => (0, import_node_child_process4.execFile)("git", args, { cwd, timeout: 3e3 }, (err, stdout) => done(err ? null : stdout.trim()))
  );
}
var real = (p) => (0, import_promises9.realpath)(p).catch(() => (0, import_node_path10.resolve)(p));
async function worktreeInfo(dir) {
  const out = await git2(
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"],
    dir
  );
  const [gitDir, commonDir, top] = out?.split("\n") ?? [];
  if (!gitDir || !commonDir || !top) return null;
  const [realGit, repo, worktree] = await Promise.all([real(gitDir), real(commonDir), real(top)]);
  const list = await git2(["worktree", "list", "--porcelain"], dir) ?? "";
  const first = list.split("\n\n")[0]?.split("\n") ?? [];
  const mainPath = first.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
  const main2 = mainPath && !first.includes("bare") ? await real(mainPath) : null;
  const branch = await git2(["symbolic-ref", "--quiet", "--short", "HEAD"], dir) || null;
  return { worktree, repo, linked: realGit !== repo, main: main2, branch };
}
async function worktreesOf2(dir) {
  const out = await git2(["worktree", "list", "--porcelain"], dir) ?? "";
  const paths = out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
  return Promise.all(paths.map(real));
}
var expandHome = (p, env = process.env) => p === "~" ? env.HOME || (0, import_node_os2.homedir)() : p.startsWith("~/") ? (0, import_node_path10.join)(env.HOME || (0, import_node_os2.homedir)(), p.slice(2)) : p;
async function resolveWorktree(cwd, spec) {
  const path = (0, import_node_path10.resolve)(cwd, expandHome(spec));
  if (await (0, import_promises9.stat)(path).catch(() => null)) return real(path);
  const tail = import_node_path10.sep + spec.replace(/[/\\]+$/, "").replace(/\//g, import_node_path10.sep);
  const matches = (await worktreesOf2(cwd)).filter((wt) => wt.endsWith(tail));
  return matches.length === 1 ? matches[0] : null;
}
function slotOf(storeRoot) {
  const name = (0, import_node_path10.basename)(storeRoot).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "worktree";
  return `${name}-${(0, import_node_crypto2.createHash)("sha256").update(storeRoot).digest("hex").slice(0, 8)}`;
}
async function saveWorktreeThreads(dir, env = process.env) {
  const info = await worktreeInfo(dir);
  if (!info) throw new Error(`${dir} is not in a git repository`);
  if (!info.linked)
    throw new Error(
      `${info.worktree} is the main worktree of its repository, not a linked one: git worktree remove never deletes it, so its comments are safe`
    );
  if (!info.main) throw new Error(`the repository of ${info.worktree} has no main worktree (bare): nowhere to save`);
  const result = {
    worktree: info.worktree,
    branch: info.branch,
    main: info.main,
    copies: [],
    threads: 0,
    published: 0
  };
  const stores = await storesUnder(info.worktree, env);
  if (stores.length === 0) return result;
  await prepareStoreHome(info.main);
  const mainStore = new Store(info.main);
  await mainStore.ensureInitialized();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const root of stores) {
    const from = await real(root);
    const target = (0, import_node_path10.join)(mainStore.dir, SAVED_DIR, slotOf(from));
    let threads = 0;
    for (const kind of ["threads", "reviews"]) {
      const files = await (0, import_promises9.readdir)((0, import_node_path10.join)(from, STORE_DIR, kind)).catch(() => []);
      const journals = files.filter((f) => kind === "threads" ? Store.threadIdOf(f) !== null : f.endsWith(".jsonl"));
      if (journals.length === 0) continue;
      await (0, import_promises9.mkdir)((0, import_node_path10.join)(target, kind), { recursive: true });
      for (const f of journals) await (0, import_promises9.copyFile)((0, import_node_path10.join)(from, STORE_DIR, kind, f), (0, import_node_path10.join)(target, kind, f));
      if (kind === "threads") threads = journals.length;
    }
    if (threads === 0) continue;
    const previous = parseOrigin(await (0, import_promises9.readFile)((0, import_node_path10.join)(target, "origin.json"), "utf8").catch(() => ""));
    const origin = {
      v: 1,
      worktree: info.worktree,
      root: from,
      repo: info.repo,
      branch: info.branch,
      firstSavedAt: previous?.firstSavedAt ?? now,
      savedAt: now
    };
    const tmp = (0, import_node_path10.join)(target, `origin.json.${process.pid}.tmp`);
    await (0, import_promises9.writeFile)(tmp, JSON.stringify(origin, null, 2) + "\n");
    await (0, import_promises9.rename)(tmp, (0, import_node_path10.join)(target, "origin.json"));
    const published = (await new Store(from, target).loadHistory()).threads.length;
    result.copies.push({ from, dir: target, threads, published });
    result.threads += threads;
    result.published += published;
  }
  return result;
}
async function worktreeThreadCount(dir, env = process.env) {
  let n = 0;
  for (const root of await storesUnder(dir, env)) n += (await new Store(root).loadHistory()).threads.length;
  return n;
}

// ../../packages/core/src/cadence.ts
var import_promises10 = require("node:fs/promises");
var import_node_path11 = require("node:path");
var DEFAULT_CADENCE = thresholdsOf(DEFAULT_CONFIG);
function thresholdsOf(c) {
  return { days: c.retroReminderDays, bytes: c.retroReminderSizeKB * 1e3, maxDays: c.retroReminderMaxDays };
}
var DAY = 864e5;
async function retroCadence(root, opts = {}) {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const dir = (0, import_node_path11.resolve)(root);
  if (dir === LOOSE_ROOT || (0, import_node_path11.dirname)(dir) === dir) return null;
  const thresholds = opts.thresholds ?? thresholdsOf(await readConfig(env));
  const last = await lastRetroCovering(dir);
  let since = last ? Date.parse(last.until) : null;
  const history = await projectHistory(dir, { since: since === null ? null : new Date(since + 1), env });
  const threads = history.stores.flatMap((s) => s.threads);
  if (since === null && threads.length > 0)
    since = threads.reduce((first, t) => Math.min(first, Date.parse(t.createdAt)), Infinity);
  const days = since === null ? 0 : Math.max(0, Math.floor((now - since) / DAY));
  const reasons = [];
  if (threads.length > 0) {
    if (days >= Math.min(thresholds.days, thresholds.maxDays)) reasons.push("days");
    if (history.bytes >= thresholds.bytes) reasons.push("size");
    if (days >= thresholds.maxDays) reasons.push("max-days");
  }
  return {
    root: dir,
    lastRetro: last ? { id: last.id, root: last.root, until: last.until } : null,
    since: since === null ? null : new Date(since).toISOString(),
    days,
    threads: threads.length,
    bytes: history.bytes,
    thresholds,
    due: reasons.length > 0,
    reasons
  };
}
async function lastRetroCovering(dir) {
  const target = (0, import_node_path11.resolve)(dir);
  const real2 = await (0, import_promises10.realpath)(target).catch(() => target);
  let best = await lastRetroAbove([target, real2]);
  const info = await worktreeInfo(real2);
  if (info) {
    const rel = (0, import_node_path11.relative)(info.worktree, real2);
    if (!rel.startsWith("..") && !(0, import_node_path11.isAbsolute)(rel)) {
      for (const wt of await worktreesOf2(real2)) {
        if (wt === info.worktree) continue;
        const r = await lastRetroAbove([(0, import_node_path11.join)(wt, rel)]);
        if (r && (!best || r.until > best.until)) best = r;
      }
    }
  }
  return best;
}
async function lastRetroAbove(dirs) {
  const covers = (r) => dirs.some((d) => d === r || d.startsWith(r.endsWith(import_node_path11.sep) ? r : r + import_node_path11.sep));
  let best = null;
  for (let d = dirs[0]; ; d = (0, import_node_path11.dirname)(d)) {
    for (const r of await readRetros((0, import_node_path11.join)(d, STORE_DIR, RETROS_DIR)).catch(() => [])) {
      if (r.finishedAt === null) continue;
      const rootReal = await (0, import_promises10.realpath)(r.root).catch(() => r.root);
      if ((covers(r.root) || covers(rootReal)) && (!best || r.until > best.until)) best = r;
    }
    if ((0, import_node_path11.dirname)(d) === d) return best;
  }
}
function formatBytes(n) {
  if (n < 1e3) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(1)} KB`;
  return `${(n / 1e6).toFixed(1)} MB`;
}
function cadenceSummary(c) {
  const day = (iso) => iso.slice(0, 10);
  const days = `${c.days} day${c.days === 1 ? "" : "s"}`;
  const data = `${formatBytes(c.bytes)} of review threads (${c.threads})`;
  if (c.lastRetro) return `${days} and ${data} since the last retro (${day(c.lastRetro.until)})`;
  return c.since ? `${days} and ${data} since the first thread (${day(c.since)}), no retro yet` : `${data}, no retro yet`;
}
function dueReasons(c) {
  const t = c.thresholds;
  return c.reasons.map(
    (r) => r === "days" ? `${c.days} days since ${c.lastRetro ? "the last retro" : "the first thread"} (reminder at ${Math.min(t.days, t.maxDays)})` : r === "size" ? `${formatBytes(c.bytes)} of threads to look back at (reminder at ${formatBytes(t.bytes)})` : `${t.maxDays} days or more: agents delete their conversations after a while (often 30 days), and the retro reads back those linked to replies`
  );
}

// src/hook.ts
var import_node_child_process5 = require("node:child_process");
var import_promises11 = require("node:fs/promises");
var import_node_path12 = require("node:path");

// src/channelFlag.ts
var CHANNEL = "plugin:local-review@local-review";
var LAUNCH_WITH_CHANNEL = `claude --dangerously-load-development-channels ${CHANNEL}`;
var CHANNEL_FLAGS = ["--dangerously-load-development-channels", "--channels"];
function hasChannel(commandLine2) {
  const args = commandLine2.trim().split(/\s+/);
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split("=", 2);
    if (!CHANNEL_FLAGS.includes(flag)) continue;
    const values = inline !== void 0 ? [inline] : [];
    for (let j = i + 1; inline === void 0 && j < args.length && !args[j].startsWith("-"); j++)
      values.push(args[j]);
    if (values.some(isOurChannel)) return true;
  }
  return false;
}
var isOurChannel = (value) => value === CHANNEL || /^plugin:local-review@[\w.-]+$/.test(value);

// src/hook.ts
var WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
async function handleHook(input, deps) {
  const id = input.session_id;
  if (!id) return void 0;
  switch (input.hook_event_name) {
    case "SessionStart": {
      const cwd = input.cwd ?? process.cwd();
      const pid = await deps.claudePid();
      const commandLine2 = pid === null ? null : await deps.commandLine(pid);
      const push = commandLine2 === null ? null : hasChannel(commandLine2);
      await deps.registry.register({
        id,
        agent: "Claude",
        cwd,
        branch: await deps.gitBranch(cwd),
        pid,
        startedAt: deps.now().toISOString(),
        push,
        pushCommand: push === true ? null : LAUNCH_WITH_CHANNEL
      });
      const messages = [];
      const wt = await deps.gitWorktreeOf(cwd);
      if (wt) {
        const topic = { kind: "branch", ...wt };
        if (await deps.registry.subscribe(id, topic, "launch"))
          messages.push(subscribed(topic, "you were started in its worktree"));
      }
      if (input.source !== "resume" && input.source !== "compact") {
        const reminder = await retroReminder(cwd, deps);
        if (reminder) messages.push(reminder);
      }
      return messages.length ? messages.join("\n\n") : void 0;
    }
    case "SessionEnd":
      await deps.registry.unregister(id);
      return void 0;
    case "PreToolUse": {
      if (input.tool_name === "Bash") {
        await deps.registry.setNote(id, bashNote(input), String(deps.now().getTime()));
        await noteReply(id, input, deps);
      }
      return beforeWorktreeRemoval(input, deps);
    }
    case "PostToolUse": {
      if (input.tool_name === "Bash") {
        const call = replyCall(input);
        if (call) await deps.registry.endCall(id, call.message);
        return afterShellCommand(id, input, deps);
      }
      if (!WRITE_TOOLS.includes(input.tool_name ?? "")) return void 0;
      const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      if (typeof target !== "string" || target === "") return void 0;
      const file = (0, import_node_path12.isAbsolute)(target) ? target : (0, import_node_path12.resolve)(input.cwd ?? process.cwd(), target);
      const topic = await deps.topicOf(file);
      return await deps.registry.subscribe(id, topic, "modified") ? subscribed(topic, "you modified a file there") : void 0;
    }
    case "PostToolUseFailure": {
      if (input.tool_name !== "Bash") return void 0;
      const call = replyCall(input);
      if (call) await deps.registry.endCall(id, call.message);
      await deps.registry.takeNote(id, bashNote(input));
      return void 0;
    }
  }
  return void 0;
}
async function retroReminder(cwd, deps) {
  if (!deps.retroCadence) return void 0;
  let timer;
  const late = new Promise((done) => {
    timer = setTimeout(() => done(null), deps.reminderTimeoutMs ?? 3e3);
  });
  const cadence = await Promise.race([deps.retroCadence(cwd).catch(() => null), late]);
  clearTimeout(timer);
  if (!cadence?.due) return void 0;
  return `Local Review: a retro is due for this project (${cadence.root}): ${cadenceSummary(cadence)}; ${dueReasons(cadence).join("; ")}. In your first reply of this session, tell the user so in one short sentence and suggest \`/local-review:retro\` (a retro looks back at their review feedback, to improve your setup with them). Say it once only, and do not start the retro unless they ask.`;
}
function replyCall(input) {
  const command = input.tool_input?.command;
  const message = input.tool_use_id ?? "";
  if (typeof command !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(message)) return null;
  const replies = shellSegments(command).some((words) => {
    const i = words.findIndex((w) => (0, import_node_path12.basename)(w) === "lr");
    return i >= 0 && words[i + 1] === "reply";
  });
  return replies ? { message, command } : null;
}
function purgeConfirmation(input) {
  const command = input.tool_input?.command;
  if (input.tool_name !== "Bash" || typeof command !== "string") return null;
  for (const words of shellSegments(command)) {
    const i = words.findIndex((w) => (0, import_node_path12.basename)(w) === "lr");
    if (i < 0 || words[i + 1] !== "purge" || !words.includes("--yes")) continue;
    const at = words.indexOf("--count");
    const count = at >= 0 && /^\d+$/.test(words[at + 1] ?? "") ? Number(words[at + 1]) : null;
    const before = words[words.indexOf("--before") + 1];
    const what = count === null ? "old comment threads" : `${plural(count, "comment thread")}`;
    return `Local Review: this deletes ${what} for good` + (before && words.includes("--before") ? ` (finished, with no activity since ${before})` : "") + ": gone from the history and from retros. It runs only if the user allows it; if they refuse, nothing is deleted.";
  }
  return null;
}
async function noteReply(id, input, deps) {
  const call = replyCall(input);
  if (call) await deps.registry.startCall(id, { ...call, at: deps.now().toISOString() });
}
async function beforeWorktreeRemoval(input, deps) {
  const wt = deps.worktrees;
  const cwd = input.cwd;
  if (!wt || !cwd) return void 0;
  const targets = [];
  if (input.tool_name === "Bash" && typeof input.tool_input?.command === "string")
    targets.push(...worktreeRemovals(input.tool_input.command, cwd, deps.home));
  if (input.tool_name === "ExitWorktree" && input.tool_input?.action === "remove")
    targets.push({ spec: ".", cwd, kind: "session" });
  if (targets.length === 0) return void 0;
  const worktrees = /* @__PURE__ */ new Map();
  for (const t of targets) {
    const dir = t.kind === "git" ? await wt.resolveWorktree(t.cwd, t.spec) : (0, import_node_path12.resolve)(t.cwd, t.spec);
    const info = dir ? await wt.worktreeInfo(dir) : null;
    if (!dir || !info?.linked) continue;
    if (t.kind === "rm" && info.worktree !== await realDir(dir)) continue;
    worktrees.set(info.worktree, info);
  }
  if (worktrees.size === 0) return void 0;
  const messages = [];
  const autoSave = await wt.autoSave();
  for (const info of worktrees.values()) {
    const name = info.branch ? `${info.worktree} (branch ${info.branch})` : info.worktree;
    if (autoSave) {
      const saved = await wt.save(info.worktree).catch((err) => {
        messages.push(
          `Local Review: this command removes the git worktree ${name}, but its comment threads could not be saved first (${err instanceof Error ? err.message : String(err)}): they may be lost with it. Tell the user before going on.`
        );
        return null;
      });
      if (saved && saved.published > 0)
        messages.push(
          `Local Review: before this command removes the git worktree ${name}, its comment threads (${saved.published}) were saved to the store of ${saved.main}: the user's review history and retros keep them. Tell the user in one short sentence.`
        );
    } else {
      const n = await wt.threadCount(info.worktree);
      if (n > 0)
        messages.push(
          `Local Review: this command removes the git worktree ${name}, which holds ${plural(n, "comment thread")} of the user's review, and they are lost with it (saving them first is turned off on this machine). Tell the user; to keep them, they can run \`lr worktree save ${info.worktree}\` before the removal.`
        );
    }
  }
  return messages.length > 0 ? messages.join("\n") : void 0;
}
var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
var realDir = (dir) => (0, import_promises11.realpath)(dir).catch(() => dir);
function worktreeRemovals(command, cwd, home) {
  const found = [];
  let dir = cwd;
  const env = home ? { HOME: home } : process.env;
  for (const words of shellSegments(command)) {
    let t = words;
    while (t.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]) || WRAPPERS.has(t[0]))) t = t.slice(1);
    const [cmd, ...args] = t;
    if (!cmd) continue;
    if (cmd === "cd" || cmd === "pushd") {
      const to = args.find((a) => !a.startsWith("-"));
      dir = (0, import_node_path12.resolve)(dir, expandHome(to ?? "~", env));
      continue;
    }
    if ((0, import_node_path12.basename)(cmd) === "git") {
      let gitDir = dir;
      let i = 0;
      while (i < args.length && args[i].startsWith("-")) {
        if (args[i] === "-C" && args[i + 1] !== void 0) gitDir = (0, import_node_path12.resolve)(gitDir, expandHome(args[i + 1], env));
        i += GIT_OPTIONS_WITH_VALUE.has(args[i]) ? 2 : 1;
      }
      if (args[i] !== "worktree" || args[i + 1] !== "remove") continue;
      const spec = operands(args.slice(i + 2))[0];
      if (spec) found.push({ spec: expandHome(spec, env), cwd: gitDir, kind: "git" });
      continue;
    }
    if ((0, import_node_path12.basename)(cmd) === "rm") {
      const flags = args.filter((a) => a.startsWith("-") && a !== "-" && a !== "--");
      const recursive = flags.some((f) => f === "--recursive" || /^-[A-Za-z]*[rR]/.test(f));
      if (!recursive) continue;
      for (const spec of operands(args))
        if (!/[*?[]/.test(spec)) found.push({ spec: expandHome(spec, env), cwd: dir, kind: "rm" });
    }
  }
  return found;
}
var WRAPPERS = /* @__PURE__ */ new Set(["sudo", "command", "exec", "time", "nohup"]);
var GIT_OPTIONS_WITH_VALUE = /* @__PURE__ */ new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
function operands(args) {
  const out = [];
  let options = true;
  for (const a of args) {
    if (options && a === "--") options = false;
    else if (!options || !a.startsWith("-")) out.push(a);
  }
  return out;
}
function shellSegments(command) {
  const segments = [];
  let words = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      word += command.slice(i + 1, end === -1 ? void 0 : end);
      inWord = true;
      i = end === -1 ? command.length : end;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === "\\" && i + 1 < command.length) i++;
        word += command[i];
      }
    } else if (c === "\\") {
      if (command[i + 1] === "\n") i++;
      else if (i + 1 < command.length) {
        word += command[++i];
        inWord = true;
      }
    } else if (c === " " || c === "	") endWord();
    else if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")") endSegment();
    else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}
async function afterShellCommand(id, input, deps) {
  const since = Number(await deps.registry.takeNote(id, bashNote(input)));
  if (!input.cwd || !Number.isFinite(since) || since <= 0) return void 0;
  const wt = await deps.gitWorktreeOf(input.cwd);
  if (!wt) return void 0;
  const topic = { kind: "branch", ...wt };
  const already = (await deps.registry.subscriptions(id)).some((s) => topicKey(s.topic) === topicKey(topic));
  if (already || (await deps.filesChangedSince(input.cwd, since)).length === 0) return void 0;
  return await deps.registry.subscribe(id, topic, "modified") ? subscribed(topic, "you modified files there") : void 0;
}
var subscribed = (topic, why) => `Local Review: this session is now subscribed to ${topicLabel(topic)} (${why}): the comments the user publishes there will come to you. Tell the user in one short sentence.`;
var bashNote = (input) => `bash-${/^[A-Za-z0-9_-]{1,100}$/.test(input.tool_use_id ?? "") ? input.tool_use_id : "command"}`;
function run(cmd, args, cwd) {
  return new Promise(
    (done) => (0, import_node_child_process5.execFile)(cmd, args, { cwd, timeout: 3e3 }, (err, stdout) => done(err ? null : stdout.trim()))
  );
}
var gitBranch = async (cwd) => await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd) || null;
var commandLine = (pid) => run("ps", ["-o", "args=", "-p", String(pid)]);
function runsClaude(args) {
  return (args ?? "").trim().split(/\s+/).slice(0, 2).some((arg) => (0, import_node_path12.basename)(arg) === "claude");
}
async function findClaudePid(startPid = process.ppid, maxHops = 6) {
  let pid = startPid;
  for (let hop = 0; hop < maxHops && pid > 1; hop++) {
    const line = await run("ps", ["-o", "ppid=,comm=", "-p", String(pid)]);
    if (!line) return null;
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) return null;
    if ((0, import_node_path12.basename)(match[2].trim()) === "claude" || runsClaude(await commandLine(pid))) return pid;
    pid = Number(match[1]);
  }
  return null;
}

// src/hookMain.ts
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const ask = input.hook_event_name === "PreToolUse" ? purgeConfirmation(input) : null;
  const message = await handleHook(input, {
    registry: new SessionRegistry(localReviewHome()),
    claudePid: () => findClaudePid(),
    commandLine,
    gitBranch,
    topicOf: (path) => topicOf(path),
    gitWorktreeOf,
    filesChangedSince,
    now: () => /* @__PURE__ */ new Date(),
    home: process.env.HOME || (0, import_node_os3.homedir)(),
    retroCadence: async (cwd) => {
      const config = await readConfig();
      return config.retroReminder ? retroCadence(cwd, { thresholds: thresholdsOf(config) }) : null;
    },
    worktrees: {
      autoSave: async () => (await readConfig()).autoSaveWorktrees,
      resolveWorktree,
      worktreeInfo,
      save: (dir) => saveWorktreeThreads(dir),
      threadCount: (dir) => worktreeThreadCount(dir)
    }
  }).catch(() => void 0);
  if ((message || ask) && input.hook_event_name) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: input.hook_event_name,
          ...message ? { additionalContext: message } : {},
          ...ask ? { permissionDecision: "ask", permissionDecisionReason: ask } : {}
        }
      })
    );
  }
}
main().catch(() => void 0).finally(() => process.exit(0));
