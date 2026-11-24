import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as c from "../lib/core.js";
import * as co from "../lib/coordination.js";
import * as s from "../lib/store.js";
import { git } from "../lib/git.js";

const tmp = (t, prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
function repo(t) {
  const cwd = tmp(t, "agentbridge-shared-repo-");
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(cwd, "ui/lib"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "ui/lib/graph-layout.ts"), "export {};\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "init"]);
  return cwd;
}
function worktree(t, cwd, name) {
  const dir = path.join(tmp(t, `agentbridge-${name}-`), "wt");
  git(cwd, ["worktree", "add", "--detach", dir]);
  return fs.realpathSync(dir);
}

test("records linked once are shared by every worktree and stay out of the repository", (t) => {
  const cwd = repo(t),
    records = path.join(tmp(t, "agentbridge-records-"), "shop-app");
  const linked = c.init(cwd, { recordsDir: records });
  assert.equal(linked.mode, "shared");
  assert.ok(fs.existsSync(path.join(records, "project.json")));
  const codexWt = worktree(t, cwd, "codex"),
    claudeWt = worktree(t, cwd, "claude");
  const canvas = c.addTask(claudeWt, "Canvas", "Renders", "claude", ["ui/lib/graph-*"]);
  const e2e = c.addTask(codexWt, "E2E", "Green", "codex", ["ui/app"]);
  for (const dir of [cwd, codexWt, claudeWt]) {
    assert.deepEqual(c.tasks(dir).map((x) => x.id).sort(), [canvas.id, e2e.id].sort());
    assert.equal(c.where(dir).recordsDir, records);
    assert.equal(c.where(dir).mode, "shared");
  }
  c.offer(claudeWt, canvas.id, "claude", "codex", "Take the canvas");
  assert.deepEqual(co.inbox(codexWt, "codex").incoming.map((x) => x.id), [canvas.id]);
  assert.equal(
    co.checkPaths(codexWt, "codex", [path.join(codexWt, "ui/lib/graph-layout.ts")]).allowed,
    false,
  );
  c.receive(codexWt, canvas.id, "codex");
  assert.equal(c.task(cwd, canvas.id).owner, "codex");
  for (const dir of [cwd, codexWt, claudeWt])
    assert.equal(git(dir, ["status", "--porcelain", "--untracked-files=all"]), "");
  assert.throws(() => c.init(codexWt, { recordsDir: records }), /Already linked/);
});

test("task workspaces work with shared records", (t) => {
  const cwd = repo(t),
    records = path.join(tmp(t, "agentbridge-records-"), "r");
  c.init(cwd, { recordsDir: records });
  const wt = worktree(t, cwd, "agent");
  const task = c.addTask(wt, "Layout", "Works", "claude", ["ui/lib"]);
  const work = c.createWorkspace(wt, task.id, "claude").workspace;
  assert.ok(work.startsWith(records));
  assert.equal(c.workspace(cwd, task.id), work, "workspace mapping is shared too");
  assert.equal(git(cwd, ["status", "--porcelain"]), "");
});

test("another clone on the same machine can join existing records without resetting them", (t) => {
  const cwd = repo(t),
    records = path.join(tmp(t, "agentbridge-records-"), "r");
  c.init(cwd, { recordsDir: records });
  const task = c.addTask(cwd, "Kept", "Kept", "alice");
  const clone = path.join(tmp(t, "agentbridge-clone-"), "c");
  git(cwd, ["clone", "-q", cwd, clone]);
  c.init(clone, { recordsDir: records });
  assert.deepEqual(c.tasks(clone).map((x) => x.id), [task.id]);
});

test("linking rejects ambiguous or unsafe setups", (t) => {
  const cwd = repo(t),
    records = tmp(t, "agentbridge-records-");
  assert.throws(() => c.init(cwd, { recordsDir: "relative/dir" }), /absolute path/);
  const plain = tmp(t, "agentbridge-nogit-");
  assert.throws(() => c.init(plain, { recordsDir: records }), /Git repository/);
  const committed = repo(t);
  c.init(committed);
  assert.throws(
    () => c.init(committed, { recordsDir: records }),
    /already has \.agentbridge/,
  );
  const legacy = path.join(tmp(t, "agentbridge-legacy-"), "r");
  fs.mkdirSync(legacy, { recursive: true });
  s.atomic(path.join(legacy, "project.json"), { schema: 1 });
  assert.throws(() => c.init(cwd, { recordsDir: legacy }), /migrate/);
  const common = s.gitCommonDir(cwd);
  s.atomic(path.join(common, s.pointerName), { recordsDir: "not/absolute" });
  s.forgetRoot(cwd);
  assert.throws(() => c.tasks(cwd), /Invalid AgentBridge pointer/);
});

test("in-repository records win over a link, and the environment can point elsewhere", (t) => {
  const cwd = repo(t),
    envRecords = path.join(tmp(t, "agentbridge-env-"), "r");
  const previous = process.env.AGENTBRIDGE_RECORDS;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTBRIDGE_RECORDS;
    else process.env.AGENTBRIDGE_RECORDS = previous;
  });
  process.env.AGENTBRIDGE_RECORDS = envRecords;
  c.init(cwd, { recordsDir: envRecords });
  assert.equal(c.where(cwd).mode, "environment");
  process.env.AGENTBRIDGE_RECORDS = "relative";
  assert.throws(() => c.where(cwd), /absolute path/);
  delete process.env.AGENTBRIDGE_RECORDS;
  assert.equal(c.where(cwd).mode, "shared");
  const own = repo(t);
  c.init(own);
  assert.equal(c.where(own).mode, "repository");
  assert.match(c.where(own).shared, /through Git/);
});

test("CLI links records and reports where they live from any worktree", (t) => {
  const cwd = repo(t),
    records = path.join(tmp(t, "agentbridge-records-"), "r");
  const bin = path.resolve("bin/agentbridge.js");
  const run = (dir, ...args) =>
    spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: "utf8", timeout: 15000 });
  assert.equal(run(cwd, "init", "--records-dir", records).status, 0);
  const wt = worktree(t, cwd, "cli");
  const where = JSON.parse(run(wt, "where").stdout);
  assert.equal(where.recordsDir, records);
  assert.equal(where.initialized, true);
  const added = run(wt, "task", "add", "From worktree", "--criteria", "ok", "--actor", "codex");
  assert.equal(added.status, 0, added.stderr);
  assert.equal(JSON.parse(run(cwd, "task", "list").stdout).length, 1);
  assert.notEqual(run(cwd, "init", "--records-dir", "rel").status, 0);
});
