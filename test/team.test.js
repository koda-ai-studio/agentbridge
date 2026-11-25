import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as c from "../lib/core.js";
import * as co from "../lib/coordination.js";
import * as team from "../lib/team.js";
import * as w from "../lib/workflow.js";
import * as st from "../lib/store.js";
import { git } from "../lib/git.js";
import { conforms } from "./schema.js";

function repo(t) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-team-")));
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
const cli = (cwd, args, env = {}) =>
  spawnSync(process.execPath, [path.resolve("bin/agentbridge.js"), ...args], {
    cwd, encoding: "utf8", timeout: 15000, env: { ...process.env, ...env },
  });
async function verifiedTask(cwd, owner = "alice") {
  const task = c.addTask(cwd, "Checkout", "Pays", owner, ["src"], "PROJ-1");
  c.configureTest(cwd, task.id, owner, "noop", [process.execPath, "-e", ""], ["c1"]);
  const work = c.createWorkspace(cwd, task.id, owner).workspace;
  fs.writeFileSync(path.join(work, "src/pay.js"), "export const pay = 1;\n");
  git(work, ["commit", "-am", "Pay"]);
  w.recordImplementation(cwd, task.id, owner, "claude", "Pay");
  await w.review(cwd, task.id, owner, "codex", { invoke: async () => ({ outcome: "pass", summary: "ok", findings: [] }) });
  await w.runTests(cwd, task.id, owner);
  c.setStatus(cwd, task.id, "verified", owner);
  return { task, work };
}

test("assigning creates the task and offers it; it moves only when the assignee accepts", (t) => {
  const cwd = repo(t);
  const r = cli(cwd, ["task", "add", "Webhook retries", "--criteria", "Retries 3x", "--actor", "alice", "--to", "bob", "--scope", "src", "--ref", "PROJ-7"]);
  assert.equal(r.status, 0, r.stderr);
  const task = JSON.parse(r.stdout);
  assert.equal(task.owner, "alice", "the assigner stays accountable until accepted");
  assert.deepEqual([task.pendingHandoff.to, task.pendingHandoff.next], ["bob", team.defaultAssignNext]);
  assert.deepEqual(co.inbox(cwd, "bob").incoming.map((x) => [x.id, x.ref]), [[task.id, "PROJ-7"]]);
  assert.equal(team.board(cwd).people.find((p) => p.actor === "bob").offered[0].id, task.id);
  c.receive(cwd, task.id, "bob");
  const bob = team.board(cwd).people.find((p) => p.actor === "bob");
  assert.deepEqual([bob.tasks.map((x) => x.id), bob.offered], [[task.id], []]);
  const custom = team.assign(cwd, "Docs", "ok", "alice", "codex", { next: "Start with the README" });
  assert.equal(custom.pendingHandoff.next, "Start with the README");
  assert.throws(() => team.assign(cwd, "Self", "ok", "alice", "alice"), /someone else/);
  assert.notEqual(cli(cwd, ["task", "add", "Self", "--criteria", "ok", "--actor", "alice", "--to", "alice"]).status, 0);
});

test("board shows each owner's work, pending offers, what waits for a person and what needs attention", async (t) => {
  const cwd = repo(t);
  const { task: verified } = await verifiedTask(cwd);
  const canvas = c.addTask(cwd, "Canvas", "Renders", "claude", ["ui/*"]);
  c.note(cwd, canvas.id, "claude", "PR #6382 green");
  const flaky = c.addTask(cwd, "Flaky test", "Stable", "codex", ["tests"]);
  const loose = c.addTask(cwd, "Loose", "ok", "codex");
  c.setStatus(cwd, loose.id, "in_progress", "codex");
  c.reportFinding(cwd, flaky.id, "Order-dependent", "claude");
  const orphan = c.addTask(cwd, "Unowned cleanup", "Clean");
  team.assign(cwd, "E2E", "Green", "claude", "codex");
  c.proposeProjectDecision(cwd, "Mobile first", "Phones", "bob");
  const done = c.addTask(cwd, "Old", "ok", "alice");
  const b = team.board(cwd);
  conforms(b, "board");
  assert.deepEqual(b.people.map((p) => p.actor), ["alice", "claude", "codex"]);
  const claude = b.people.find((p) => p.actor === "claude");
  assert.equal(claude.tasks.find((x) => x.id === canvas.id).note, "PR #6382 green");
  assert.equal(b.people.find((p) => p.actor === "codex").offered[0].from, "claude");
  assert.deepEqual(b.unowned.map((x) => x.id), [orphan.id]);
  assert.deepEqual(b.waitingForPeople.decisions.map((d) => d.summary), ["Mobile first"]);
  assert.deepEqual(b.waitingForPeople.acceptance.map((a) => a.task), [verified.id]);
  assert.deepEqual(b.attention.map((a) => [a.task, a.reasons]), [
    [flaky.id, ["sent back for more work; its owner continues it", "1 open finding for its owner to resolve"]],
    [loose.id, ["working without claiming files, so others may edit them; its owner claims them with task scope"]],
  ]);
  assert.equal(b.done, 0);
  assert.ok(done);
  c.setStatus(cwd, verified.id, "done", "alice");
  assert.equal(team.board(cwd).done, 1);
  c.note(cwd, canvas.id, "claude", "y".repeat(200));
  assert.equal(team.board(cwd).people.find((p) => p.actor === "claude").tasks.find((x) => x.id === canvas.id).note.length, 200, "JSON keeps the full note");
  const text = cli(cwd, ["board"]).stdout;
  assert.ok(text.includes(`${"y".repeat(119)}…`) && !text.includes("y".repeat(120)), "text clips long notes");
  for (const s of ["← offered by claude, not yet accepted: E2E", "[not started] E2E → offered to codex", "Unowned", "decide: Mobile first (proposed by bob)", "Run agentbridge in your own terminal: it asks you about each of these", "Flaky test (codex): sent back for more work; its owner continues it; 1 open finding", "(accept: agentbridge handoff receive ", "1 task done."])
    assert.ok(text.includes(s), s);
  conforms(JSON.parse(cli(cwd, ["board", "--format", "json"]).stdout), "board");
  assert.notEqual(cli(cwd, ["board", "--format", "xml"]).status, 0);
});

test("log is one audit trail across tasks and decisions, newest first, filterable by actor and time", (t) => {
  const cwd = repo(t);
  const task = team.assign(cwd, "Webhook", "ok", "alice", "bob");
  c.receive(cwd, task.id, "bob");
  c.note(cwd, task.id, "bob", "halfway");
  const d = c.proposeProjectDecision(cwd, "Mobile first", "Phones", "bob");
  c.acceptDecision(cwd, d.id, "alice");
  const all = team.log(cwd);
  conforms(all, "log");
  assert.deepEqual(all.entries.map((e) => e.event), ["decision_accepted", "decision_proposed", "noted", "handoff_received", "handoff_offered", "created"]);
  assert.equal(all.entries.find((e) => e.event === "handoff_offered").detail, `to bob: ${team.defaultAssignNext}`);
  assert.equal(all.entries.find((e) => e.event === "noted").detail, "halfway");
  assert.equal(all.entries[0].decision, d.id);
  assert.deepEqual(team.log(cwd, { actor: "bob" }).entries.map((e) => e.event), ["decision_proposed", "noted", "handoff_received"]);
  assert.equal(team.log(cwd, { since: new Date(Date.now() + 60000).toISOString() }).total, 0);
  assert.equal(team.log(cwd, { since: "1h" }).total, 6);
  const limited = team.log(cwd, { limit: 2 });
  assert.deepEqual([limited.total, limited.entries.length], [6, 2]);
  assert.match(team.logText(limited), /4 older entries/);
  assert.throws(() => team.log(cwd, { since: "yesterday" }), /--since/);
  assert.throws(() => team.log(cwd, { limit: 0 }), /--limit/);
  assert.equal(team.parseSince("7d", Date.parse("2026-11-22T00:00:00Z")), "2026-11-15T00:00:00.000Z");
  const text = cli(cwd, ["log", "--actor", "bob"]).stdout;
  assert.match(text, /bob\s+noted\s+Webhook — halfway/);
});

