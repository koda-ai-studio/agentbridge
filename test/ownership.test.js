import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as c from "../lib/core.js";
import * as co from "../lib/coordination.js";
import * as st from "../lib/store.js";
import * as team from "../lib/team.js";
import { git } from "../lib/git.js";
import { conforms } from "./schema.js";

function repo(t) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-own-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src/pay.js"), "export {};\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "init"]);
  c.init(cwd);
  return cwd;
}
const cli = (cwd, args, { env = {}, input } = {}) =>
  spawnSync(process.execPath, [path.resolve("bin/agentbridge.js"), ...args], { cwd, encoding: "utf8", timeout: 15000, input, env: { ...process.env, ...env } });
const editHook = (cwd, actor, file) =>
  cli(cwd, ["hook", "pre-edit", "--actor", actor], { input: JSON.stringify({ hook_event_name: "PreToolUse", cwd, tool_name: "Edit", tool_input: { file_path: path.join(cwd, file) } }) });
function age(cwd, id, hours) {
  const p = path.join(st.root(cwd), "tasks", `${id}.json`);
  const t = st.read(p);
  t.updatedAt = new Date(Date.now() - hours * 36e5).toISOString();
  fs.writeFileSync(p, JSON.stringify(t, null, 2));
}

test("by default the edit hook warns the agent whose file it is and lets the edit go ahead", (t) => {
  const cwd = repo(t);
  const task = c.addTask(cwd, "Fix pay", "ok", "claude", ["src/pay.js"]);
  c.setStatus(cwd, task.id, "in_progress", "claude");
  assert.equal(c.ownershipMode(cwd), "warn");
  const r = editHook(cwd, "codex", "src/pay.js");
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"], "no permission decision: the user's own permission flow still applies");
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /claude is working on src\/pay\.js \(task "Fix pay", [0-9a-f]{8}, working\); last active within the hour\. The edit goes ahead/);
  assert.match(out.hookSpecificOutput.additionalContext, /claude releases it with agentbridge task close [0-9a-f]{8}/);
  const own = editHook(cwd, "claude", "src/pay.js");
  assert.deepEqual([own.status, own.stdout], [0, ""], "the owner's own edits stay silent");
  const check = co.checkPaths(cwd, "codex", ["src/pay.js"]);
  assert.equal(check.allowed, false, "check still reports the file as someone else's");
  assert.equal(check.mode, "warn");
  conforms(check, "check");
});

test("policy ownership block makes the hooks refuse; only a person sets it", (t) => {
  const cwd = repo(t);
  const task = c.addTask(cwd, "Fix pay", "ok", "claude", ["src/pay.js"]);
  c.setStatus(cwd, task.id, "in_progress", "claude");
  const agent = cli(cwd, ["policy", "ownership", "block", "--actor", "codex"]);
  assert.notEqual(agent.status, 0);
  assert.match(agent.stderr, /agent/);
  assert.notEqual(cli(cwd, ["policy", "ownership", "sometimes", "--actor", "alice"]).status, 0);
  const set = cli(cwd, ["policy", "ownership", "block", "--actor", "alice"]);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(c.ownershipMode(cwd), "block");
  const r = editHook(cwd, "codex", "src/pay.js");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Do not edit it\. .*agentbridge release [0-9a-f]{8} --reason/);
  fs.writeFileSync(path.join(cwd, "src/pay.js"), "x");
  git(cwd, ["add", "src/pay.js"]);
  assert.equal(cli(cwd, ["hook", "pre-commit"], { env: { AGENTBRIDGE_ACTOR: "codex" } }).status, 1);
  assert.equal(cli(cwd, ["policy", "ownership", "warn", "--actor", "alice"]).status, 0);
  const commit = cli(cwd, ["hook", "pre-commit"], { env: { AGENTBRIDGE_ACTOR: "codex" } });
  assert.equal(commit.status, 0, "warn mode lets the commit through");
  assert.match(commit.stderr, /committing files others are working on, as codex .*not blocking/);
  const events = st.read(path.join(st.root(cwd), "project.json")).history.filter((e) => e.event === "policy_changed");
  assert.deepEqual(events.map((e) => [e.actor, e.ownership]), [["alice", "block"], ["alice", "warn"]], "each change is recorded with who made it");
});

test("a claim idle for a day stops blocking edits and claims, and check says why", (t) => {
  const cwd = repo(t);
  team.setPolicy(cwd, "ownership", "block", "alice");
  const task = c.addTask(cwd, "Fix pay", "ok", "claude", ["src/pay.js"]);
  c.setStatus(cwd, task.id, "in_progress", "claude");
  age(cwd, task.id, c.idleHours - 1);
  assert.equal(co.checkPaths(cwd, "codex", ["src/pay.js"]).allowed, false, "a claim active within the day still holds");
  assert.throws(() => c.addTask(cwd, "Also pay", "ok", "codex", ["src/pay.js"], "", { exclusive: true }), /already working on these files/);
  age(cwd, task.id, c.idleHours + 1);
  const r = co.checkPaths(cwd, "codex", ["src/pay.js"]);
  assert.equal(r.allowed, true);
  assert.deepEqual(r.released.map((x) => [x.task, x.reason]), [[task.id, "idle"]]);
  conforms(r, "check");
  const hook = editHook(cwd, "codex", "src/pay.js");
  assert.equal(hook.status, 0);
  assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /src\/pay\.js is free to edit\. claude's task "Fix pay" \([0-9a-f]{8}\) still lists it, but it has had no activity since/);
  const mine = c.addTask(cwd, "Also pay", "ok", "codex", ["src/pay.js"], "", { exclusive: true });
  assert.equal(c.setStatus(cwd, mine.id, "in_progress", "codex").status, "in_progress", "an idle claim does not stop others starting");
  assert.equal(c.task(cwd, task.id).status, "in_progress", "the idle task itself is left alone");
});

