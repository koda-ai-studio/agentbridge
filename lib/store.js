import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawnSync } from "node:child_process";
let lastNow = 0;
export function now() {
  lastNow = Math.max(Date.now(), lastNow + 1);
  return new Date(lastNow).toISOString();
}
export const uid = (p) => `${p}-${crypto.randomUUID()}`;
export const pointerName = "agentbridge.json";
export function gitCommonDir(cwd) {
  const r = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd, encoding: "utf8", timeout: 10000 },
  );
  return r.status === 0 ? r.stdout.trim() : null;
}
const resolved = new Map();
export function forgetRoot(cwd) {
  resolved.delete(cwd);
}
export function locate(cwd) {
  const inRepo = path.join(cwd, ".agentbridge");
  if (fs.existsSync(inRepo)) return { dir: inRepo, mode: "repository" };
  const env = process.env.AGENTBRIDGE_RECORDS;
  if (env) {
    if (!path.isAbsolute(env))
      throw Error("AGENTBRIDGE_RECORDS must be an absolute path");
    return { dir: env, mode: "environment" };
  }
  if (resolved.has(cwd)) return resolved.get(cwd);
  const common = gitCommonDir(cwd);
  const pointer = common && path.join(common, pointerName);
  if (pointer && fs.existsSync(pointer)) {
    const dir = read(pointer).recordsDir;
    if (typeof dir !== "string" || !path.isAbsolute(dir))
      throw Error(`Invalid AgentBridge pointer ${pointer}`);
    const found = { dir, mode: "shared", pointer };
    resolved.set(cwd, found);
    return found;
  }
  return { dir: inRepo, mode: "repository" };
}
export const root = (cwd) => locate(cwd).dir;
export const digest = (value) =>
  crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export function file(cwd, kind, id) {
  if (!/^[a-z]+-(?:[a-f0-9]{8}|[a-f0-9]{8}-[a-f0-9-]{27})$/.test(id))
    throw Error("Invalid ID");
  return path.join(root(cwd), kind, `${id}.json`);
}
export const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
export function resolveTaskId(cwd, id) {
  const m = /^(?:task-)?([a-f0-9][a-f0-9-]{5,35})$/.exec(id || "");
  if (!m) return id;
  let dir;
  try {
    dir = path.join(root(cwd), "tasks");
  } catch {
    return id;
  }
  if (!fs.existsSync(dir)) return id;
  if (fs.existsSync(path.join(dir, `${id}.json`))) return id;
  const hits = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f.startsWith(`task-${m[1]}`)).map((f) => f.slice(0, -5));
  if (hits.length > 1) throw Error(`${id} matches ${hits.length} tasks (${hits.slice(0, 3).join(", ")}${hits.length > 3 ? ", …" : ""}); give more of the id`);
  return hits[0] || id;
}
export function atomic(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, p);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
export function ensure(cwd) {
  ensureAt(root(cwd));
}
export function ensureAt(dir) {
  const p = path.join(dir, "project.json");
  if (!fs.existsSync(p))
    throw Error("Not initialized. Run agentbridge init first.");
  if (read(p).schema !== 2)
    throw Error("Legacy project: run agentbridge migrate first.");
}
export function lock(cwd, name = "write") {
  const p = path.join(root(cwd), "local", `${name}.lock`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(p, "wx", 0o600);
  } catch (e) {
    if (e.code === "EEXIST")
      throw Error(
        `Project ${name} lock exists. Wait or use recover after the owning process stops.`,
      );
    throw e;
  }
  fs.writeFileSync(
    fd,
    JSON.stringify({ pid: process.pid, host: os.hostname(), at: now() }),
  );
  fs.closeSync(fd);
  return () => fs.unlinkSync(p);
}
export function recoverLock(cwd, name) {
  if (!["write", "execution"].includes(name)) throw Error("Unknown lock");
  const p = path.join(root(cwd), "local", `${name}.lock`),
    owner = read(p);
  if (owner.host !== os.hostname())
    throw Error("Lock belongs to another host; inspect manually");
  try {
    process.kill(owner.pid, 0);
    throw Error("Owning process is still running");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
  fs.unlinkSync(p);
  return owner;
}
export function task(cwd, id) {
  ensure(cwd);
  return read(file(cwd, "tasks", id));
}
export function tasks(cwd) {
  ensure(cwd);
  return fs
    .readdirSync(path.join(root(cwd), "tasks"))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => read(path.join(root(cwd), "tasks", f)));
}
export function saveTask(cwd, t) {
  ensure(cwd);
  const release = lock(cwd);
  try {
    const current = task(cwd, t.id);
    if (t.version !== current.version)
      throw Error("Concurrent update: reload task before saving");
    t.version++;
    t.updatedAt = now();
    atomic(file(cwd, "tasks", t.id), t);
    return t;
  } finally {
    release();
  }
}
export function unmerged(record) {
  if (record.mergeConflicts?.length)
    throw Error(
      `${record.id} has unresolved merge conflicts (${record.mergeConflicts.map((c) => c.field).join(", ")}); run agentbridge resolve-merge ${record.id} FIELD ours|theirs --actor NAME`,
    );
}
export function mutate(cwd, id, fn) {
  ensure(cwd);
  const release = lock(cwd);
  try {
    const t = task(cwd, id);
    unmerged(t);
    const result = fn(t);
    t.version++;
    t.updatedAt = now();
    atomic(file(cwd, "tasks", id), t);
    return result === undefined ? t : result;
  } finally {
    release();
  }
}
let provenance = null;
export function setProvenance(by) {
  provenance = by;
}
let signer = null;
export function setSigner(fn) {
  signer = fn;
}
export function event(t, event, details = {}) {
  const e = { id: uid("event"), at: now(), event, ...details, ...(provenance ? { by: provenance } : {}) };
  const sig = signer?.(t.id, e);
  if (sig) e.sig = sig;
  t.history.push(e);
}
export function idle(t) {
  if (t.activeRun)
    throw Error("Task has an active run; finish or recover it first");
}
export function owner(t, actor) {
  if (!actor?.trim() || actor !== t.owner)
    throw Error(
      `Task is owned by ${t.owner || "nobody"}; claim it or acknowledge the handoff first`,
    );
}