test("PR status reflects verification against the PR head, and failures name the reason", async (t) => {
  const cwd = repo(t);
  const { task, work } = await verifiedTask(cwd);
  const head = git(work, ["rev-parse", "HEAD"]);
  assert.deepEqual(team.prState(team.prSummary(cwd, task.id), head), ["pending", "Verified; waiting for human acceptance"]);
  c.setStatus(cwd, task.id, "done", "alice");
  const summary = team.prSummary(cwd, task.id);
  assert.deepEqual(team.prState(summary, head), ["success", "Verified and accepted by alice"]);
  assert.equal(team.prState(summary, "f".repeat(40))[0], "failure", "checks for another commit do not pass the PR");
  for (const s of ["| Owner | alice |", "| Tracker | PROJ-1 |", `| Verified commit | ${head.slice(0, 7)} |`, "| Accepted by | alice", "Reviewed by alice with codex: pass", "Latest test run: pass"])
    assert.ok(summary.markdown.includes(s), s);
  assert.ok(summary.markdown.startsWith(`<!-- agentbridge:${task.id} -->`));
  c.reportFinding(cwd, task.id, "Rounding | error", "bob");
  const withFinding = team.prSummary(cwd, task.id);
  assert.deepEqual(team.prState(withFinding, head), ["failure", "1 open finding"]);
  assert.match(withFinding.markdown, /- Rounding \| error/);
  const fresh = c.addTask(cwd, "New", "ok", "codex");
  assert.deepEqual(team.prState(team.prSummary(cwd, fresh.id), head), ["pending", "In progress: planned"]);
});

