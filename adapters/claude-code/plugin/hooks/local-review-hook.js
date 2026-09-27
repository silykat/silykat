#!/usr/bin/env node
"use strict";

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
  /** The session now works in `dir` (on `branch`). No-op for an unknown session. */
  async moveTo(id, dir, branch) {
    const record = await readRecord(this.file(id, "json"));
    if (!record || record.workingDir === dir && record.branch === branch) return;
    await this.register({ ...record, workingDir: dir, branch });
  }
  async unregister(id) {
    await (0, import_promises.rm)(this.file(id, "json"), { force: true });
    await (0, import_promises.rm)(this.file(id, "touched"), { force: true });
    await (0, import_promises.rm)(this.file(id, "inbox"), { force: true });
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

// src/hook.ts
var import_node_child_process = require("node:child_process");
var import_node_path2 = require("node:path");

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
  if (!id) return;
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
      return;
    }
    case "SessionEnd":
      await deps.registry.unregister(id);
      return;
    case "CwdChanged": {
      const dir = input.new_cwd ?? input.cwd;
      if (dir) await deps.registry.moveTo(id, dir, await deps.gitBranch(dir));
      return;
    }
    case "PostToolUse": {
      if (!WRITE_TOOLS.includes(input.tool_name ?? "")) return;
      const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      if (typeof target !== "string" || target === "") return;
      await deps.registry.touch(id, (0, import_node_path2.isAbsolute)(target) ? target : (0, import_node_path2.resolve)(input.cwd ?? process.cwd(), target));
      return;
    }
  }
}
function run(cmd, args, cwd) {
  return new Promise(
    (done) => (0, import_node_child_process.execFile)(cmd, args, { cwd, timeout: 3e3 }, (err, stdout) => done(err ? null : stdout.trim()))
  );
}
var gitBranch = async (cwd) => await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd) || null;
var commandLine = (pid) => run("ps", ["-o", "args=", "-p", String(pid)]);
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

// src/hookMain.ts
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  await handleHook(input, {
    registry: new SessionRegistry(localReviewHome()),
    claudePid: () => findClaudePid(),
    commandLine,
    gitBranch,
    now: () => /* @__PURE__ */ new Date()
  });
}
main().catch(() => void 0).finally(() => process.exit(0));
