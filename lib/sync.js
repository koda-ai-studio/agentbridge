import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import * as s from "./store.js";
import * as c from "./core.js";
import { mergeRecords } from "./merge.js";

export const branch = "agentbridge-records";
const run = (cwd, args, input) => spawnSync("git", args, { cwd, encoding: "utf8", input, timeout: 60000 });
const must = (cwd, args, what) => {
  const r = run(cwd, args);
  if (r.status !== 0) throw Error(`${what}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
};

export const syncDir = (top) => path.join(s.gitCommonDir(top), branch);
const remoteRef = (remote) => `refs/remotes/${remote}/${branch}`;
const has = (cwd, ref) => run(cwd, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]).status === 0;

export function isSynced(top) {
  try {
    return s.locate(top).dir === syncDir(top) && fs.existsSync(path.join(syncDir(top), ".git"));
  } catch {
    return false;
  }
}

function fetch(top, remote) {
  const r = run(top, ["fetch", "-q", remote, `+refs/heads/${branch}:${remoteRef(remote)}`]);
  if (r.status === 0) return true;
  if (/couldn't find remote ref|could not find remote ref/i.test(r.stderr)) return false;
  throw Error(`git fetch ${remote}: ${r.stderr.trim()}`);
}

function commitAll(dir, message) {
  must(dir, ["add", "-A"], "git add");
  if (run(dir, ["diff", "--cached", "--quiet"]).status === 0) return null;
  const tree = must(dir, ["write-tree"], "git write-tree");
  const parent = must(dir, ["rev-parse", "HEAD"], "git rev-parse");
  const commit = must(dir, ["commit-tree", tree, "-p", parent, "-m", message], "git commit-tree");
  must(dir, ["update-ref", `refs/heads/${branch}`, commit, parent], "git update-ref");
  return commit;
}

const show = (dir, rev, file) => {
  const r = run(dir, ["show", `${rev}:${file}`]);
  return r.status === 0 ? r.stdout : null;
};
const changed = (dir, from, to) =>
  new Set(must(dir, ["diff", "--name-only", "--no-renames", "-z", from, to], "git diff").split("\0").filter(Boolean));

function mergeRemote(dir, remote) {
  const ours = must(dir, ["rev-parse", "HEAD"], "git rev-parse");
  const theirs = must(dir, ["rev-parse", remoteRef(remote)], "git rev-parse");
  if (run(dir, ["merge-base", "--is-ancestor", theirs, ours]).status === 0) return { pulled: 0, conflicts: 0 };
  if (run(dir, ["merge-base", "--is-ancestor", ours, theirs]).status === 0) {
    const files = changed(dir, ours, theirs).size;
    must(dir, ["merge", "--ff-only", "-q", theirs], "git merge --ff-only");
    return { pulled: files, conflicts: 0 };
  }
  const base = must(dir, ["merge-base", ours, theirs], "git merge-base");
  const mine = changed(dir, base, ours), other = changed(dir, base, theirs);
  let conflicts = 0;
  const at = s.now();
  for (const file of other) {
    const target = path.join(dir, file);
    const t = show(dir, theirs, file);
    if (!mine.has(file)) {
      if (t === null) fs.rmSync(target, { force: true });
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, t);
      }
      continue;
    }
    const o = show(dir, ours, file);
    if (t === null || o === null || !file.endsWith(".json")) continue;
    const b = show(dir, base, file);
    const merged = mergeRecords(b === null ? null : JSON.parse(b), JSON.parse(o), JSON.parse(t), at);
    conflicts += merged.conflicts;
    fs.writeFileSync(target, JSON.stringify(merged.record, null, 2) + "\n");
  }
  must(dir, ["add", "-A"], "git add");
  const tree = must(dir, ["write-tree"], "git write-tree");
  const commit = must(dir, ["commit-tree", tree, "-p", ours, "-p", theirs, "-m", "agentbridge: merge records"], "git commit-tree");
  must(dir, ["update-ref", `refs/heads/${branch}`, commit, ours], "git update-ref");
  return { pulled: other.size, conflicts };
}

const seenFile = (dir) => path.join(dir, "local", "remote-seen");

function checkHistory(top, dir, remote, acceptRewrite) {
  const file = seenFile(dir);
  if (!fs.existsSync(file) || acceptRewrite) return;
  const seen = fs.readFileSync(file, "utf8").trim();
  if (!seen || run(top, ["cat-file", "-e", `${seen}^{commit}`]).status !== 0) return;
  const now = must(top, ["rev-parse", remoteRef(remote)], "git rev-parse");
  if (run(top, ["merge-base", "--is-ancestor", seen, now]).status === 0) return;
  throw Error(
    `${remote}/${branch} history was rewritten: ${seen.slice(0, 12)}, which this clone already synced, is no longer in it. ` +
      `Nothing was merged. Inspect with: git log --oneline ${seen.slice(0, 12)} ${remoteRef(remote)} -- ; ` +
      `if the rewrite was intended, run agentbridge sync --accept-rewrite (your copies of records it dropped are kept and pushed back).`,
  );
}

export function sync(top, { remote = "origin", attempts = 3, acceptRewrite = false } = {}) {
  if (!isSynced(top)) throw Error("Records are not on a sync branch. Run agentbridge sync --init first.");
  const dir = syncDir(top);
  let pulled = 0, conflicts = 0, committed = false;
  for (let i = 0; i < attempts; i++) {
    const remoteExists = fetch(top, remote);
    if (remoteExists) checkHistory(top, dir, remote, acceptRewrite);
    const release = s.lock(top);
    try {
      committed = !!commitAll(dir, "agentbridge: record changes") || committed;
      if (remoteExists) {
        const m = mergeRemote(dir, remote);
        pulled += m.pulled;
        conflicts += m.conflicts;
      }
    } finally {
      release();
    }
    const push = run(top, ["push", "-q", remote, `refs/heads/${branch}:refs/heads/${branch}`]);
    if (push.status === 0) {
      fs.mkdirSync(path.join(dir, "local"), { recursive: true });
      fs.writeFileSync(path.join(dir, "local", "last-sync"), s.now());
      fs.writeFileSync(seenFile(dir), must(dir, ["rev-parse", "HEAD"], "git rev-parse"));
      return { synced: true, committed, pulled, conflicts, remote };
    }
    if (!/rejected|non-fast-forward|fetch first/i.test(push.stderr)) throw Error(`git push ${remote}: ${push.stderr.trim()}`);
  }
  throw Error(`Could not push records after ${attempts} attempts; someone else is syncing. Run agentbridge sync again.`);
}

const recordFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== "local" && e.name !== "evidence" && !e.name.endsWith(".tmp"));

const historyIds = (r) => new Set((r.history || []).map((e) => e.id));

function ancestor(dir, file, mine) {
  for (const rev of must(dir, ["log", "--format=%H", "--", file], "git log").split("\n").filter(Boolean)) {
    const text = show(dir, rev, file);
    if (text === null) continue;
    const record = JSON.parse(text);
    if ([...historyIds(record)].every((id) => mine.has(id))) return record;
  }
  return null;
}

function foldIn(from, to) {
  const out = { added: 0, merged: 0, stale: 0, conflicts: 0 };
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
      if (!rel && (e.name === "local" || e.name.startsWith("."))) continue;
      if (e.name.endsWith(".tmp")) continue;
      const r = path.join(rel, e.name), src = path.join(from, r), dst = path.join(to, r);
      if (e.isDirectory()) {
        walk(r);
        continue;
      }
      if (!fs.existsSync(dst)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        out.added++;
        continue;
      }
      if (!e.name.endsWith(".json")) continue;
      const mine = JSON.parse(fs.readFileSync(src, "utf8")), shared = JSON.parse(fs.readFileSync(dst, "utf8"));
      const have = historyIds(shared);
      if ([...historyIds(mine)].every((id) => have.has(id))) {
        out.stale++;
        continue;
      }
      const m = mergeRecords(ancestor(to, r, historyIds(mine)), shared, mine, s.now());
      fs.writeFileSync(dst, JSON.stringify(m.record, null, 2) + "\n");
      out.merged++;
      out.conflicts += m.conflicts;
    }
  };
  walk("");
  return out;
}

export function setupSync(top, { remote = "origin" } = {}) {
  must(top, ["remote", "get-url", remote], `No Git remote named ${remote}`);
  const dir = syncDir(top);
  const pointer = path.join(s.gitCommonDir(top), s.pointerName);
  if (isSynced(top)) return { already: true, recordsDir: dir, branch };
  if (fs.existsSync(pointer) && s.read(pointer).recordsDir !== dir)
    throw Error(`This clone is linked to ${s.read(pointer).recordsDir}; sync works with committed or new records`);
  const local = path.join(top, c.dirname);
  const moving = fs.existsSync(path.join(local, "project.json"));
  const remoteExists = fetch(top, remote);
  if (!fs.existsSync(dir)) {
    if (!has(top, `refs/heads/${branch}`)) {
      if (remoteExists) must(top, ["branch", "-q", branch, remoteRef(remote)], "git branch");
      else {
        const empty = must(top, ["mktree"], "git mktree");
        const root = must(top, ["commit-tree", empty, "-m", "agentbridge: records branch"], "git commit-tree");
        must(top, ["update-ref", `refs/heads/${branch}`, root], "git update-ref");
      }
    }
    must(top, ["worktree", "add", "-q", dir, branch], "git worktree add");
  }
  let moved = 0, folded = null;
  if (moving) {
    if (remoteExists && fs.existsSync(path.join(dir, "project.json"))) folded = foldIn(local, dir);
    else
      for (const e of recordFiles(local)) {
        fs.cpSync(path.join(local, e.name), path.join(dir, e.name), { recursive: true });
        moved++;
      }
    if (fs.existsSync(path.join(local, "local")))
      fs.cpSync(path.join(local, "local"), path.join(dir, "local"), { recursive: true, force: false, errorOnExist: false });
  } else if (fs.existsSync(local)) throw Error(`${local} exists but has no project.json`);
  if (moving) {
    if (run(top, ["ls-files", "--error-unmatch", c.dirname]).status === 0) must(top, ["rm", "-r", "-q", "--cached", c.dirname], "git rm --cached");
    fs.rmSync(local, { recursive: true, force: true });
  }
  if (!fs.existsSync(pointer)) c.init(top, { recordsDir: dir });
  s.forgetRoot(top);
  const result = sync(top, { remote });
  return { ...result, recordsDir: dir, branch, joined: remoteExists, moved: folded ? folded.added + folded.merged : moved, folded, removedFromCode: moving };
}

export function status(top, remote = "origin") {
  if (!isSynced(top)) return null;
  const dir = syncDir(top);
  const pending = must(dir, ["status", "--porcelain"], "git status").split("\n").filter(Boolean).length;
  const ahead = has(top, remoteRef(remote)) ? Number(must(dir, ["rev-list", "--count", `${remoteRef(remote)}..HEAD`], "git rev-list")) : null;
  const lastFile = path.join(dir, "local", "last-sync");
  return { pending, ahead, lastSync: fs.existsSync(lastFile) ? fs.readFileSync(lastFile, "utf8").trim() : null };
}

export function autoSync(top, bin, { minIntervalMs = 0, onlyIfChanged = false } = {}) {
  if (!isSynced(top)) return false;
  if (run(top, ["config", "--bool", "--get", "agentbridge.autoSync"]).stdout.trim() === "false") return false;
  const st = status(top);
  if (onlyIfChanged && !st.pending) return false;
  if (minIntervalMs && st.lastSync && Date.now() - Date.parse(st.lastSync) < minIntervalMs) return false;
  const child = spawn(process.execPath, [bin, "sync", "--quiet"], { cwd: top, detached: true, stdio: "ignore" });
  child.unref();
  return true;
}

export function freshen(top, { maxAgeMs = 60000, remote = "origin" } = {}) {
  if (!isSynced(top)) return null;
  if (run(top, ["config", "--bool", "--get", "agentbridge.autoSync"]).stdout.trim() === "false") return null;
  const st = status(top, remote);
  if (st.lastSync && Date.now() - Date.parse(st.lastSync) < maxAgeMs) return { fresh: true, lastSync: st.lastSync };
  let error;
  for (let i = 0; i < 10; i++) {
    try {
      sync(top, { remote, attempts: 2 });
      return { fresh: true, lastSync: status(top, remote).lastSync };
    } catch (e) {
      error = e.message;
      if (!/lock exists/.test(error)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  return { fresh: false, lastSync: st.lastSync, error };
}
