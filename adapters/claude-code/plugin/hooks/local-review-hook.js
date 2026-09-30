#!/usr/bin/env node
"use strict";

// ../../packages/core/src/sessions.ts
var import_promises2 = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path2 = require("node:path");

// ../../packages/core/src/topics.ts
var import_node_child_process = require("node:child_process");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var topicKey = (t) => t.kind === "branch" ? `branch:${t.repo}#${t.branch}` : `path:${t.path}`;
function topicLabel(t) {
  if (t.kind === "path") return t.path;
  const repoName = (0, import_node_path.basename)(t.repo) === ".git" ? (0, import_node_path.basename)((0, import_node_path.dirname)(t.repo)) : (0, import_node_path.basename)(t.repo).replace(/\.git$/, "");
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
    const s = await (0, import_promises.stat)(dir).catch(() => null);
    if (s) return s.isDirectory() ? dir : (0, import_node_path.dirname)(dir);
    const parent = (0, import_node_path.dirname)(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}
async function currentBranch(dir) {
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], dir);
  if (branch) return branch;
  for (const state of ["rebase-merge/head-name", "rebase-apply/head-name"]) {
    const file = await git(["rev-parse", "--path-format=absolute", "--git-path", state], dir);
    const head = file ? (await (0, import_promises.readFile)(file, "utf8").catch(() => "")).trim() : "";
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
  return { repo: await (0, import_promises.realpath)(commonDir).catch(() => commonDir), branch, worktree };
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
    if (entry[1] !== "D" && entry[0] !== "D") paths.push((0, import_node_path.join)(top, entry.slice(3)));
  }
  const recent = await Promise.all(
    paths.map(async (p) => ((await (0, import_promises.stat)(p).catch(() => null))?.mtimeMs ?? 0) >= sinceMs - 1e3)
  );
  return paths.filter((_, i) => recent[i]);
}

