import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as c from "../lib/core.js";
import { commitActor } from "../lib/agents.js";
import { git } from "../lib/git.js";

const bin = path.resolve("bin/agentbridge.js");
function repo(t) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-prov-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  git(cwd, ["commit", "-q", "--allow-empty", "-m", "init"]);
  c.init(cwd);
  return cwd;
}
const claude = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "sess-claude-1" };
const codex = { CODEX_THREAD_ID: "thread-codex-9" };
const run = (cwd, env, ...args) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", timeout: 15000, env: { ...process.env, ...env } });
const ok = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const last = (record) => record.history.at(-1);

test("every recorded action names the agent and exact session it came from", (t) => {
  const cwd = repo(t);
  const task = ok(run(cwd, claude, "task", "add", "Canvas", "--criteria", "Renders", "--actor", "claude", "--scope", "ui"));
  assert.deepEqual(task.history[0].by, { via: "agent", agent: "claude", session: "sess-claude-1", branch: "main" });
  ok(run(cwd, claude, "handoff", "offer", task.id, "--actor", "claude", "--to", "codex", "--next", "Finish"));
  const got = ok(run(cwd, codex, "handoff", "receive", task.id, "--actor", "codex"));
  assert.deepEqual(last(got).by, { via: "agent", agent: "codex", session: "thread-codex-9", branch: "main" });
  const typed = ok(run(cwd, {}, "task", "add", "Mine", "--criteria", "ok", "--actor", "alice"));
  assert.deepEqual(typed.history[0].by, { via: "terminal", branch: "main" }, "no agent session: typed by a person");
  assert.ok(new Set(c.task(cwd, task.id).history.map((e) => e.id)).size === c.task(cwd, task.id).history.length, "event ids are unique");
});

test("inside an agent session, actions run as that agent: no other agent's or person's name, no approvals", (t) => {
  const cwd = repo(t);
  for (const name of ["codex", "alice"]) {
    const r = run(cwd, claude, "task", "add", "X", "--criteria", "ok", "--actor", name);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`inside a claude session, so it acts as claude, not ${name}`));
  }
  ok(run(cwd, claude, "task", "add", "Review lane", "--criteria", "ok", "--actor", "claude-review"));
  const d = ok(run(cwd, claude, "decision", "propose", "Mobile first", "--why", "Phones", "--actor", "claude"));
  const approve = run(cwd, claude, "decision", "accept", d.id, "--actor", "claude");
  assert.notEqual(approve.status, 0);
  assert.match(approve.stderr, /Only people accept, and this runs inside a claude session/);
  assert.notEqual(run(cwd, { AI_AGENT: "cursor_1_agent" }, "decision", "accept", d.id, "--actor", "cursor").status, 0, "other agents that announce themselves are covered");
  const solo = run(cwd, {}, "decision", "accept", d.id, "--actor", "codex");
  assert.match(solo.stderr, /codex is an agent; only people accept/, "agent names cannot approve even from a terminal");
  const accepted = ok(run(cwd, {}, "decision", "accept", d.id, "--actor", "alice"));
  assert.equal(accepted.acceptedBy, "alice");
  assert.deepEqual(last(accepted).by, { via: "terminal", branch: "main" });
});

test("commits made inside an agent session are checked as that agent", (t) => {
  const cwd = repo(t);
  assert.deepEqual(commitActor(cwd, claude), { actor: "claude", source: "claude session" });
  assert.deepEqual(commitActor(cwd, { ...claude, AGENTBRIDGE_ACTOR: "codex" }).actor, "codex", "an explicit actor still wins");
  assert.equal(commitActor(cwd, {}).actor, null);
});

test("with GitHub identity set up, events carry the numeric GitHub id, which survives login renames", (t) => {
  const cwd = repo(t);
  git(cwd, ["config", "agentbridge.login", "alice-gh"]);
  git(cwd, ["config", "agentbridge.githubId", "583231"]);
  const task = ok(run(cwd, claude, "task", "add", "Canvas", "--criteria", "ok", "--actor", "claude"));
  assert.equal(task.owner, "alice-gh/claude");
  assert.deepEqual(task.history[0].by, { via: "agent", agent: "claude", session: "sess-claude-1", github: 583231, branch: "main" });
});
