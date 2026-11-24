import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as c from "../lib/core.js";
import * as team from "../lib/team.js";
import { mergeRecords } from "../lib/merge.js";
import { git } from "../lib/git.js";

const bin = path.resolve("bin/agentbridge.js");
const tmp = (t, p) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
function fakeGh(t) {
  const dir = tmp(t, "agentbridge-fakegh-"), f = path.join(dir, "gh");
  fs.writeFileSync(f, `#!${process.execPath}\nif (process.argv[2] === "api" && process.argv[3] === "user") process.stdout.write((process.env.FAKE_LOGIN || "") + " " + (process.env.FAKE_ID ?? "1001") + "\\n"); else process.exit(1);\n`, { mode: 0o755 });
  return f;
}
const configure = (dir) => {
  git(dir, ["config", "user.email", "test@example.invalid"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
};
function clone(t, origin, name) {
  const dir = path.join(tmp(t, `agentbridge-${name}-`), "repo");
  git(path.dirname(dir), ["clone", "-q", origin, dir]);
  configure(dir);
  return dir;
}
const as = (gh, login) => (cwd, ...args) =>
  spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", timeout: 15000, env: { ...process.env, AGENTBRIDGE_GH_BIN: gh, FAKE_LOGIN: login } });
const json = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

function team2(t) {
  const origin = path.join(tmp(t, "agentbridge-origin-"), "o.git");
  git(path.dirname(origin), ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = clone(t, origin, "seed");
  fs.writeFileSync(path.join(seed, "app.js"), "export {};\n");
  c.init(seed);
  git(seed, ["add", "."]);
  git(seed, ["commit", "-qm", "init"]);
  git(seed, ["push", "-q", "origin", "main"]);
  const gh = fakeGh(t);
  return { origin, gh, seed };
}

test("setup takes identity from GitHub; actors are login or login/agent and cannot impersonate", (t) => {
  const { origin, gh } = team2(t);
  const dir = clone(t, origin, "alice");
  const ab = as(gh, "alice-gh");
  const s = json(ab(dir, "setup"));
  assert.deepEqual([s.login, s.mode], ["alice-gh", "repository"]);
  assert.match(fs.readFileSync(path.join(dir, ".agentbridge/.gitattributes"), "utf8"), /merge=agentbridge/);
  assert.equal(json(ab(dir, "whoami", "--actor", "codex")).actor, "alice-gh/codex");
  const task = json(ab(dir, "task", "add", "Checkout", "--criteria", "Pays", "--actor", "codex", "--scope", "app.js"));
  assert.equal(task.owner, "alice-gh/codex", "a bare agent name is the user's agent");
  assert.equal(json(ab(dir, "task", "add", "Mine", "--criteria", "ok")).owner, "alice-gh", "no --actor means the person");
  const spoof = ab(dir, "task", "add", "X", "--criteria", "ok", "--actor", "bob-gh");
  assert.notEqual(spoof.status, 0);
  assert.match(spoof.stderr, /acts as alice-gh/);
  const offered = json(ab(dir, "handoff", "offer", task.id, "--actor", "codex", "--to", "bob-gh/codex", "--next", "Review"));
  assert.equal(offered.pendingHandoff.to, "bob-gh/codex", "other people's agents are named in full");
  assert.equal(json(ab(dir, "handoff", "offer", json(ab(dir, "task", "add", "Y", "--criteria", "ok")).id, "--to", "claude", "--next", "go")).pendingHandoff.to, "alice-gh/claude");
  const d = json(ab(dir, "decision", "propose", "Mobile first", "--why", "Phones", "--actor", "codex"));
  const agentAccept = ab(dir, "decision", "accept", d.id, "--actor", "codex");
  assert.notEqual(agentAccept.status, 0);
  assert.match(agentAccept.stderr, /only people accept/);
  assert.equal(json(ab(dir, "decision", "accept", d.id)).acceptedBy, "alice-gh");
  assert.equal(git(dir, ["config", "--get", "merge.agentbridge.driver"]).includes("merge-driver %O %A %B %P"), true);
  assert.notEqual(as(gh, "bad login!")(dir, "setup").status, 0);
});

test("clones without setup keep plain actor names", (t) => {
  const { seed } = team2(t);
  const ab = as("/nonexistent", "");
  assert.equal(json(ab(seed, "task", "add", "Legacy", "--criteria", "ok", "--actor", "codex")).owner, "codex");
  assert.equal(json(ab(seed, "whoami")).login, null);
});

test("record merges combine both people's work and only freeze on a real disagreement", (t) => {
  const { origin, gh, seed } = team2(t);
  const aliceAb = as(gh, "alice-gh"), bobAb = as(gh, "bob-gh");
  const task = json(aliceAb(seed, "task", "add", "Checkout", "--criteria", "Pays", "--scope", "app.js", "--actor", "alice-gh"));
  git(seed, ["add", "."]);
  git(seed, ["commit", "-qm", "task"]);
  git(seed, ["push", "-q"]);
  const alice = clone(t, origin, "alice"), alice2 = clone(t, origin, "alice2"), bob = clone(t, origin, "bob");
  json(aliceAb(alice, "setup"));
  json(aliceAb(alice2, "setup"));
  json(bobAb(bob, "setup"));
  const commit = (dir, msg) => {
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", msg]);
  };
  json(aliceAb(alice, "task", "note", task.id, "PR #3 open", "--actor", "alice-gh"));
  json(aliceAb(alice, "finding", "add", task.id, "Rounding error"));
  commit(alice, "alice");
  git(alice, ["push", "-q"]);
  json(bobAb(bob, "finding", "add", task.id, "Missing retry", "--by", "codex"));
  commit(bob, "bob");
  const pull = spawnSync("git", ["pull", "-q", "--no-rebase", "--no-edit"], { cwd: bob, encoding: "utf8" });
  assert.equal(pull.status, 0, pull.stderr);
  const merged = c.task(bob, task.id);
  assert.deepEqual(merged.findings.map((f) => f.description).sort(), ["Missing retry", "Rounding error"]);
  assert.equal(merged.note.text, "PR #3 open");
  assert.ok(!merged.mergeConflicts);
  assert.ok(merged.history.some((e) => e.actor === "bob-gh/codex") && merged.history.some((e) => e.actor === "alice-gh"));
  git(bob, ["push", "-q"]);

  git(alice2, ["pull", "-q"]);
  git(alice, ["pull", "-q", "--no-rebase", "--no-edit"]);
  json(aliceAb(alice2, "task", "scope", task.id, "app.js,lib", "--actor", "alice-gh"));
  commit(alice2, "scope lib");
  git(alice2, ["push", "-q"]);
  json(aliceAb(alice, "task", "scope", task.id, "app.js,web", "--actor", "alice-gh"));
  commit(alice, "scope web");
  const clash = spawnSync("git", ["pull", "-q", "--no-rebase", "--no-edit"], { cwd: alice, encoding: "utf8" });
  assert.notEqual(clash.status, 0, "Git reports the disagreement");
  const frozen = c.task(alice, task.id);
  assert.deepEqual(frozen.mergeConflicts.map((x) => [x.field, x.ours, x.theirs]), [["scope", ["app.js", "web"], ["app.js", "lib"]]]);
  const blocked = aliceAb(alice, "task", "note", task.id, "x", "--actor", "alice-gh");
  assert.match(blocked.stderr, /unresolved merge conflicts \(scope\)/);
  assert.deepEqual(team.board(alice).attention[0].reasons.some((r) => r.startsWith("two people changed scope at once; a person picks one: agentbridge resolve-merge")), true);
  assert.match(aliceAb(alice, "resolve-merge", task.id, "scope", "theirs", "--actor", "codex").stderr, /only people accept/);
  const resolved = json(aliceAb(alice, "resolve-merge", task.id, "scope", "theirs"));
  assert.deepEqual(resolved.scope, ["app.js", "lib"]);
  assert.ok(!resolved.mergeConflicts);
  assert.equal(resolved.history.at(-1).event, "merge_resolved");
  commit(alice, "resolved");
  assert.equal(git(alice, ["status", "--porcelain"]), "");
});

test("merge rules: union by id, one-sided changes win, notes take the latest, real clashes are recorded", () => {
  const base = { id: "task-00000001", version: 3, owner: "a", scope: ["x"], status: "planned", history: [{ id: "e1", at: "1" }], findings: [], updatedAt: "1" };
  const ours = { ...base, version: 4, status: "in_progress", history: [...base.history, { id: "e2", at: "3" }], updatedAt: "3", note: { text: "ours", at: "3" } };
  const theirs = { ...base, version: 5, findings: [{ id: "f1", status: "open" }], history: [...base.history, { id: "e3", at: "2" }], updatedAt: "2", note: { text: "theirs", at: "2" } };
  const m = mergeRecords(base, ours, theirs, "9");
  assert.equal(m.conflicts, 0);
  assert.deepEqual([m.record.version, m.record.status, m.record.updatedAt, m.record.note.text], [6, "in_progress", "3", "ours"]);
  assert.deepEqual(m.record.history.map((e) => e.id), ["e1", "e3", "e2"], "history ordered by time");
  assert.deepEqual(m.record.findings.map((f) => f.id), ["f1"]);
  const clash = mergeRecords(base, { ...base, owner: "b" }, { ...base, owner: "c" }, "9");
  assert.equal(clash.conflicts, 1);
  assert.deepEqual(clash.record.mergeConflicts, [{ field: "owner", base: "a", ours: "b", theirs: "c", at: "9" }]);
  const item = mergeRecords(
    { ...base, findings: [{ id: "f1", status: "open" }] },
    { ...base, findings: [{ id: "f1", status: "resolved", by: "x" }] },
    { ...base, findings: [{ id: "f1", status: "resolved", by: "y" }] },
    "9",
  );
  assert.equal(item.record.mergeConflicts[0].field, "findings[f1]");
  const added = mergeRecords(null, { id: "task-00000002", a: 1 }, { id: "task-00000002", a: 1 });
  assert.equal(added.conflicts, 0);
});
