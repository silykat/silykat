#!/usr/bin/env node
"use strict";

// src/channelMain.ts
var import_node_fs = require("node:fs");
var import_node_path3 = require("node:path");
var import_node_readline = require("node:readline");

// ../../packages/core/src/sessions.ts
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path = require("node:path");

// ../../packages/core/src/topics.ts
var topicKey = (t) => t.kind === "branch" ? `branch:${t.repo}#${t.branch}` : `path:${t.path}`;

// ../../packages/core/src/sessions.ts
var CURSOR_HEAD_BYTES = 256;
var CALL_NOTE = "call-";
var CALL_MAX_AGE_MS = 15 * 6e4;
function localReviewHome(env = process.env) {
  return env.LOCAL_REVIEW_HOME?.trim() || (0, import_node_path.join)((0, import_node_os.homedir)(), ".local-review");
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
    this.dir = (0, import_node_path.join)(home, "sessions");
  }
  isAlive;
  dir;
  file(id, kind) {
    if (!SESSION_ID.test(id)) throw new Error(`Invalid session id: ${id}`);
    return (0, import_node_path.join)(this.dir, kind === "json" ? `${id}.json` : `${id}.${kind}.jsonl`);
  }
  /** Registers (or refreshes) a session. Written atomically: readers never see half a file. */
  async register(record) {
    await (0, import_promises.mkdir)(this.dir, { recursive: true });
    const target = this.file(record.id, "json");
    const tmp = `${target}.${process.pid}.tmp`;
    await (0, import_promises.writeFile)(tmp, JSON.stringify(record, null, 2) + "\n");
    await (0, import_promises.rename)(tmp, target);
  }
  /** Everything the registry keeps about a session goes with it. */
  async unregister(id) {
    this.file(id, "json");
    let names = [];
    try {
      names = await (0, import_promises.readdir)(this.dir);
    } catch {
      return;
    }
    await Promise.all(names.filter((n) => n.startsWith(`${id}.`)).map((n) => (0, import_promises.rm)((0, import_node_path.join)(this.dir, n), { force: true })));
  }
  /** A small note an adapter keeps about a session between two hooks (removed with the session). */
  async setNote(id, key, value) {
    await (0, import_promises.mkdir)(this.dir, { recursive: true });
    await (0, import_promises.writeFile)(this.note(id, key), value);
  }
  /** Reads and removes a note; `undefined` when there is none. */
  async takeNote(id, key) {
    const file = this.note(id, key);
    try {
      const value = await (0, import_promises.readFile)(file, "utf8");
      await (0, import_promises.rm)(file, { force: true });
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
      names = await (0, import_promises.readdir)(this.dir);
    } catch {
      return [];
    }
    const prefix = `${id}.note-${CALL_NOTE}`;
    const calls = await Promise.all(
      names.filter((n) => n.startsWith(prefix)).map(async (n) => {
        try {
          const raw = JSON.parse(await (0, import_promises.readFile)((0, import_node_path.join)(this.dir, n), "utf8"));
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
    return (0, import_node_path.join)(this.dir, `${id}.note-${key}`);
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
      text = await (0, import_promises.readFile)(this.file(id, "subscriptions"), "utf8");
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
    await (0, import_promises.mkdir)(this.dir, { recursive: true });
    await (0, import_promises.appendFile)(this.file(id, "subscriptions"), JSON.stringify(event) + "\n");
  }
  /** Hands threads to a session. Appended to its inbox, which its agent's adapter watches. */
  async deliver(id, delivery) {
    await (0, import_promises.mkdir)(this.dir, { recursive: true });
    await (0, import_promises.appendFile)(this.file(id, "inbox"), JSON.stringify(delivery) + "\n");
  }
  /**
   * Deliveries appended to a session's inbox since `cursor` (none: from the start), and the cursor
   * to read from next time. A line still being written is left for next time.
   */
  async readInbox(id, cursor) {
    let handle;
    try {
      handle = await (0, import_promises.open)(this.file(id, "inbox"), "r");
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
      names = (await (0, import_promises.readdir)(this.dir)).filter((n) => n.endsWith(".json"));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    const sessions = [];
    for (const name of names.sort()) {
      const record = await readRecord((0, import_node_path.join)(this.dir, name));
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
    const raw = JSON.parse(await (0, import_promises.readFile)(file, "utf8"));
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

// ../../packages/core/src/config.ts
var DEFAULT_CONFIG = {
  keepHistory: true,
  retroReminder: true,
  retroReminderDays: 7,
  retroReminderSizeKB: 1e3,
  retroReminderMaxDays: 25,
  retroSessions: "reports",
  retroSourceReviews: "ask",
  retroSourceSessions: "ask",
  retroSourceAudit: "ask"
};
var writing = Promise.resolve();

// ../../packages/core/src/cadence.ts
var DEFAULT_CADENCE = thresholdsOf(DEFAULT_CONFIG);
function thresholdsOf(c) {
  return { days: c.retroReminderDays, bytes: c.retroReminderSizeKB * 1e3, maxDays: c.retroReminderMaxDays };
}

// ../../packages/core/src/retroGuards.ts
var STOPWORDS = new Set(
  "the and for with that this from into when then than are was were has have not use uses using les des une pour avec dans sur par pas que qui est sont aux ses son leur".split(" ")
);

// src/channel.ts
var BATCH_MS = 1500;
var SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
var INSTRUCTIONS = [
  "Local Review is the local code review tool the user works with in VS Code.",
  'When the user publishes comments there (or edits or deletes some), they arrive as <channel source="...local-review..." store="<folder>" threads="<ids>">.',
  "Process them right away, without waiting to be asked: follow the local-review review skill",
  "(/local-review:review), passing `--root <folder>` (the store attribute) to every `lr` command, and listing only",
  "those threads (`lr list --root <folder> --thread <id> --thread <id>\u2026`): others may be for another session.",
  "Answer in the threads with `lr reply`; nothing needs to be sent back through the channel."
].join(" ");
var LocalReviewChannel = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  ready = false;
  sessionId;
  cursor;
  seen = /* @__PURE__ */ new Set();
  pending = [];
  lastArrival = 0;
  /** A message from Claude Code. */
  handle(message) {
    if (message.method === void 0) return;
    const isRequest = message.id !== void 0 && message.id !== null;
    switch (message.method) {
      case "initialize": {
        const requested = message.params?.protocolVersion;
        this.respond(message, {
          protocolVersion: typeof requested === "string" && SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { experimental: { "claude/channel": {} } },
          serverInfo: { name: "local-review", version: this.deps.version },
          instructions: INSTRUCTIONS
        });
        return;
      }
      case "notifications/initialized":
        this.ready = true;
        return;
      case "ping":
        this.respond(message, {});
        return;
      default:
        if (isRequest)
          this.deps.send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `Method not found: ${message.method}` }
          });
    }
  }
  /** One look at the inbox; called regularly. Pushes a batch once publications have settled. */
  async poll() {
    if (!this.ready) return;
    const session = await this.currentSession();
    if (session && session.id !== this.sessionId) {
      this.sessionId = session.id;
      this.cursor = void 0;
    }
    if (this.sessionId) {
      const { deliveries, cursor } = await this.deps.registry.readInbox(this.sessionId, this.cursor);
      this.cursor = cursor;
      const fresh = deliveries.filter((d) => !this.seen.has(d.id));
      for (const d of fresh) this.seen.add(d.id);
      if (fresh.length > 0) {
        this.pending.push(...fresh);
        this.lastArrival = this.deps.now();
      }
    }
    if (this.pending.length > 0 && this.deps.now() - this.lastArrival >= BATCH_MS) this.flush();
  }
  async currentSession() {
    if (this.deps.claudePid === null) return void 0;
    const mine = (await this.deps.registry.list()).filter((s) => s.pid === this.deps.claudePid);
    return mine.reduce(
      (a, s) => a === void 0 || s.startedAt > a.startedAt ? s : a,
      void 0
    );
  }
  flush() {
    const byRoot = /* @__PURE__ */ new Map();
    for (const d of this.pending) byRoot.set(d.root, [...byRoot.get(d.root) ?? [], d]);
    this.pending = [];
    for (const [root, deliveries] of byRoot) {
      this.deps.send({
        jsonrpc: "2.0",
        method: "notifications/claude/channel",
        params: {
          content: describe(root, deliveries),
          meta: {
            store: root,
            threads: threadIds(deliveries).join(" "),
            // Every session these comments went to (e.g. a developer and a reviewer): for debugging.
            recipients: [...new Set(deliveries.flatMap((d) => d.recipients ?? []))].join(" ")
          }
        }
      });
    }
  }
  respond(request, result) {
    if (request.id === void 0 || request.id === null) return;
    this.deps.send({ jsonrpc: "2.0", id: request.id, result });
  }
};
function describe(root, deliveries) {
  const at = JSON.stringify(root);
  const of = (...kinds) => deliveries.filter((d) => kinds.includes(d.kind));
  const parts = [];
  const published = of("review", "comment", "reply");
  if (published.length > 0) {
    const ids = threadIds(published);
    const what = [
      count(of("review").length, "review"),
      count(of("comment").length, "new comment"),
      count(of("reply").length, "reply", "replies")
    ].filter((x) => x !== "");
    parts.push(
      `The user published ${joinList(what)} in Local Review (${count(ids.length, "thread")}), in ${root}. Process them now with the local-review review skill, running every lr command with --root ${at}, and listing only these threads: lr list --root ${at} ${ids.map((id) => `--thread ${id}`).join(" ")}`
    );
  }
  const edited = threadIds(of("edit"));
  if (edited.length > 0)
    parts.push(
      `The user edited comments of ${edited.length === 1 ? "thread" : "threads"} ${edited.join(", ")} in Local Review (${root}). Read ${edited.length === 1 ? "it" : "them"} again (lr show <id> --root ${at}): if you already worked on the old version, adapt your work to the new one, then reply.`
    );
  const deleted = threadIds(of("delete"));
  if (deleted.length > 0)
    parts.push(
      `The user deleted comments of ${deleted.length === 1 ? "thread" : "threads"} ${deleted.join(", ")} in Local Review (${root}). Check with lr show <id> --root ${at}: a thread that no longer exists was deleted, so stop working on it; if you already changed code for it, ask the user whether to undo those changes (never undo them on your own).`
    );
  return parts.join("\n\n");
}
var threadIds = (deliveries) => [...new Set(deliveries.flatMap((d) => d.threadIds))];
var count = (n, one, many = `${one}s`) => n === 0 ? "" : n === 1 && one === "review" ? "a review" : `${n} ${n === 1 ? one : many}`;
var joinList = (parts) => parts.length <= 1 ? parts[0] ?? "" : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

// src/hook.ts
var import_node_child_process = require("node:child_process");
var import_node_path2 = require("node:path");

// src/channelFlag.ts
var CHANNEL = "plugin:local-review@local-review";
var LAUNCH_WITH_CHANNEL = `claude --dangerously-load-development-channels ${CHANNEL}`;

// src/retroAudit.ts
var AUDIT_TIMEOUT_MS = 15 * 6e4;

// src/retroInsights.ts
var INSIGHTS_TIMEOUT_MS = 15 * 6e4;

// src/hook.ts
function run(cmd, args, cwd) {
  return new Promise(
    (done) => (0, import_node_child_process.execFile)(cmd, args, { cwd, timeout: 3e3 }, (err, stdout) => done(err ? null : stdout.trim()))
  );
}
var commandLine = (pid) => run("ps", ["-o", "args=", "-p", String(pid)]);
function runsClaude(args) {
  return (args ?? "").trim().split(/\s+/).slice(0, 2).some((arg) => (0, import_node_path2.basename)(arg) === "claude");
}
async function findClaudePid(startPid = process.ppid, maxHops = 6) {
  let pid = startPid;
  for (let hop = 0; hop < maxHops && pid > 1; hop++) {
    const line = await run("ps", ["-o", "ppid=,comm=", "-p", String(pid)]);
    if (!line) return null;
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) return null;
    if ((0, import_node_path2.basename)(match[2].trim()) === "claude" || runsClaude(await commandLine(pid))) return pid;
    pid = Number(match[1]);
  }
  return null;
}

// src/channelMain.ts
function pluginVersion() {
  try {
    const manifest = (0, import_node_path3.join)(__dirname, "..", ".claude-plugin", "plugin.json");
    return JSON.parse((0, import_node_fs.readFileSync)(manifest, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}
var POLL_MS = 500;
async function main() {
  const channel = new LocalReviewChannel({
    registry: new SessionRegistry(localReviewHome()),
    claudePid: await findClaudePid(process.ppid),
    send: (message) => process.stdout.write(JSON.stringify(message) + "\n"),
    now: () => Date.now(),
    version: pluginVersion()
  });
  const lines = (0, import_node_readline.createInterface)({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    try {
      channel.handle(JSON.parse(line));
    } catch (err) {
      process.stderr.write(`local-review channel: ignored a message: ${String(err)}
`);
    }
  });
  lines.on("close", () => process.exit(0));
  let polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    channel.poll().catch((err) => process.stderr.write(`local-review channel: ${String(err)}
`)).finally(() => polling = false);
  }, POLL_MS);
}
void main();