test("a person releases a stale claim with a reason; the owner sees who and why", (t) => {
  const cwd = repo(t);
  const task = c.addTask(cwd, "Fix pay", "ok", "claude", ["src/pay.js"]);
  c.setStatus(cwd, task.id, "in_progress", "claude");
  const short = task.id.slice(5, 13);
  assert.match(cli(cwd, ["release", short, "--actor", "bob"]).stderr, /Say why/);
  const agent = cli(cwd, ["release", short, "--reason", "stale", "--actor", "codex"]);
  assert.notEqual(agent.status, 0, "agents cannot release others' claims");
  assert.match(cli(cwd, ["release", short, "--reason", "stale"], { env: { CLAUDECODE: "1" } }).stderr, /session/);
  const r = cli(cwd, ["release", short, "--reason", "PR merged yesterday, task left open", "--actor", "bob"]);
  assert.equal(r.status, 0, r.stderr);
  const after = c.task(cwd, task.id);
  assert.deepEqual(after.scope, []);
  assert.equal(after.status, "in_progress", "release frees files; it does not close or move the task");
  assert.equal(after.owner, "claude");
  const e = after.history.at(-1);
  assert.deepEqual([e.event, e.actor, e.reason, e.scope, e.for], ["released", "bob", "PR merged yesterday, task left open", ["src/pay.js"], "claude"]);
  assert.equal(co.checkPaths(cwd, "codex", ["src/pay.js"]).allowed, true);
  assert.ok(co.inbox(cwd, "claude").changes.some((x) => x.event === "released" && x.actor === "bob"), "the owner's inbox shows it");
  assert.match(cli(cwd, ["release", short, "--reason", "again", "--actor", "bob"]).stderr, /holds no files/);
  c.cancel(cwd, task.id, "claude", "done");
  assert.match(cli(cwd, ["release", short, "--reason", "x", "--actor", "bob"]).stderr, /already cancelled/);
});

test("editing claims what an agent actually touches, only when it has exactly one task in progress", (t) => {
  const cwd = repo(t);
  fs.writeFileSync(path.join(cwd, "src/cart.js"), "export {};\n");
  assert.equal(editHook(cwd, "codex", "src/cart.js").stdout, "", "no task in progress: nothing is guessed");
  const task = c.addTask(cwd, "Cart totals", "ok", "codex", ["src/pay.js"]);
  c.setStatus(cwd, task.id, "in_progress", "codex");
  const r = editHook(cwd, "codex", "src/cart.js");
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /added src\/cart\.js to your task "Cart totals"/);
  const after = c.task(cwd, task.id);
  assert.deepEqual(after.scope, ["src/pay.js", "src/cart.js"]);
  assert.deepEqual([after.history.at(-1).event, after.history.at(-1).added], ["scope_inferred", ["src/cart.js"]]);
  assert.equal(co.checkPaths(cwd, "claude", ["src/cart.js"]).allowed, false, "others now see who is on it");
  assert.equal(editHook(cwd, "codex", "src/cart.js").stdout, "", "editing it again adds nothing");
  assert.equal(c.task(cwd, task.id).version, after.version, "and writes nothing while the claim is fresh");
  const second = c.addTask(cwd, "Docs", "ok", "codex", ["docs"]);
  c.setStatus(cwd, second.id, "in_progress", "codex");
  fs.writeFileSync(path.join(cwd, "src/tax.js"), "export {};\n");
  assert.equal(editHook(cwd, "codex", "src/tax.js").stdout, "", "two tasks in progress: ambiguous, so nothing is claimed");
  assert.deepEqual(co.checkPaths(cwd, "claude", ["src/tax.js"]).unclaimed, ["src/tax.js"]);
  assert.ok(!co.inbox(cwd, "claude").changes.some((x) => x.event === "active"));
});

test("an owner editing its own files keeps an old claim from going idle", (t) => {
  const cwd = repo(t);
  const task = c.addTask(cwd, "Fix pay", "ok", "claude", ["src/pay.js"]);
  c.setStatus(cwd, task.id, "in_progress", "claude");
  age(cwd, task.id, c.idleHours + 2);
  assert.equal(co.checkPaths(cwd, "codex", ["src/pay.js"]).allowed, true, "idle before the owner touches it");
  assert.equal(editHook(cwd, "claude", "src/pay.js").status, 0);
  assert.equal(c.task(cwd, task.id).history.at(-1).event, "active");
  assert.equal(co.checkPaths(cwd, "codex", ["src/pay.js"]).allowed, false, "held again once its owner is editing");
});

test("help shows the core loop; help all lists every command, older forms marked", (t) => {
  const cwd = repo(t);
  const short = cli(cwd, ["--help"]).stdout;
  assert.match(short, /release TASK --reason/);
  assert.match(short, /policy ownership warn\|block/);
  assert.doesNotMatch(short, /test configure|pr publish|approvals \[--verify\]/, "optional verification stays out of the short help");
  const all = cli(cwd, ["help", "all"]).stdout;
  for (const cmd of ["test configure", "pr publish", "approvals", "release ID", "resolve-merge", "Older forms: task close"]) assert.ok(all.includes(cmd), cmd);
});
