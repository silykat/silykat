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
  file(id, ext) {
    if (!SESSION_ID.test(id)) throw new Error(`Invalid session id: ${id}`);
    return (0, import_node_path.join)(this.dir, ext === "json" ? `${id}.json` : `${id}.touched.jsonl`);
  }
  /** Registers (or refreshes) a session. Written atomically: readers never see half a file. */
  async register(record) {
    await (0, import_promises.mkdir)(this.dir, { recursive: true });
    const target = this.file(record.id, "json");
    const tmp = `${target}.${process.pid}.tmp`;
    await (0, import_promises.writeFile)(tmp, JSON.stringify(record, null, 2) + "\n");
    await (0, import_promises.rename)(tmp, target);
  }
  async unregister(id) {
    await (0, import_promises.rm)(this.file(id, "json"), { force: true });
    await (0, import_promises.rm)(this.file(id, "touched"), { force: true });
  }
  /** Records that a session wrote a file. Appended, so concurrent hooks never lose an entry. */
  async touch(id, absolutePath) {
    await (0, import_promises.mkdir)(this.dir, { recursive: true });
    await (0, import_promises.appendFile)(
      this.file(id, "touched"),
      JSON.stringify({ path: absolutePath, at: (/* @__PURE__ */ new Date()).toISOString() }) + "\n"
    );
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
      sessions.push({ ...record, touched: await this.readTouched(record.id) });
    }
    return sessions;
  }
  async readTouched(id) {
    let text;
    try {
      text = await (0, import_promises.readFile)(this.file(id, "touched"), "utf8");
    } catch {
      return [];
    }
    const paths = [];
    for (const line of text.split("\n")) {
      try {
        const { path } = JSON.parse(line);
        if (typeof path === "string") paths.push(path);
      } catch {
      }
    }
    const order = /* @__PURE__ */ new Map();
    for (const p of paths) {
      order.delete(p);
      order.set(p, true);
    }
    return [...order.keys()];
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
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : ""
    };
  } catch {
    return null;
  }
}

// src/hook.ts
var import_node_child_process = require("node:child_process");
var import_node_path2 = require("node:path");
var WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
async function handleHook(input, deps) {
  const id = input.session_id;
  if (!id) return;
  switch (input.hook_event_name) {
    case "SessionStart": {
      const cwd = input.cwd ?? process.cwd();
      await deps.registry.register({
        id,
        agent: "Claude",
        cwd,
        branch: await deps.gitBranch(cwd),
        pid: await deps.claudePid(),
        startedAt: deps.now().toISOString()
      });
      return;
    }
    case "SessionEnd":
      await deps.registry.unregister(id);
      return;
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
    gitBranch,
    now: () => /* @__PURE__ */ new Date()
  });
}
main().catch(() => void 0).finally(() => process.exit(0));