test("pr publish creates then updates one comment and sets an agentbridge commit status through gh", (t) => {
  const cwd = repo(t);
  const task = c.addTask(cwd, "Checkout", "Pays", "alice", ["src"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-gh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = path.join(dir, "calls.jsonl"), comments = path.join(dir, "comments.json");
  fs.writeFileSync(comments, "[]");
  const fake = path.join(dir, "gh");
  fs.writeFileSync(fake, `#!${process.execPath}
const fs = require("fs"), args = process.argv.slice(2);
let input = ""; try { input = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, input }) + "\\n");
const list = JSON.parse(fs.readFileSync(${JSON.stringify(comments)}, "utf8"));
if (args[0] === "pr") process.stdout.write("${"a".repeat(40)}\\n");
else if (args.includes("--paginate")) process.stdout.write(JSON.stringify([list]));
else if (args[2] === "POST" && args[3].endsWith("/comments")) { list.push({ id: 11, body: JSON.parse(input).body }); fs.writeFileSync(${JSON.stringify(comments)}, JSON.stringify(list)); }
else if (args[2] === "PATCH") { list[0].body = JSON.parse(input).body; fs.writeFileSync(${JSON.stringify(comments)}, JSON.stringify(list)); }
`);
  fs.chmodSync(fake, 0o755);
  const env = { AGENTBRIDGE_GH_BIN: fake };
  const first = cli(cwd, ["pr", "publish", task.id, "--pr", "12"], env);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout).status, { state: "pending", description: "In progress: planned" });
  assert.equal(JSON.parse(first.stdout).comment, "created");
  c.note(cwd, task.id, "alice", "ready soon");
  assert.equal(JSON.parse(cli(cwd, ["pr", "publish", task.id, "--pr", "12"], env).stdout).comment, "updated");
  const stored = JSON.parse(fs.readFileSync(comments, "utf8"));
  assert.equal(stored.length, 1, "one comment per task, updated in place");
  assert.match(stored[0].body, /ready soon/);
  const log = fs.readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const status = log.find((x) => x.args[3]?.startsWith("repos/{owner}/{repo}/statuses/"));
  assert.equal(status.args[3], `repos/{owner}/{repo}/statuses/${"a".repeat(40)}`);
  assert.deepEqual(JSON.parse(status.input), { state: "pending", context: "agentbridge", description: "In progress: planned" });
  assert.notEqual(cli(cwd, ["pr", "publish", task.id, "--pr", "abc"], env).status, 0);
  assert.notEqual(cli(cwd, ["pr", "publish", task.id, "--pr", "12"], { AGENTBRIDGE_GH_BIN: "gh" }).status, 0, "relative override rejected");
  assert.match(cli(cwd, ["pr", "summary", task.id]).stdout, /### AgentBridge: Checkout/);
});

test("owners claim paths on received work; overlapping others' active work is refused", (t) => {
  const cwd = repo(t);
  const canvas = c.addTask(cwd, "Canvas", "ok", "claude", ["ui/lib/graph-*"]);
  const handed = team.assign(cwd, "Flaky test", "Stable", "claude", "codex");
  c.receive(cwd, handed.id, "codex");
  assert.equal(co.checkPaths(cwd, "claude", ["tests/test_paths.py"]).allowed, true, "unscoped work protects nothing");
  assert.throws(() => c.setScope(cwd, handed.id, "claude", ["tests"]), /owned by codex/);
  assert.throws(() => c.setScope(cwd, handed.id, "codex", ["ui/lib/graph-layout.ts"]), /"Canvas" \(claude/);
  assert.throws(() => c.setScope(cwd, handed.id, "codex", []), /at least one/);
  const r = cli(cwd, ["task", "scope", handed.id, "tests/test_paths.py,tests/fixtures/*", "--actor", "codex"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).scope, ["tests/test_paths.py", "tests/fixtures/*"]);
  assert.equal(co.checkPaths(cwd, "claude", ["tests/test_paths.py"]).allowed, false);
  assert.equal(team.log(cwd).entries[0].detail, "none → tests/test_paths.py, tests/fixtures/*");
  c.addTask(cwd, "Mine", "ok", "codex", ["ui/app"]);
  assert.ok(c.setScope(cwd, handed.id, "codex", ["ui/app"]), "own active work may overlap");
  assert.ok(canvas);
});

test("log keeps recorded order when events share a timestamp", (t) => {
  const cwd = repo(t);
  const task = c.addTask(cwd, "Same ms", "ok", "alice");
  const file = path.join(c.where(cwd).recordsDir, "tasks", `${task.id}.json`);
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  const at = rec.history[0].at;
  rec.history.push({ id: "event-00000001", at, event: "handoff_offered", actor: "alice", to: "bob", next: "go" });
  rec.history.push({ id: "event-00000002", at, event: "handoff_received", actor: "bob", from: "alice", next: "go" });
  fs.writeFileSync(file, JSON.stringify(rec));
  assert.deepEqual(team.log(cwd).entries.map((e) => e.event), ["handoff_received", "handoff_offered", "created"]);
});

test("pre-commit check blocks commits touching others' paths, whoever wrote them", (t) => {
  const cwd = repo(t);
  team.setPolicy(cwd, "ownership", "block", "alice");
  c.addTask(cwd, "Canvas", "ok", "claude", ["src/canvas*"]);
  c.addTask(cwd, "Pay", "ok", "codex", ["src/pay.js"]);
  const commit = (env = {}) => cli(cwd, ["hook", "pre-commit"], env);
  fs.writeFileSync(path.join(cwd, "src/canvas.ts"), "x");
  git(cwd, ["add", "src/canvas.ts"]);
  git(cwd, ["checkout", "-q", "-b", "codex/fix"]);
  const blocked = commit({ AGENTBRIDGE_ACTOR: "" });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /commit blocked for codex \(from branch codex\/fix\)/);
  assert.match(blocked.stderr, /claude is working on src\/canvas\.ts/);
  assert.equal(commit({ AGENTBRIDGE_ACTOR: "claude" }).status, 0, "explicit actor wins over the branch");
  git(cwd, ["checkout", "-q", "-b", "fix/other"]);
  const unknown = commit({ AGENTBRIDGE_ACTOR: "" });
  assert.equal(unknown.status, 0, "unknown committer is warned, not blocked");
  assert.match(unknown.stderr, /could not tell who is committing \(branch fix\/other\)[\s\S]*src\/canvas\.ts — claude/);
  git(cwd, ["config", "agentbridge.login", "dana"]);
  const person = commit({ AGENTBRIDGE_ACTOR: "" });
  assert.equal(person.status, 1, "in a team clone, a person in their own terminal is their GitHub login");
  assert.match(person.stderr, /commit blocked for dana \(from your GitHub login\)/);
  git(cwd, ["config", "agentbridge.login", "claude"]);
  assert.equal(commit({ AGENTBRIDGE_ACTOR: "" }).status, 0);
  git(cwd, ["config", "--unset", "agentbridge.login"]);
  git(cwd, ["reset", "-q"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "x");
  git(cwd, ["add", "README.md"]);
  git(cwd, ["checkout", "-q", "codex/fix"]);
  assert.deepEqual([commit({ AGENTBRIDGE_ACTOR: "" }).status, commit({ AGENTBRIDGE_ACTOR: "" }).stderr], [0, ""], "unowned files pass silently");
  git(cwd, ["rm", "-q", "--cached", "README.md"]);
  git(cwd, ["rm", "-q", "src/pay.js"]);
  assert.equal(commit({ AGENTBRIDGE_ACTOR: "claude" }).status, 1, "deleting an owned file is a change too");
});

test("git hook install chains in front of an existing hook and is idempotent", (t) => {
  const cwd = repo(t);
  team.setPolicy(cwd, "ownership", "block", "alice");
  c.addTask(cwd, "Pay", "ok", "codex", ["src/pay.js"]);
  const hooks = path.join(cwd, ".git/hooks");
  const marker = path.join(cwd, "existing-ran");
  fs.writeFileSync(path.join(hooks, "pre-commit"), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o755 });
  const r = JSON.parse(cli(cwd, ["hook", "install-git"]).stdout);
  assert.deepEqual([r.installed, r.chained], [true, true]);
  assert.equal(JSON.parse(cli(cwd, ["hook", "install-git"]).stdout).installed, false, "second install is a no-op");
  const hookFile = path.join(hooks, "pre-commit");
  fs.writeFileSync(hookFile, fs.readFileSync(hookFile, "utf8").replace(/'[^']*agentbridge\.js'/, "'/old/install/bin/agentbridge.js'"));
  const moved = JSON.parse(cli(cwd, ["hook", "install-git"]).stdout);
  assert.deepEqual([moved.installed, moved.repaired, moved.chained], [true, true, true], "a hook pointing at an old install is repointed, the chain kept");
  assert.doesNotMatch(fs.readFileSync(hookFile, "utf8"), /\/old\/install/);
  fs.writeFileSync(path.join(cwd, "src/pay.js"), "changed");
  git(cwd, ["add", "src/pay.js"]);
  const env = { ...process.env, AGENTBRIDGE_ACTOR: "claude" };
  const blocked = spawnSync("git", ["commit", "-qm", "x"], { cwd, encoding: "utf8", env });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /commit blocked for claude/);
  assert.ok(!fs.existsSync(marker), "a blocked commit stops before the chained hook");
  const ok = spawnSync("git", ["commit", "-qm", "x"], { cwd, encoding: "utf8", env: { ...env, AGENTBRIDGE_ACTOR: "codex" } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(fs.existsSync(marker), "the existing hook still runs");
});

test("prompt hook adds only what is new for the agent, and nothing otherwise", (t) => {
  const cwd = repo(t);
  const run = (actor) => spawnSync(process.execPath, [path.resolve("bin/agentbridge.js"), "hook", "prompt", "--actor", actor], { cwd, encoding: "utf8", input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: path.join(cwd, "src"), prompt: "hi" }) });
  assert.equal(run("claude").stdout, "", "nothing new, no tokens spent");
  const task = team.assign(cwd, "Canvas", "ok", "codex", "claude", { next: "Fix the nav chain" });
  const d = c.proposeProjectDecision(cwd, "Mobile first", "Phones", "bob");
  c.acceptDecision(cwd, d.id, "alice");
  const first = run("claude").stdout;
  assert.match(first, /Handoffs waiting for you[\s\S]*Canvas from codex: Fix the nav chain/);
  assert.match(first, /Newly accepted project decisions:\n- Mobile first \(alice\)/);
  assert.match(first, /- "Canvas" \(task-[0-9a-f-]+\): codex [a-z_]+, codex handoff_offered\n/, "changes are grouped per task with its title");
  const again = run("claude").stdout;
  assert.doesNotMatch(again, /Changes by others/, "changes are shown once");
  assert.match(again, /Handoffs waiting for you/, "a pending handoff keeps showing until received");
  for (const n of ["one", "two", "three"]) c.note(cwd, task.id, "codex", `step ${n}`);
  const notes = run("claude").stdout;
  assert.match(notes, /codex noted x3 — note: step three$/m, "repeats collapse and the latest note is shown");
  c.receive(cwd, task.id, "claude");
  assert.equal(run("claude").stdout, "");
});

test("the board flags open tasks whose pull request is already merged, without changing them", (t) => {
  const cwd = repo(t);
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-fakegh-")));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const gh = path.join(bin, "gh"), calls = path.join(bin, "calls");
  fs.writeFileSync(`${gh}.cjs`, `const a = process.argv.slice(2);
require("fs").appendFileSync(${JSON.stringify(calls)}, a.join(" ") + "\\n");
const merged = [
  { number: 7, headRefName: "feat/a", mergedAt: "2026-11-01T00:00:00Z" },
  { number: 9, headRefName: "feat/other", mergedAt: "2026-11-02T00:00:00Z" },
];
if (a[0] === "pr" && a[1] === "view") {
  const n = Number(a[2]), m = merged.find((p) => p.number === n);
  process.stdout.write(JSON.stringify(m ? { ...m, state: "MERGED", url: "https://github.com/acme/shop/pull/" + n } : { number: n, state: "OPEN", mergedAt: null, headRefName: "feat/x" }));
} else process.stdout.write(JSON.stringify(merged));`);
  fs.writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${gh}.cjs" "$@"\n`, { mode: 0o755 });
  const ab = (...args) => {
    const r = cli(cwd, args, { AGENTBRIDGE_GH_BIN: gh });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : r.stdout;
  };
  const add = (title) => ab("task", "add", title, "--criteria", "Works", "--actor", "alice").id;
  git(cwd, ["checkout", "-q", "-b", "feat/a"]);
  const onBranch = add("Branch work");
  ab("task", "status", onBranch, "in_progress", "--actor", "alice");
  ab("task", "scope", onBranch, "src/a.js", "--actor", "alice");
  const moved = add("Already moved on");
  ab("task", "status", moved, "in_progress", "--actor", "alice");
  ab("task", "status", moved, "implemented", "--actor", "alice");
  git(cwd, ["checkout", "-q", "main"]);
  const noted = add("Noted merge");
  ab("task", "note", noted, "PR #9 merged and live", "--actor", "alice");
  const named = add("Branch named in note");
  ab("task", "note", named, "feat/other: tests pass", "--actor", "alice");
  const depends = add("Mentions another PR");
  ab("task", "note", depends, "builds on PR #7 from main", "--actor", "alice");
  const open = add("Still open");
  ab("task", "note", open, "PR #10 open for review", "--actor", "alice");
  assert.equal(c.task(cwd, onBranch).history.at(-1).by.branch, "feat/a", "events record the code branch they happened on");

  const flagged = (b) => Object.fromEntries(b.attention.flatMap((a) => a.reasons.filter((r) => /merged/.test(r)).map((r) => [a.title, r])));
  assert.deepEqual(Object.keys(flagged(ab("board", "--format", "json"))), [], "no GitHub origin: no lookup, nothing flagged");
  assert.ok(!fs.existsSync(calls), "gh is not called for a repository that is not on GitHub");

  git(cwd, ["remote", "add", "origin", "https://github.com/acme/shop.git"]);
  const b = flagged(ab("board", "--format", "json"));
  assert.match(b["Branch work"], /PR #7 \(branch feat\/a\) is merged but the task is still working; close it: agentbridge done [0-9a-f]{8}$/);
  assert.match(b["Noted merge"], /PR #9 \(latest note\) is merged but the task is still not started/);
  assert.match(b["Branch named in note"], /PR #9 \(latest note\) is merged/);
  assert.equal(b["Mentions another PR"], undefined, "a merged PR the note only refers to is not taken as this task's");
  assert.equal(b["Still open"], undefined, "an unmerged PR is not flagged");
  assert.match(b["Already moved on"], /PR #7 \(branch feat\/a\) is merged but the task is still built; close it: agentbridge done [0-9a-f]{8}/, "an implemented task still holds its files, so it is flagged too");
  assert.equal(c.task(cwd, onBranch).status, "in_progress", "the board only suggests; it never changes a task");
  assert.match(ab("board"), /Needs attention\n  Branch work \(alice\): .*PR #7 \(branch feat\/a\) is merged/);
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1, "the merged-PR list is cached between boards");

  const no = (args, pattern) => {
    const r = cli(cwd, args, { AGENTBRIDGE_GH_BIN: gh });
    assert.notEqual(r.status, 0, `${args.join(" ")} should be refused`);
    assert.match(r.stderr, pattern);
  };
  assert.equal(c.task(cwd, open).status, "planned");
  no(["task", "close", open, "--pr", "10", "--actor", "alice"], /PR #10 is open, not merged/);
  no(["task", "close", open, "--actor", "alice"], /No merged pull request matches .*pass --pr N/);
  no(["task", "close", open, "--pr", "x1", "--actor", "alice"], /--pr must be a pull request number/);
  no(["task", "close", onBranch, "--actor", "bob"], /Only the owner \(alice\) can close/);
  const freed = co.checkPaths(cwd, "bob", ["src/a.js"]);
  assert.equal(freed.allowed, true, "an open task whose PR merged no longer blocks others");
  assert.deepEqual(freed.released, [{ path: "src/a.js", task: onBranch, title: "Branch work", owner: "alice", reason: "merged", pr: 7 }], "check says which merged PR released the files");
  assert.equal(co.checkPaths(cwd, "bob", ["src/a.js"], { merged: null }).allowed, false, "without the merged-PR list the claim still holds");
  const bobs = ab("task", "add", "Follow-up on a", "--criteria", "Works", "--actor", "bob", "--scope", "src/a.js");
  assert.equal(ab("task", "status", bobs.id, "in_progress", "--actor", "bob").status, "in_progress", "others can claim and start on files whose task merged");
  assert.equal(c.task(cwd, onBranch).status, "in_progress", "the merged task's record is left for its owner to close");
  ab("task", "cancel", bobs.id, "--reason", "test", "--actor", "bob");
  const closed = ab("task", "close", onBranch, "--actor", "alice");
  assert.equal(closed.status, "merged");
  assert.deepEqual(closed.history.at(-1).pr, { number: 7, mergedAt: "2026-11-01T00:00:00Z", branch: "feat/a", url: "https://github.com/acme/shop/pull/7" }, "the PR is matched from the task's branch and checked on GitHub");
  assert.equal(co.checkPaths(cwd, "bob", ["src/a.js"]).allowed, true, "closing releases the task's files");
  no(["task", "close", onBranch, "--actor", "alice"], /already merged/);
  assert.equal(ab("task", "close", noted, "--pr", "#9", "--actor", "alice").history.at(-1).pr.number, 9);
  const after = ab("board", "--format", "json");
  assert.equal(after.merged, 2);
  assert.ok(!after.attention.some((a) => a.title === "Branch work"), "a closed task leaves the board");
  assert.match(ab("board"), /closed by a merged PR/);
  assert.equal(ab("task", "status", onBranch, "in_progress", "--actor", "alice").status, "in_progress", "a closed task can be reopened");
});

test("offers can be withdrawn or declined and tasks cancelled, only by the right people; cancelled work frees its paths", (t) => {
  const cwd = repo(t);
  git(cwd, ["config", "agentbridge.login", "alice"]);
  const run = (args, env = {}) => cli(cwd, args, env);
  const ok = (args, env) => {
    const r = run(args, env);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const refused = (args, pattern, env) => {
    const r = run(args, env);
    assert.notEqual(r.status, 0, `${args.join(" ")} should be refused`);
    assert.match(r.stderr, pattern);
  };
  const codex = { CODEX_THREAD_ID: "thread-1" };
  const byCodex = ok(["task", "add", "Try it", "--criteria", "Works", "--to", "bob", "--actor", "codex"], codex);
  assert.equal(byCodex.owner, "alice/codex");
  refused(["handoff", "withdraw", byCodex.id, "--actor", "claude"], /Only alice\/codex .* can withdraw/, { CLAUDECODE: "1" });
  const back = ok(["handoff", "withdraw", byCodex.id, "--actor", "alice"]);
  assert.equal(back.pendingHandoff, null, "a person withdraws an offer their own agent made, from their terminal");
  assert.deepEqual([back.history.at(-1).event, back.history.at(-1).actor, back.history.at(-1).for], ["handoff_withdrawn", "alice", "alice/codex"]);
  refused(["handoff", "withdraw", byCodex.id, "--actor", "alice"], /no pending offer/);

  const claude = { CLAUDECODE: "1" };
  const offered = ok(["task", "add", "Pay", "--criteria", "Pays", "--to", "alice/claude", "--scope", "src/pay.js", "--actor", "alice"]);
  refused(["handoff", "decline", offered.id, "--actor", "codex"], /No handoff addressed to this actor/, codex);
  const declined = ok(["handoff", "decline", offered.id, "--actor", "claude", "--reason", "Not my area"], claude);
  assert.equal(declined.owner, "alice", "the offerer keeps a declined task");
  assert.deepEqual([declined.history.at(-1).event, declined.history.at(-1).reason], ["handoff_declined", "Not my area"]);

  refused(["task", "cancel", offered.id, "--actor", "alice"], /Say why/);
  refused(["task", "cancel", offered.id, "--actor", "claude", "--reason", "x"], /Only the owner \(alice\)/, claude);
  refused(["task", "cancel", byCodex.id, "--actor", "claude", "--reason", "dup"], /Only the owner \(alice\/codex\)/, { CLAUDECODE: "1" });
  const cancelled = ok(["task", "cancel", offered.id, "--actor", "alice", "--reason", "Duplicate of the cart task"]);
  assert.equal(cancelled.status, "cancelled");
  refused(["task", "cancel", offered.id, "--actor", "alice", "--reason", "again"], /already cancelled/);
  ok(["task", "cancel", byCodex.id, "--actor", "alice", "--reason", "Duplicate offer"]);
  const own = ok(["task", "add", "Mine", "--criteria", "Done", "--actor", "codex"], codex);
  ok(["task", "cancel", own.id, "--actor", "codex", "--reason", "User dropped it"], codex);

  const free = ok(["check", "src/pay.js", "--actor", "codex"], codex);
  assert.equal(free.allowed, true, "a cancelled task no longer protects its paths");
  const b = ok(["board", "--format", "json"]);
  assert.deepEqual([b.people.length, b.done, b.cancelled], [0, 0, 3]);
  assert.match(run(["board"]).stdout, /0 tasks done, 3 cancelled\./);
  assert.equal(ok(["task", "status", offered.id, "in_progress", "--actor", "alice"]).status, "in_progress", "a cancelled task can be reopened by its owner");
});

test("short task ids work, agents need no --actor in their session, and agents are told when their PR merged", (t) => {
  const cwd = repo(t);
  git(cwd, ["config", "agentbridge.login", "alice"]);
  const codex = { CODEX_THREAD_ID: "thread-1" };
  const ok = (args, env = {}) => {
    const r = cli(cwd, args, env);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const task = ok(["task", "add", "Search", "--criteria", "Finds"], codex);
  assert.equal(task.owner, "alice/codex", "inside a Codex session the actor defaults to that agent");
  assert.equal(ok(["task", "add", "Mine", "--criteria", "Works"]).owner, "alice", "outside a session it defaults to the person");
  const short = task.id.slice(5, 13);
  assert.equal(ok(["task", "status", short, "in_progress"], codex).id, task.id, "the first 8 characters of an id are enough");
  assert.equal(ok(["task", "note", `task-${short}`, "feat/search: tests pass"], codex).note.text, "feat/search: tests pass");
  const amb = cli(cwd, ["task", "show", "zzzzzz"]);
  assert.notEqual(amb.status, 0, "an id that matches nothing is still refused");

  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-fakegh-")));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const gh = path.join(bin, "gh");
  fs.writeFileSync(`${gh}.cjs`, `process.stdout.write(JSON.stringify([{ number: 12, headRefName: "feat/search", mergedAt: "2026-11-01T00:00:00Z" }]));`);
  fs.writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${gh}.cjs" "$@"\n`, { mode: 0o755 });
  git(cwd, ["remote", "add", "origin", "https://github.com/acme/shop.git"]);
  const prompt = (actor) =>
    spawnSync(process.execPath, [path.resolve("bin/agentbridge.js"), "hook", "prompt", "--actor", actor], {
      cwd, encoding: "utf8", env: { ...process.env, AGENTBRIDGE_GH_BIN: gh }, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd, prompt: "hi" }),
    }).stdout;
  assert.match(prompt("codex"), /Your tasks whose pull request is merged.*\n- Search \(task-[0-9a-f-]+\): PR #12/);
  assert.doesNotMatch(prompt("claude"), /pull request is merged/, "only the owner is told");
});

test("a person moves a task between themselves and their own agents from their own terminal; agents and other people cannot", (t) => {
  const cwd = repo(t);
  const run = (args, env = {}) => cli(cwd, args, env);
  const ok = (args, env) => {
    const r = run(args, env);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const refused = (args, pattern, env) => {
    const r = run(args, env);
    assert.notEqual(r.status, 0, `${args.join(" ")} should be refused`);
    assert.match(r.stderr, pattern);
  };
  const stuck = c.addTask(cwd, "CI gate", "Fast", "codex", ["ci.yml"]);
  const claude = { CLAUDECODE: "1" };
  const asCodex = run(["task", "cancel", stuck.id, "--actor", "codex", "--reason", "x"], claude);
  assert.match(asCodex.stderr, /Never suggest acting as another agent.*agentbridge assign TASK --to claude$/m, "the refusal says what the person runs instead");
  refused(["task", "reassign", stuck.id, "--to", "claude", "--reason", "Codex stopped", "--actor", "claude"], /Only a person reassigns work, and this runs inside a claude session/, claude);
  refused(["task", "reassign", stuck.id, "--to", "claude", "--reason", "Codex stopped", "--actor", "codex"], /codex is an agent; only a person reassigns/);
  refused(["task", "reassign", stuck.id, "--to", "claude", "--actor", "sam"], /Say why/);
  git(cwd, ["config", "agentbridge.person", "sam"]);
  assert.equal(ok(["task", "reassign", c.addTask(cwd, "Solo", "ok", "codex").id, "--to", "claude", "--reason", "x"]).history.at(-1).actor, "sam", "without --actor a person is their saved name");
  const moved = ok(["task", "reassign", stuck.id, "--to", "claude", "--reason", "Codex stopped mid-task", "--actor", "sam"]);
  assert.equal(moved.owner, "claude");
  assert.deepEqual([moved.history.at(-1).event, moved.history.at(-1).from, moved.history.at(-1).to, moved.history.at(-1).actor], ["reassigned", "codex", "claude", "sam"]);
  assert.equal(co.checkPaths(cwd, "claude", ["ci.yml"]).allowed, true, "the new owner may edit its files");
  assert.equal(co.checkPaths(cwd, "codex", ["ci.yml"]).allowed, false, "the old owner may not");
  assert.ok(co.inbox(cwd, "codex").changes.some((x) => x.event === "reassigned"), "the old owner sees it in its inbox");
  refused(["task", "reassign", stuck.id, "--to", "claude", "--reason", "x", "--actor", "sam"], /claude already owns this task/);
  const persons = c.addTask(cwd, "Docs", "Clear", "alex", ["docs"]);
  refused(["task", "reassign", persons.id, "--to", "claude", "--reason", "x", "--actor", "sam"], /belongs to alex; you can reassign only your own or your agents' tasks/);
  refused(["task", "reassign", stuck.id, "--to", "alex", "--reason", "x", "--actor", "sam"], /alex is not you or one of your agents; use handoff offer/);

  git(cwd, ["config", "agentbridge.login", "alice"]);
  const team = c.addTask(cwd, "Queue", "Fast", "alice/codex", ["queue.yml"]);
  const mine = ok(["task", "reassign", team.id.slice(5, 13), "--to", "claude", "--reason", "Codex stopped"]);
  assert.deepEqual([mine.owner, mine.history.at(-1).actor], ["alice/claude", "alice"], "with a login, the person defaults to themselves and agent names resolve to their agents");
  const other = c.addTask(cwd, "Theirs", "Fast", "bob/codex", ["bob.yml"]);
  refused(["task", "reassign", other.id, "--to", "claude", "--reason", "x"], /belongs to bob\/codex/);
  refused(["task", "reassign", team.id, "--to", "bob", "--reason", "x"], /bob is not you or one of your agents/);
});

test("the board flags claims idle for a day so a person can move them, without moving anything", (t) => {
  const cwd = repo(t);
  const task = c.addTask(cwd, "CI gate", "Fast", "codex", ["ci.yml"]);
  c.setStatus(cwd, task.id, "in_progress", "codex");
  const last = Date.parse(c.task(cwd, task.id).history.at(-1).at);
  const reasons = (hours) => team.board(cwd, { merged: null, now: last + hours * 36e5 }).attention.find((a) => a.task === task.id)?.reasons.join(" ") || "";
  assert.doesNotMatch(reasons(23), /no activity/);
  assert.match(reasons(30), /no activity for 30h while holding its files; if its owner stopped, move it: agentbridge assign [0-9a-f]{8} --to AGENT$/);
  assert.match(reasons(24 * 3 + 1), /no activity for 3 days/);
  assert.equal(c.task(cwd, task.id).owner, "codex");
});

test("people need four commands: assign gives work to their agents or offers it to a teammate, done closes it", (t) => {
  const cwd = repo(t);
  git(cwd, ["config", "agentbridge.person", "sam"]);
  const run = (args, env = {}) => cli(cwd, args, env);
  const ok = (args, env) => {
    const r = run(args, env);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const refused = (args, pattern, env) => {
    const r = run(args, env);
    assert.notEqual(r.status, 0, `${args.join(" ")} should be refused`);
    assert.match(r.stderr, pattern);
  };
  const fresh = ok(["assign", "Fix the login redirect", "--to", "codex", "--scope", "src/login.js"]);
  assert.deepEqual([fresh.owner, fresh.criteria[0].text, fresh.scope], ["codex", "Fix the login redirect", ["src/login.js"]], "new work goes straight to your own agent, its title as the done bar");
  assert.deepEqual([fresh.history.at(-1).event, fresh.history.at(-1).actor], ["reassigned", "sam"]);
  const short = fresh.id.slice(5, 13);
  assert.equal(ok(["assign", short, "--to", "claude"]).owner, "claude", "existing work moves between your agents");
  const offered = ok(["assign", short, "--to", "alex", "--reason", "Review the redirect"]);
  assert.deepEqual([offered.owner, offered.pendingHandoff.to, offered.pendingHandoff.from, offered.history.at(-1).for], ["claude", "alex", "sam", "claude"], "a teammate gets an offer they accept");
  const theirs = ok(["assign", "Write the docs", "--to", "alex"]);
  assert.deepEqual([theirs.owner, theirs.pendingHandoff.to], ["sam", "alex"]);
  refused(["assign", "Anything", "--to", "codex"], /Only a person assigns work, and this runs inside a claude session/, { CLAUDECODE: "1" });
  refused(["assign", "Anything"], /Who to\?/);

  refused(["done", short], /No merged pull request|Could not list merged.*agentbridge done [0-9a-f]{8} --reason "why"/);
  refused(["done", short], /Only a person closes work with done \(agents use task close\)/, { CLAUDECODE: "1" });
  const dropped = ok(["done", theirs.id.slice(5, 13), "--reason", "Not needed"]);
  assert.deepEqual([dropped.status, dropped.history.at(-1).reason], ["cancelled", "Not needed"]);
  assert.match(run(["--help"]).stdout, /For people, two commands; your agents handle the rest:\n  agentbridge onboard        set up this repository \(once\)\n  agentbridge                asks about each thing that needs you/);
});

test("done with no task closes every merged task of yours after asking; your name comes from GitHub on first use", (t) => {
  const cwd = repo(t);
  git(cwd, ["remote", "add", "origin", "https://github.com/acme/shop.git"]);
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-fakegh-")));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const gh = path.join(bin, "gh");
  fs.writeFileSync(`${gh}.cjs`, `const a = process.argv.slice(2);
const merged = [{ number: 7, headRefName: "feat/a", mergedAt: "2026-11-01T00:00:00Z" }, { number: 9, headRefName: "feat/b", mergedAt: "2026-11-02T00:00:00Z" }];
if (a[0] === "api" && a[1] === "user") process.stdout.write("sam-gh 42\\n");
else if (a[0] === "pr" && a[1] === "view") process.stdout.write(JSON.stringify({ ...merged.find((p) => p.number === Number(a[2])), state: "MERGED", url: "https://github.com/acme/shop/pull/" + a[2] }));
else process.stdout.write(JSON.stringify(merged));`);
  fs.writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${gh}.cjs" "$@"\n`, { mode: 0o755 });
  const run = (...args) => cli(cwd, args, { AGENTBRIDGE_GH_BIN: gh });
  const ok = (...args) => {
    const r = run(...args);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : r.stdout;
  };
  const first = ok("assign", "Ship the cart", "--to", "codex");
  assert.equal(first.history.at(-1).actor, "sam-gh", "no --actor and no onboard: the person's GitHub login is used and saved");
  assert.equal(git(cwd, ["config", "--get", "agentbridge.person"]).trim(), "sam-gh");
  c.note(cwd, first.id, "codex", "PR #7 merged");
  const second = ok("assign", "Fix the nav", "--to", "claude");
  c.note(cwd, second.id, "claude", "PR #9 merged, follow-up left");
  const teammate = c.addTask(cwd, "Their work", "ok", "alex");
  c.note(cwd, teammate.id, "alex", "PR #9 merged");
  const open = ok("assign", "Still going", "--to", "codex");

  const asked = run("done");
  assert.notEqual(asked.status, 0);
  assert.match(asked.stdout, /2 of your tasks have a merged pull request:\n  [0-9a-f]{8}  Ship the cart  \(codex, PR #7 merged\)[\s\S]*last note: PR #9 merged, follow-up left/);
  assert.match(asked.stderr, /Add --yes/);
  assert.equal(c.task(cwd, first.id).status, "planned", "nothing closes without a yes");
  assert.match(ok("done", "--yes"), /Closed 2 of 2; their files are free\.\n1 more belong to teammates; they close their own\./);
  assert.deepEqual([first, second, teammate, open].map((x) => c.task(cwd, x.id).status), ["merged", "merged", "planned", "planned"]);
  assert.match(ok("done", "--yes"), /Nothing to close/);
  assert.notEqual(cli(cwd, ["done", "--yes"], { AGENTBRIDGE_GH_BIN: gh, CLAUDECODE: "1" }).status, 0, "agents cannot bulk close");
});

test("resume gives the next agent or person one packet: goal, next step, code, PR, decisions, findings, checks, freshness", (t) => {
  const cwd = repo(t);
  const d = c.proposeProjectDecision(cwd, "Prices in cents", "Rounding", "claude");
  c.acceptDecision(cwd, d.id, "sam");
  c.proposeProjectDecision(cwd, "Drop IE", "Old", "codex");
  git(cwd, ["checkout", "-q", "-b", "feat/cart"]);
  const task = c.addTask(cwd, "Cart totals", "Totals match; Tax applied", "claude", ["src/pay.js"]);
  c.setStatus(cwd, task.id, "in_progress", "claude");
  fs.writeFileSync(path.join(cwd, "src/pay.js"), "export const total = 1;\n");
  fs.writeFileSync(path.join(cwd, "src/cart.js"), "export {};\n");
  git(cwd, ["add", "src"]);
  git(cwd, ["commit", "-qm", "cart"]);
  assert.equal(cli(cwd, ["task", "note", task.id, "PR #31 open; tax left", "--actor", "claude"]).status, 0);
  c.reportFinding(cwd, task.id, "Tax is applied twice", "codex");
  c.offer(cwd, task.id, "claude", "codex", "Fix double tax, then rerun tests");
  git(cwd, ["checkout", "-q", "main"]);
  const r = team.resume(cwd, task.id, { merged: null });
  assert.equal(r.next, "codex accepts it (agentbridge handoff receive " + task.id.slice(5, 13) + "), then: Fix double tax, then rerun tests");
  assert.deepEqual([r.goal, r.criteria, r.statusWords, r.owner], ["Cart totals", ["Totals match", "Tax applied"], "needs work", "claude"]);
  assert.deepEqual([r.code.branch, r.code.base, r.code.commitsAhead, r.code.changedFiles], ["feat/cart", "main", 1, ["src/cart.js", "src/pay.js"]], "the branch is found from where the work was recorded, even after switching back");
  assert.deepEqual(r.pullRequest, { number: 31, merged: false });
  assert.deepEqual(r.decisions.map((x) => x.summary), ["Prices in cents"]);
  assert.deepEqual(r.pendingDecisions.map((x) => x.summary), ["Drop IE"]);
  assert.deepEqual(r.openFindings.map((f) => f.description), ["Tax is applied twice"]);
  assert.equal(r.freshness.recordsSyncedAt, null);
  conforms(r, "resume");

  const mcpAs = (who, calls) => spawnSync(process.execPath, [path.resolve("bin/agentbridge.js"), "mcp", "--actor", who], { cwd, encoding: "utf8", timeout: 15000, input: calls.map((p, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: p })).join("\n") + "\n" }).stdout.trim().split("\n").map((l) => JSON.parse(l).result);
  const mcp = (calls) => mcpAs("codex", calls);
  const short = task.id.slice(5, 13);
  const [got, fixed, wrong, again] = mcp([
    { name: "handoff_receive", arguments: { task: short } },
    { name: "resolve_finding", arguments: { task: short, finding: r.openFindings[0].id, resolution: "Removed the second tax pass" } },
    { name: "resolve_finding", arguments: { task: short, finding: "finding-nope", resolution: "x" } },
    { name: "resume_task", arguments: {} },
  ]);
  assert.equal(got.structuredContent.owner, "codex");
  assert.equal(got.structuredContent.resume.code.branch, "feat/cart", "receiving a handoff returns the packet");
  assert.equal(fixed.structuredContent.status, "implemented");
  assert.equal(wrong.isError, true);
  assert.equal(again.structuredContent.task, task.id, "with no task, your latest open task");
  assert.equal(again.structuredContent.openFindings.length, 0);
  const [reported] = mcpAs("claude", [{ name: "report_finding", arguments: { task: short, description: "Rounding off by a cent" } }]);
  assert.equal(reported.structuredContent.author, "claude");
  assert.equal(c.task(cwd, task.id).status, "needs_work");

  git(cwd, ["config", "agentbridge.person", "sam"]);
  const text = team.resumeText(team.resume(cwd, task.id, { merged: null }));
  assert.match(text, /^[0-9a-f]{8}  "Cart totals"  \[needs work, owner codex\]\nNext: Resolve 1 open finding below, then rerun the checks\nDone when: Totals match; Tax applied\nLast note \(claude, .*\): PR #31 open; tax left\nCode: branch feat\/cart @ [0-9a-f]{12}, 1 commit\(s\) ahead of main, 2 file\(s\) changed: src\/cart.js, src\/pay.js/);
  assert.match(text, /Decided:\n  - Prices in cents \(project, accepted by sam\)/);
  assert.match(text, /Open findings:\n  - Rounding off by a cent \(claude/);
  assert.match(text, /Records are local to this machine$/);
  assert.equal(JSON.parse(cli(cwd, ["resume", short]).stdout).task, task.id);
});

test("resume of built work points at the pull request, and hides verification checks the task never used", (t) => {
  const cwd = repo(t);
  team.setPolicy(cwd, "ownership", "block", "alice");
  const task = c.addTask(cwd, "Search", "Finds items", "codex", ["src/search.js"]);
  c.setStatus(cwd, task.id, "in_progress", "codex");
  c.setStatus(cwd, task.id, "implemented", "codex");
  const short = task.id.slice(5, 13);
  let r = team.resume(cwd, task.id, { merged: null });
  assert.match(r.next, /^Built\. Open a pull request and note its number/);
  assert.deepEqual(r.checks.unresolved, [], "no evidence, runs or reviews: no pipeline checks to chase");
  assert.doesNotMatch(team.resumeText(r), /Checks not yet satisfied/);
  c.note(cwd, task.id, "codex", "PR #40 open");
  r = team.resume(cwd, task.id, { merged: null });
  assert.equal(r.next, `Built. When PR #40 merges, close the task: agentbridge task close ${short}`);
  assert.match(cli(cwd, ["resume", short, "--format", "text"]).stdout, /^[0-9a-f]{8}  "Search"  \[built, owner codex\]\nNext: Built\. When PR #40 merges/);
  assert.match(cli(cwd, ["stats", "--format", "text"]).stdout, /^AgentBridge usage/);
  const hook = (session, file) => spawnSync(process.execPath, [path.resolve("bin/agentbridge.js"), "hook", "pre-edit"], {
    cwd, encoding: "utf8", timeout: 15000, input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path.join(cwd, file) } }),
    env: { ...process.env, CLAUDECODE: "", CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "", AI_AGENT: "", ...session },
  }).status;
  assert.equal(hook({ CODEX_THREAD_ID: "t1" }, "src/search.js"), 0, "without --actor the hook acts as the session's agent");
  assert.equal(hook({ CLAUDECODE: "1" }, "src/search.js"), 2);
});

test("a command waits for another process's short write lock, and clears one left by a process that died", async (t) => {
  const cwd = repo(t);
  const lockFile = path.join(st.root(cwd), "local", "write.lock");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(lockFile, JSON.stringify({ pid: Number(dead), host: os.hostname(), at: new Date().toISOString() }));
  assert.ok(c.addTask(cwd, "After a crash", "ok", "claude").id, "a dead process's lock is cleared");
  const { spawn } = await import("node:child_process");
  const holder = spawn(process.execPath, ["-e", `const fs=require("fs");fs.writeFileSync(${JSON.stringify(lockFile)},JSON.stringify({pid:process.pid,host:require("os").hostname()}),{flag:"wx"});setTimeout(()=>fs.unlinkSync(${JSON.stringify(lockFile)}),700)`]);
  while (!fs.existsSync(lockFile)) await new Promise((r) => setTimeout(r, 20));
  const started = Date.now();
  assert.ok(c.addTask(cwd, "While syncing", "ok", "claude").id, "a live holder is waited for");
  assert.ok(Date.now() - started >= 300, "it waited");
  await new Promise((r) => holder.on("exit", r));
});

test("the board catches two owners holding the same file (a race between clones) and says how to settle it", () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-race-")));
  try {
    c.init(cwd);
    const first = c.addTask(cwd, "Pay", "ok", "claude", ["src/pay.js"]);
    c.setStatus(cwd, first.id, "in_progress", "claude");
    const second = c.addTask(cwd, "Pay again", "ok", "codex", ["src"]);
    assert.throws(() => c.setStatus(cwd, second.id, "in_progress", "codex"), /claude claimed these files first \("Pay", [0-9a-f]{8}\)/, "starting work on files someone claimed first is refused");
    assert.equal(team.board(cwd, { merged: null }).attention.filter((a) => a.task === second.id).length, 1, "a planned overlapping claim is flagged too");
    st.mutate(cwd, second.id, (t) => { t.status = "in_progress"; });
    const b = team.board(cwd, { merged: null });
    const flagged = b.attention.filter((a) => a.reasons.some((x) => /also holds/.test(x)));
    assert.deepEqual(flagged.map((a) => a.task), [second.id], "only the later claim is flagged");
    assert.match(flagged[0].reasons.join(), /claude also holds src \("Pay", claimed first\), so neither can edit it; a person keeps one: agentbridge done [0-9a-f]{8} --reason "duplicate", or hand it over: agentbridge assign [0-9a-f]{8} --to claude/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("agentbridge asks a person about each thing that needs them, one key per answer, and acts", (t) => {
  const cwd = repo(t);
  git(cwd, ["config", "agentbridge.person", "sam"]);
  git(cwd, ["remote", "add", "origin", "https://github.com/acme/shop.git"]);
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-fakegh-")));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const gh = path.join(bin, "gh");
  fs.writeFileSync(`${gh}.cjs`, `const a = process.argv.slice(2);
const merged = [{ number: 7, headRefName: "feat/a", mergedAt: "2026-11-01T00:00:00Z" }];
if (a[0] === "pr" && a[1] === "view") process.stdout.write(JSON.stringify({ ...merged[0], state: "MERGED", url: "u" }));
else process.stdout.write(JSON.stringify(merged));`);
  fs.writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${gh}.cjs" "$@"\n`, { mode: 0o755 });
  const todo = (answers, env = {}) => spawnSync(process.execPath, [path.resolve("bin/agentbridge.js"), "todo"], { cwd, encoding: "utf8", timeout: 15000, input: answers.join("\n") + "\n", env: { ...process.env, AGENTBRIDGE_GH_BIN: gh, ...env } });

  const offered = team.assign(cwd, "Review the cart", "ok", "alex", "sam", { next: "Check totals" });
  const d = c.proposeProjectDecision(cwd, "Prices in cents", "Rounding", "codex");
  const mineTry = team.assign(cwd, "Try AgentBridge", "ok", "sam", "alex");
  const codexTry = team.assign(cwd, "Try AgentBridge", "ok", "codex", "alex");
  const shipped = c.addTask(cwd, "Shipped", "ok", "codex");
  c.note(cwd, shipped.id, "codex", "PR #7 merged");
  const stuck = (title, owner, scope) => {
    const x = c.addTask(cwd, title, "ok", owner, [scope]);
    c.setStatus(cwd, x.id, "in_progress", owner);
    const file = path.join(c.where(cwd).recordsDir, "tasks", `${x.id}.json`);
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    rec.history.at(-1).at = rec.updatedAt = new Date(Date.now() - 50 * 36e5).toISOString();
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
    return x;
  };
  const moveMe = stuck("Stalled search", "codex", "src/search.js");
  const closeMe = stuck("Abandoned docs", "codex", "docs");
  const leaveMe = stuck("Paused nav", "claude", "src/nav.js");

  const r = todo(["y", "y", "y", "y", "m", "c", ""]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^7 things need you\. Enter skips\.\n\n1\. alex offers you "Review the cart": Check totals\n   y = accept it, d = decline it, Enter = skip: \n   accepted; it is yours/);
  assert.match(r.stdout, /2\. codex proposes, for the whole project: "Prices in cents" \(Rounding\)\n.*\n   accepted/);
  assert.match(r.stdout, /3\. "Try AgentBridge" exists twice: [0-9a-f]{8} \(sam\) and [0-9a-f]{8} \(codex\)\n   y = close [0-9a-f]{8} as the duplicate/);
  assert.match(r.stdout, /4\. 1 task of yours has a merged pull request:\n    Shipped \(PR #7\)\n      last note: PR #7 merged\n   y = close it/);
  assert.match(r.stdout, /5\. "Stalled search" \(codex\) has had no activity for 2 days and holds 1 file path\n   c = close it \(finished or abandoned\), m = move it to claude, Enter = skip: \n   moved to claude/);
  assert.match(r.stdout, /7\. "Paused nav" \(claude\) .*\n   c = close it \(finished or abandoned\), m = move it to codex, Enter = skip: \n   skipped\n\nHandled 6 of 7\./);
  const st = (x) => c.task(cwd, x.id);
  assert.deepEqual([st(offered).owner, c.projectDecisions(cwd).find((x) => x.id === d.id).status, st(mineTry).status, st(codexTry).status, st(shipped).status, st(moveMe).owner, st(closeMe).status, st(leaveMe).status],
    ["sam", "accepted", "planned", "cancelled", "merged", "claude", "cancelled", "in_progress"]);

  assert.match(todo([]).stdout, /^1 thing needs you\. Enter skips\.\n\n1\. "Paused nav"[\s\S]*skipped\n\nHandled 0 of 1\./, "no answers means nothing changes");
  assert.notEqual(todo(["y"], { CLAUDECODE: "1" }).status, 0, "agents cannot answer for a person");
  assert.match(cli(cwd, []).stdout, /For people, two commands/, "without a terminal, bare agentbridge prints help");
});

test("demo shows an ownership warning and a handoff in a throwaway repository and leaves nothing behind", (t) => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-demo-home-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const r = cli(cwd, ["demo"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Its pre-edit hook tells it, before the edit:\n     AgentBridge: claude is working on src\/cart\.js \(task "Fix cart totals", [0-9a-f]{8}, working\); last active within the hour\. The edit goes ahead \(ownership is advisory in this repository\)\. Tell the user/);
  assert.match(r.stdout, /Next: Apply tax once in total\(\), then run the tests \(1 open finding below\)\n[\s\S]*Code: branch feat\/cart @ [0-9a-f]{12}, 1 commit\(s\) ahead of main, 1 file\(s\) changed: src\/cart\.js/);
  assert.match(r.stdout, /Codex edits src\/cart\.js: no warning, the task is its now\./);
  const dir = /That was (\S+) \(deleted\)/.exec(r.stdout)[1];
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(fs.readdirSync(cwd), [], "the directory it ran from is untouched");
});

test("stats counts handoffs, time to resume, blocked edits and weekly activity from local records only", (t) => {
  const cwd = repo(t);
  team.setPolicy(cwd, "ownership", "block", "alice");
  const task = c.addTask(cwd, "Cart", "ok", "claude", ["src/pay.js"]);
  c.setStatus(cwd, task.id, "in_progress", "claude");
  const hook = spawnSync(process.execPath, [path.resolve("bin/agentbridge.js"), "hook", "pre-edit", "--actor", "codex"], { cwd, encoding: "utf8", input: JSON.stringify({ cwd, tool_name: "Edit", tool_input: { file_path: path.join(cwd, "src/pay.js") } }) });
  assert.equal(hook.status, 2);
  c.offer(cwd, task.id, "claude", "codex", "Finish it");
  c.receive(cwd, task.id, "codex");
  c.note(cwd, task.id, "codex", "on it");
  const other = c.addTask(cwd, "Docs", "ok", "sam");
  c.cancel(cwd, other.id, "sam", "Not needed");
  const r = JSON.parse(cli(cwd, ["stats", "--format", "json"]).stdout);
  assert.deepEqual([r.handoffs.offered, r.handoffs.accepted, r.handoffs.resumed], [1, 1, 1]);
  assert.ok(r.handoffs.minutesToAccept >= 0 && r.handoffs.minutesToResume >= 0);
  assert.deepEqual([r.tasks.created, r.tasks.cancelled], [2, 1]);
  assert.deepEqual(r.blockedEdits, { total: 1, byActor: { codex: 1 }, commits: 0 });
  assert.deepEqual(r.weeks.map((w) => [w.people, w.agents]), [[1, 2]]);
  const later = JSON.parse(cli(cwd, ["stats", "--since", "2999-01-01", "--format", "json"]).stdout);
  assert.deepEqual([later.handoffs.offered, later.tasks.created, later.blockedEdits.total], [0, 0, 0]);
  assert.notEqual(cli(cwd, ["stats", "--since", "soon"]).status, 0);
});