// ../../packages/core/src/sessions.ts
var CURSOR_HEAD_BYTES = 256;
function localReviewHome(env = process.env) {
  return env.LOCAL_REVIEW_HOME?.trim() || (0, import_node_path2.join)((0, import_node_os.homedir)(), ".local-review");
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
    this.dir = (0, import_node_path2.join)(home, "sessions");
  }
  isAlive;
  dir;
  file(id, kind) {
    if (!SESSION_ID.test(id)) throw new Error(`Invalid session id: ${id}`);
    return (0, import_node_path2.join)(this.dir, kind === "json" ? `${id}.json` : `${id}.${kind}.jsonl`);
  }
  /** Registers (or refreshes) a session. Written atomically: readers never see half a file. */
  async register(record) {
    await (0, import_promises2.mkdir)(this.dir, { recursive: true });
    const target = this.file(record.id, "json");
    const tmp = `${target}.${process.pid}.tmp`;
    await (0, import_promises2.writeFile)(tmp, JSON.stringify(record, null, 2) + "\n");
    await (0, import_promises2.rename)(tmp, target);
  }
  /** Everything the registry keeps about a session goes with it. */
  async unregister(id) {
    this.file(id, "json");
    let names = [];
    try {
      names = await (0, import_promises2.readdir)(this.dir);
    } catch {
      return;
    }
    await Promise.all(names.filter((n) => n.startsWith(`${id}.`)).map((n) => (0, import_promises2.rm)((0, import_node_path2.join)(this.dir, n), { force: true })));
  }
  /** A small note an adapter keeps about a session between two hooks (removed with the session). */
  async setNote(id, key, value) {
    await (0, import_promises2.mkdir)(this.dir, { recursive: true });
    await (0, import_promises2.writeFile)(this.note(id, key), value);
  }
  /** Reads and removes a note; `undefined` when there is none. */
  async takeNote(id, key) {
    const file = this.note(id, key);
    try {
      const value = await (0, import_promises2.readFile)(file, "utf8");
      await (0, import_promises2.rm)(file, { force: true });
      return value;
    } catch {
      return void 0;
    }
  }
  note(id, key) {
    if (!SESSION_ID.test(key)) throw new Error(`Invalid note key: ${key}`);
    this.file(id, "json");
    return (0, import_node_path2.join)(this.dir, `${id}.note-${key}`);
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
      text = await (0, import_promises2.readFile)(this.file(id, "subscriptions"), "utf8");
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
    await (0, import_promises2.mkdir)(this.dir, { recursive: true });
    await (0, import_promises2.appendFile)(this.file(id, "subscriptions"), JSON.stringify(event) + "\n");
  }
  /** Hands threads to a session. Appended to its inbox, which its agent's adapter watches. */
  async deliver(id, delivery) {
    await (0, import_promises2.mkdir)(this.dir, { recursive: true });
    await (0, import_promises2.appendFile)(this.file(id, "inbox"), JSON.stringify(delivery) + "\n");
  }
  /**
   * Deliveries appended to a session's inbox since `cursor` (none: from the start), and the cursor
   * to read from next time. A line still being written is left for next time.
   */
  async readInbox(id, cursor) {
    let handle;
    try {
      handle = await (0, import_promises2.open)(this.file(id, "inbox"), "r");
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
      names = (await (0, import_promises2.readdir)(this.dir)).filter((n) => n.endsWith(".json"));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    const sessions = [];
    for (const name of names.sort()) {
      const record = await readRecord((0, import_node_path2.join)(this.dir, name));
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
    const raw = JSON.parse(await (0, import_promises2.readFile)(file, "utf8"));
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

// src/hook.ts
var import_node_child_process2 = require("node:child_process");
var import_node_path3 = require("node:path");

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
      const wt = await deps.gitWorktreeOf(cwd);
      if (!wt) return void 0;
      const topic = { kind: "branch", ...wt };
      return await deps.registry.subscribe(id, topic, "launch") ? subscribed(topic, "you were started in its worktree") : void 0;
    }
    case "SessionEnd":
      await deps.registry.unregister(id);
      return void 0;
    case "PreToolUse":
      if (input.tool_name === "Bash") await deps.registry.setNote(id, bashNote(input), String(deps.now().getTime()));
      return void 0;
    case "PostToolUse": {
      if (input.tool_name === "Bash") return afterShellCommand(id, input, deps);
      if (!WRITE_TOOLS.includes(input.tool_name ?? "")) return void 0;
      const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      if (typeof target !== "string" || target === "") return void 0;
      const file = (0, import_node_path3.isAbsolute)(target) ? target : (0, import_node_path3.resolve)(input.cwd ?? process.cwd(), target);
      const topic = await deps.topicOf(file);
      return await deps.registry.subscribe(id, topic, "modified") ? subscribed(topic, "you modified a file there") : void 0;
    }
  }
  return void 0;
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
    (done) => (0, import_node_child_process2.execFile)(cmd, args, { cwd, timeout: 3e3 }, (err, stdout) => done(err ? null : stdout.trim()))
  );
}
var gitBranch = async (cwd) => await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd) || null;
var commandLine = (pid) => run("ps", ["-o", "args=", "-p", String(pid)]);
function runsClaude(args) {
  return (args ?? "").trim().split(/\s+/).slice(0, 2).some((arg) => (0, import_node_path3.basename)(arg) === "claude");
}
async function findClaudePid(startPid = process.ppid, maxHops = 6) {
  let pid = startPid;
  for (let hop = 0; hop < maxHops && pid > 1; hop++) {
    const line = await run("ps", ["-o", "ppid=,comm=", "-p", String(pid)]);
    if (!line) return null;
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) return null;
    if ((0, import_node_path3.basename)(match[2].trim()) === "claude" || runsClaude(await commandLine(pid))) return pid;
    pid = Number(match[1]);
  }
  return null;
}

// src/hookMain.ts
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const message = await handleHook(input, {
    registry: new SessionRegistry(localReviewHome()),
    claudePid: () => findClaudePid(),
    commandLine,
    gitBranch,
    topicOf: (path) => topicOf(path),
    gitWorktreeOf,
    filesChangedSince,
    now: () => /* @__PURE__ */ new Date()
  });
  if (message && input.hook_event_name) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: message } })
    );
  }
}
main().catch(() => void 0).finally(() => process.exit(0));
