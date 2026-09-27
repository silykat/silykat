#!/usr/bin/env node
"use strict";

// src/channelMain.ts
var import_node_readline = require("node:readline");

// ../../packages/core/src/sessions.ts
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
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
  /**
   * The session now works in `dir`, on `branch` (a function to compute it only when the session did
   * move). No-op for an unknown session, or one already there.
   */
  async moveTo(id, dir, branch) {
    const record = await readRecord(this.file(id, "json"));
    if (!record || (record.workingDir ?? record.cwd) === dir) return;
    await this.register({
      ...record,
      workingDir: dir,
      branch: typeof branch === "function" ? await branch(dir) : branch
    });
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
  note(id, key) {
    if (!SESSION_ID.test(key)) throw new Error(`Invalid note key: ${key}`);
    this.file(id, "json");
    return (0, import_node_path.join)(this.dir, `${id}.note-${key}`);
  }
  /** Records that a session wrote a file. Appended, so concurrent hooks never lose an entry. */
  async touch(id, absolutePath) {
    await (0, import_promises.mkdir)(this.dir, { recursive: true });
    await (0, import_promises.appendFile)(
      this.file(id, "touched"),
      JSON.stringify({ path: absolutePath, at: (/* @__PURE__ */ new Date()).toISOString() }) + "\n"
    );
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
      if (err.code === "ENOENT") return { deliveries: [], cursor: { file: 0, offset: 0 } };
      throw err;
    }
    try {
      const { ino, size } = await handle.stat();
      const from = cursor && cursor.file === ino && cursor.offset <= size ? cursor.offset : 0;
      const buffer = Buffer.alloc(size - from);
      await handle.read(buffer, 0, buffer.length, from);
      const end = buffer.lastIndexOf(10) + 1;
      const deliveries = [];
      for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
        const delivery = parseDelivery(line);
        if (delivery) deliveries.push(delivery);
      }
      return { deliveries, cursor: { file: ino, offset: from + end } };
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
      const writtenAt = await this.readTouched(record.id);
      sessions.push({ ...record, touched: Object.keys(writtenAt), writtenAt });
    }
    return sessions;
  }
  /** The files a session wrote, each once with its last write, ordered by it (most recent last). */
  async readTouched(id) {
    let text;
    try {
      text = await (0, import_promises.readFile)(this.file(id, "touched"), "utf8");
    } catch {
      return {};
    }
    const order = /* @__PURE__ */ new Map();
    for (const line of text.split("\n")) {
      try {
        const { path, at } = JSON.parse(line);
        if (typeof path !== "string") continue;
        order.delete(path);
        order.set(path, typeof at === "string" ? at : "");
      } catch {
      }
    }
    return Object.fromEntries(order);
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
      workingDir: typeof raw.workingDir === "string" ? raw.workingDir : null,
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
    const kind = raw.kind === "review" || raw.kind === "reply" ? raw.kind : "comment";
    return {
      id: raw.id,
      at: typeof raw.at === "string" ? raw.at : "",
      root: raw.root,
      kind,
      threadIds: raw.threadIds.filter((t) => typeof t === "string"),
      ...typeof raw.reviewId === "string" ? { reviewId: raw.reviewId } : {}
    };
  } catch {
    return null;
  }
}

// src/channel.ts
var BATCH_MS = 1500;
var SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
var INSTRUCTIONS = [
  "Local Review is the local code review tool the user works with in VS Code.",
  'When the user publishes comments there, they arrive as <channel source="...local-review..." store="<folder>" threads="<ids>">.',
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
          meta: { store: root, threads: threadIds(deliveries).join(" ") }
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
  const ids = threadIds(deliveries);
  const threads = ids.length;
  const reviews = deliveries.filter((d) => d.kind === "review").length;
  const comments = deliveries.filter((d) => d.kind === "comment").length;
  const replies = deliveries.filter((d) => d.kind === "reply").length;
  const what = [count(reviews, "review"), count(comments, "new comment"), count(replies, "reply", "replies")].filter(
    (s) => s !== ""
  );
  return `The user published ${joinList(what)} in Local Review (${count(threads, "thread")}), in ${root}. Process them now with the local-review review skill, running every lr command with --root ${JSON.stringify(root)}, and listing only these threads: lr list --root ${JSON.stringify(root)} ${ids.map((id) => `--thread ${id}`).join(" ")}`;
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

// src/hook.ts
function run(cmd, args, cwd, raw = false) {
  return new Promise(
    (done) => (0, import_node_child_process.execFile)(
      cmd,
      args,
      { cwd, timeout: 3e3, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => done(err ? null : raw ? stdout : stdout.trim())
    )
  );
}
async function findClaudePid(startPid = process.ppid, maxHops = 6) {
  let pid = startPid;
  for (let hop = 0; hop < maxHops && pid > 1; hop++) {
    const line = await run("ps", ["-o", "ppid=,comm=", "-p", String(pid)]);
    if (!line) return null;
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) return null;
    if ((0, import_node_path2.basename)(match[2].trim()) === "claude") return pid;
    pid = Number(match[1]);
  }
  return null;
}

// src/channelMain.ts
var POLL_MS = 500;
async function main() {
  const channel = new LocalReviewChannel({
    registry: new SessionRegistry(localReviewHome()),
    claudePid: await findClaudePid(process.ppid),
    send: (message) => process.stdout.write(JSON.stringify(message) + "\n"),
    now: () => Date.now(),
    version: "0.4.2"
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
