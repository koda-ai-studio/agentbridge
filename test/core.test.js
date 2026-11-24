import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as c from "../lib/core.js";
import * as s from "../lib/store.js";
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  c.init(cwd);
  return cwd;
}
test("create task, decision, and handoff with human attribution", (t) => {
  const cwd = fixture(t),
    a = c.addTask(cwd, "Refresh", "Concurrent refresh safe", "alice");
  const d = c.addDecision(cwd, a.id, "Rotate tokens", "Reduce replay risk");
  c.acceptDecision(cwd, d.id, "alice");
  assert.match(c.handoff(cwd, a.id), /Rotate tokens/);
  assert.ok(
    c.task(cwd, a.id).history.some((e) => e.event === "decision_accepted"),
  );
});
test("cannot verify based on agent claim or manual attestation", (t) => {
  const cwd = fixture(t),
    a = c.addTask(cwd, "Tests", "Checks pass", "alice");
  assert.throws(
    () => c.setStatus(cwd, a.id, "verified", "alice"),
    /No evidence/,
  );
  c.recordEvidence(cwd, a.id, "npm test", "pass");
  assert.throws(
    () => c.setStatus(cwd, a.id, "verified", "alice"),
    /Manual attestations/,
  );
});
test("open findings reopen task and require explicit resolution", (t) => {
  const cwd = fixture(t),
    a = c.addTask(cwd, "Auth", "Race safe", "alice");
  const f = c.reportFinding(cwd, a.id, "Race condition", "bob");
  assert.equal(c.task(cwd, a.id).status, "needs_work");
  assert.throws(
    () => c.setStatus(cwd, a.id, "verified", "alice"),
    /Open findings/,
  );
  assert.throws(
    () => c.resolveFinding(cwd, a.id, f.id, "alice", ""),
    /rationale/,
  );
  c.resolveFinding(cwd, a.id, f.id, "alice", "Fixed by serializing refresh");
  assert.equal(c.task(cwd, a.id).findings[0].status, "resolved");
});
test("invalid ID rejected", (t) => {
  assert.throws(() => c.task(fixture(t), "../../etc/passwd"), /Invalid ID/);
});
test("stale task save cannot erase a finding", (t) => {
  const cwd = fixture(t),
    a = c.addTask(cwd, "Race", "No loss");
  const stale = c.task(cwd, a.id);
  c.reportFinding(cwd, a.id, "Keep me", "bob");
  assert.throws(() => c.saveTask(cwd, stale), /Concurrent update/);
  assert.equal(c.task(cwd, a.id).findings.length, 1);
});
test("shared handoff survives missing private logs", (t) => {
  const cwd = fixture(t),
    a = c.addTask(cwd, "Share", "Receipt readable");
  c.recordEvidence(cwd, a.id, "node --test", "pass");
  fs.rmSync(path.join(s.root(cwd), "local"), { recursive: true, force: true });
  assert.match(c.handoff(cwd, a.id), /manual-attestation/);
});
test("ownership transfers only after intended recipient acknowledgment", (t) => {
  const cwd = fixture(t),
    a = c.addTask(cwd, "Transfer", "Keep context", "alice");
  assert.throws(() => c.claim(cwd, a.id, "bob"), /offer/);
  c.offer(cwd, a.id, "alice", "bob", "Review code");
  assert.equal(c.task(cwd, a.id).owner, "alice");
  assert.throws(() => c.receive(cwd, a.id, "eve"), /addressed/);
  c.receive(cwd, a.id, "bob");
  assert.equal(c.task(cwd, a.id).owner, "bob");
  assert.match(c.handoff(cwd, a.id), /Review code/);
});
test("criteria, transitions and attribution are validated", (t) => {
  const cwd = fixture(t);
  assert.throws(() => c.addTask(cwd, "Empty"), /criteria/);
  const a = c.addTask(cwd, "Work", "Works", "alice");
  assert.throws(
    () => c.setStatus(cwd, a.id, "implemented", "alice"),
    /Invalid transition/,
  );
  assert.throws(() => c.setStatus(cwd, a.id, "in_progress", "bob"), /owned/);
  c.setStatus(cwd, a.id, "in_progress", "alice");
});
test("related work uses declared path scope", (t) => {
  const cwd = fixture(t),
    a = c.addTask(cwd, "A", "A", "alice", ["src/auth"]);
  const b = c.addTask(cwd, "B", "B", "bob", ["src/auth/token.js"]);
  c.addTask(cwd, "C", "C", "eve", ["docs"]);
  assert.deepEqual(
    c.context(cwd, a.id).related.map((x) => x.id),
    [b.id],
  );
});
test("scope paths are trimmed, normalized and deduplicated in order", (t) => {
  const cwd = fixture(t);
  const a = c.addTask(cwd, "N", "N", "alice", [
    "  ./src/auth/ ",
    "src/auth",
    "././docs//",
    "test",
    "./test/",
  ]);
  assert.deepEqual(c.task(cwd, a.id).scope, ["src/auth", "docs", "test"]);
  assert.deepEqual(c.addTask(cwd, "D", "D", "alice").scope, []);
  assert.deepEqual(c.normalizeScope(), []);
  assert.deepEqual(c.normalizeScope([]), []);
});
test("invalid scope inputs are rejected before a task is persisted", (t) => {
  const cwd = fixture(t);
  const cases = [
    ["src/auth", /expected an array/],
    [null, /expected an array/],
    [{ 0: "src" }, /expected an array/],
    [[42], /expected a string/],
    [[null], /expected a string/],
    [[""], /empty path/],
    [["   "], /empty path/],
    [["/etc/passwd"], /repository-relative/],
    [["C:/src"], /repository-relative/],
    [["src\\auth"], /POSIX/],
    [["."], /inside the repository/],
    [["./"], /inside the repository/],
    [["./."], /inside the repository/],
    [[".."], /"\.\." segments/],
    [["../outside"], /"\.\." segments/],
    [["src/../secrets"], /"\.\." segments/],
    [["src/.."], /"\.\." segments/],
    [["src//auth"], /segments/],
    [["src/./auth"], /segments/],
    [["ok", "../bad"], /"\.\." segments/],
  ];
  for (const [scope, err] of cases)
    assert.throws(
      () => c.addTask(cwd, "Bad", "Bad", "alice", scope),
      err,
      JSON.stringify(scope),
    );
  assert.deepEqual(c.tasks(cwd), []);
  assert.deepEqual(c.normalizeScope(["..foo", "a..b/c"]), ["..foo", "a..b/c"]);
});
test("equivalent scope spellings still find overlapping teammate work", (t) => {
  const cwd = fixture(t),
    a = c.addTask(cwd, "A", "A", "alice", ["./src/auth/"]);
  const b = c.addTask(cwd, "B", "B", "bob", [" src/auth/token.js "]);
  const d = c.addTask(cwd, "D", "D", "dana", ["src/auth"]);
  c.addTask(cwd, "C", "C", "eve", ["src/authz", "docs/"]);
  assert.deepEqual(
    c.context(cwd, a.id).related.map((x) => x.id).sort(),
    [b.id, d.id].sort(),
  );
  assert.deepEqual(
    c.context(cwd, b.id).related.map((x) => x.id).sort(),
    [a.id, d.id].sort(),
  );
});
test("legacy missing private evidence migrates without fabricating success", (t) => {
  const cwd = fixture(t);
  s.atomic(path.join(s.root(cwd), "project.json"), { schema: 1 });
  const id = "task-12345678";
  s.atomic(s.file(cwd, "tasks", id), {
    id,
    title: "Old",
    criteria: "Works",
    status: "implemented",
    decisions: [],
    evidence: ["evidence-12345678"],
    findings: [],
    reviews: [],
    history: [],
  });
  c.migrate(cwd);
  assert.match(c.handoff(cwd, id), /unavailable/);
  assert.equal(c.verification(cwd, id).eligible, false);
  assert.equal(c.migrate(cwd).migrated, false);
});
test("project decisions record proposer and acceptor and supersede explicitly", (t) => {
  const cwd = fixture(t);
  assert.deepEqual(c.projectDecisions(cwd), []);
  assert.throws(
    () => c.proposeProjectDecision(cwd, "Mobile first", "Phones", ""),
    /Actor required/,
  );
  assert.throws(
    () => c.proposeProjectDecision(cwd, "Mobile first", "", "bob"),
    /rationale/,
  );
  const a = c.proposeProjectDecision(cwd, "Mobile first", "Most shoppers use phones", "bob");
  assert.equal(a.status, "proposed");
  assert.throws(
    () => c.proposeProjectDecision(cwd, "Desktop first", "Admins", "alice", a.id),
    /supersede an accepted/,
  );
  const task = c.addTask(cwd, "Checkout", "Works", "alice");
  assert.match(c.handoff(cwd, task.id), /proposed by bob, not yet accepted\] Mobile first/);
  c.acceptDecision(cwd, a.id, "alice");
  assert.throws(() => c.acceptDecision(cwd, a.id, "alice"), /already finalized/);
  assert.match(c.handoff(cwd, task.id), /accepted by alice\] Mobile first/);
  const b = c.proposeProjectDecision(cwd, "Responsive web, no native app", "Pilot scope", "alice", a.id);
  const rival = c.proposeProjectDecision(cwd, "Native app", "Push notifications", "bob", a.id);
  c.acceptDecision(cwd, b.id, "bob");
  const all = Object.fromEntries(c.projectDecisions(cwd).map((d) => [d.id, d]));
  assert.equal(all[a.id].status, "superseded");
  assert.equal(all[a.id].supersededBy, b.id);
  assert.equal(all[b.id].acceptedBy, "bob");
  assert.throws(
    () => c.acceptDecision(cwd, rival.id, "alice"),
    /Superseded decision is superseded/,
  );
  assert.equal(c.projectDecisions(cwd).find((d) => d.id === rival.id).status, "proposed");
  const text = c.handoff(cwd, task.id);
  assert.doesNotMatch(text, /\] Mobile first/);
  assert.match(text, /Responsive web/);
});
test("task decisions record who proposed them", (t) => {
  const cwd = fixture(t),
    a = c.addTask(cwd, "Refresh", "Safe", "alice");
  const d = c.addDecision(cwd, a.id, "Single flight", "No duplicate rotation", "bob");
  assert.equal(d.proposedBy, "bob");
  assert.equal(
    c.task(cwd, a.id).history.find((e) => e.event === "decision_proposed").actor,
    "bob",
  );
  c.acceptDecision(cwd, d.id, "alice");
  assert.match(c.handoff(cwd, a.id), /proposed by bob, accepted by alice\] Single flight/);
});

test("timestamps from one process strictly increase, so ordering never depends on ties", async () => {
  const s = await import("../lib/store.js");
  const seen = Array.from({ length: 500 }, () => s.now());
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], `${seen[i - 1]} then ${seen[i]}`);
});
