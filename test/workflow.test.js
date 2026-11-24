import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as c from "../lib/core.js";
import * as w from "../lib/workflow.js";
import * as s from "../lib/store.js";
import { git, snapshot, patch } from "../lib/git.js";
import { runProcess } from "../lib/process.js";
import {
  providerCommand,
  invokeProvider,
  validateReview,
  providerTimeout,
  resolveBinary,
  defaultTimeouts,
} from "../lib/providers.js";
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-flow-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(cwd, "app.cjs"), "module.exports = 1;\n");
  fs.writeFileSync(
    path.join(cwd, "check.cjs"),
    "require('node:assert/strict').equal(require('./app.cjs'), 2);\n",
  );
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "Initial fixture"]);
  c.init(cwd);
  const task = c.addTask(cwd, "Return two", "Returns two", "alice", [
    "app.cjs",
  ]);
  c.configureTest(
    cwd,
    task.id,
    "alice",
    "functional",
    [process.execPath, "check.cjs"],
    ["c1"],
  );
  const work = c.createWorkspace(cwd, task.id, "alice").workspace;
  return { cwd, id: task.id, work };
}
const implementMock = async ({ cwd }) => {
  fs.writeFileSync(path.join(cwd, "app.cjs"), "module.exports = 2;\n");
  return { summary: "Implemented" };
};
const reviewMock = async () => ({
  outcome: "pass",
  summary: "Meets criterion",
  findings: [],
});
async function ready(t) {
  const f = fixture(t);
  await w.implement(f.cwd, f.id, "alice", "claude", { invoke: implementMock });
  git(f.work, ["add", "app.cjs"]);
  git(f.work, ["commit", "-m", "Implement two"]);
  await w.review(f.cwd, f.id, "alice", "codex", { invoke: reviewMock });
  return f;
}
test("two people / two mock providers / real tests / fresh clone / stale evidence", async (t) => {
  const f = fixture(t);
  const d = c.addDecision(
    f.cwd,
    f.id,
    "Use numeric return",
    "Caller expects a number",
  );
  c.acceptDecision(f.cwd, d.id, "alice");
  await w.implement(f.cwd, f.id, "alice", "claude", { invoke: implementMock });
  git(f.work, ["add", "app.cjs"]);
  git(f.work, ["commit", "-m", "Implement"]);
  c.offer(
    f.cwd,
    f.id,
    "alice",
    "bob",
    "Review the implementation and run checks",
  );
  c.receive(f.cwd, f.id, "bob");
  await w.review(f.cwd, f.id, "bob", "codex", {
    invoke: async () => ({
      outcome: "needs_work",
      summary: "Document rationale",
      findings: [
        { description: "Confirm numeric return decision", severity: "low" },
      ],
    }),
  });
  const finding = c.task(f.cwd, f.id).findings[0];
  assert.throws(
    () => c.setStatus(f.cwd, f.id, "verified", "bob"),
    /Open findings/,
  );
  c.resolveFinding(
    f.cwd,
    f.id,
    finding.id,
    "bob",
    "Accepted decision documents numeric return",
  );
  await w.review(f.cwd, f.id, "bob", "codex", { invoke: reviewMock });
  const run = await w.runTests(f.cwd, f.id, "bob");
  assert.equal(run.state, "succeeded");
  assert.equal(run.snapshot.revision, git(f.work, ["rev-parse", "HEAD"]));
  c.setStatus(f.cwd, f.id, "verified", "bob");
  c.setStatus(f.cwd, f.id, "done", "bob");
  assert.equal(c.status(f.cwd, f.id).effectiveStatus, "done");
  git(f.cwd, ["add", ".agentbridge"]);
  git(f.cwd, ["commit", "-m", "Share collaboration records"]);
  const clone = path.join(f.cwd, "..", `${path.basename(f.cwd)}-clone`);
  t.after(() => fs.rmSync(clone, { recursive: true, force: true }));
  git(f.cwd, ["clone", f.cwd, clone]);
  assert.match(c.handoff(clone, f.id), /Use numeric return/);
  assert.match(c.handoff(clone, f.id), /verified-run/);
  assert.equal(c.task(clone, f.id).owner, "bob");
  assert.equal(fs.existsSync(path.join(s.root(clone), "local", "runs")), false);
  assert.equal(c.status(clone, f.id).effectiveStatus, "done-unchecked");
  assert.match(c.handoff(clone, f.id), /not checked in this checkout/);
  assert.deepEqual(
    c.context(clone, f.id).related,
    [],
    "unchecked done work is not reported as active related work",
  );
  const cloneWork = path.join(s.root(clone), "local", "peer-work");
  git(clone, ["worktree", "add", "--detach", cloneWork, run.snapshot.revision]);
  c.attachWorkspace(clone, f.id, "bob", cloneWork);
  assert.equal(c.status(clone, f.id).effectiveStatus, "done");
  fs.appendFileSync(path.join(cloneWork, "app.cjs"), "// later change\n");
  git(cloneWork, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "add",
    "app.cjs",
  ]);
  git(cloneWork, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Later change",
  ]);
  assert.equal(c.status(clone, f.id).effectiveStatus, "stale");
  assert.match(c.handoff(clone, f.id), /evidence is stale/);
});
test("dirty tracked, staged and untracked code cannot be verified", async (t) => {
  const f = await ready(t);
  for (const staged of [false, true]) {
    fs.appendFileSync(path.join(f.work, "app.cjs"), "// change\n");
    if (staged) git(f.work, ["add", "app.cjs"]);
    assert.throws(() => snapshot(f.work), /clean code/);
    git(f.work, ["restore", "--staged", "app.cjs"]);
    git(f.work, ["restore", "app.cjs"]);
  }
  fs.writeFileSync(path.join(f.work, "new.js"), "x");
  assert.throws(() => snapshot(f.work), /clean code/);
});
test("failed latest test invalidates earlier pass, later rerun can recover", async (t) => {
  const f = await ready(t);
  await w.runTests(f.cwd, f.id, "alice");
  c.configureTest(
    f.cwd,
    f.id,
    "alice",
    "functional",
    [process.execPath, "-e", "process.exit(7)"],
    ["c1"],
  );
  const failed = await w.runTests(f.cwd, f.id, "alice");
  assert.equal(failed.state, "failed");
  assert.equal(c.verification(f.cwd, f.id).eligible, false);
  c.configureTest(
    f.cwd,
    f.id,
    "alice",
    "functional",
    [process.execPath, "check.cjs"],
    ["c1"],
  );
  await w.runTests(f.cwd, f.id, "alice");
  assert.equal(c.verification(f.cwd, f.id).eligible, true);
  assert.ok(c.task(f.cwd, f.id).evidence.some((e) => e.exitCode === 7));
});
test("test code mutation rejects evidence", async (t) => {
  const f = await ready(t);
  c.configureTest(
    f.cwd,
    f.id,
    "alice",
    "functional",
    [
      process.execPath,
      "-e",
      "require('node:fs').appendFileSync('app.cjs','//changed')",
    ],
    ["c1"],
  );
  const r = await w.runTests(f.cwd, f.id, "alice");
  assert.equal(r.state, "failed");
  assert.equal(c.task(f.cwd, f.id).evidence.at(-1).reason, "code-changed");
});
test("same-provider review and malformed reviews are rejected", async (t) => {
  const f = await ready(t);
  await assert.rejects(w.review(f.cwd, f.id, "alice", "claude"), /different/);
  await assert.rejects(
    w.review(f.cwd, f.id, "alice", "codex", {
      invoke: async () => ({
        outcome: "pass",
        findings: [{ description: "Bug", severity: "high" }],
        summary: "bad",
      }),
    }),
    /cannot contain/,
  );
  assert.equal(c.task(f.cwd, f.id).activeRun, null);
  assert.equal(c.verification(f.cwd, f.id).eligible, false);
});
test("review mutation is detected", async (t) => {
  const f = await ready(t);
  await assert.rejects(
    w.review(f.cwd, f.id, "alice", "codex", {
      invoke: async () => {
        fs.appendFileSync(path.join(f.work, "app.cjs"), "// changed");
        return reviewMock();
      },
    }),
    /clean code/,
  );
});
test("process timeout, output bounds, spawn failure and argv safety", async (t) => {
  const f = fixture(t);
  const timeout = await runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { cwd: f.work, timeoutMs: 50 },
  );
  assert.equal(timeout.reason, "timeout");
  const excess = await runProcess(
    process.execPath,
    ["-e", 'console.log("x".repeat(10000))'],
    { cwd: f.work, maxBytes: 100 },
  );
  assert.equal(excess.reason, "output-limit");
  const missing = await runProcess("nonexistent-agentbridge-command", [], {
    cwd: f.work,
  });
  assert.equal(missing.reason, "ENOENT");
  const literal = "$(touch injected)";
  const out = await runProcess(
    process.execPath,
    ["-e", "console.log(process.argv[1])", literal],
    { cwd: f.work },
  );
  assert.equal(out.stdout.trim(), literal);
  assert.equal(fs.existsSync(path.join(f.work, "injected")), false);
});
test("provider adapters parse protocol envelopes without claiming live integration", async (t) => {
  const f = fixture(t),
    dir = path.join(f.cwd, "artifacts");
  fs.mkdirSync(dir);
  const codex = providerCommand("codex", "review", dir);
  assert.ok(codex.args.includes("read-only"));
  assert.ok(codex.args.includes("--output-schema"));
  const claude = providerCommand("claude", "implement", dir);
  assert.ok(!claude.args.join(" ").includes("bypass"));
  const result = await invokeProvider(
    {
      provider: "claude",
      kind: "review",
      cwd: f.work,
      prompt: "test",
      artifactDir: dir,
    },
    async () => ({
      exitCode: 0,
      reason: null,
      stdout: JSON.stringify({
        is_error: false,
        structured_output: await reviewMock(),
      }),
      stderr: "",
    }),
  );
  assert.equal(result.outcome, "pass");
  await assert.rejects(
    invokeProvider(
      {
        provider: "claude",
        kind: "implement",
        cwd: f.work,
        prompt: "test",
        artifactDir: dir,
      },
      async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ permission_denials: [{}], result: "done" }),
        stderr: "",
      }),
    ),
    /denied/,
  );
  assert.throws(
    () =>
      validateReview({ outcome: "needs_work", summary: "bad", findings: [] }),
    /actionable/,
  );
});
test("bounded attempts and interrupted state recovery", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++)
    await assert.rejects(
      w.implement(f.cwd, f.id, "alice", "claude", {
        invoke: async () => {
          throw Error("offline");
        },
      }),
      /offline/,
    );
  await assert.rejects(
    w.implement(f.cwd, f.id, "alice", "claude", { invoke: implementMock }),
    /exhausted/,
  );
  assert.equal(c.task(f.cwd, f.id).attempts, 3);
  s.mutate(f.cwd, f.id, (t) => {
    t.activeRun = "run-interrupted";
    t.runs.push({ id: "run-interrupted", kind: "review", state: "running" });
  });
  w.recover(f.cwd, f.id, "alice");
  assert.equal(c.task(f.cwd, f.id).runs.at(-1).state, "interrupted");
});
test("active execution blocks transfer and concurrent execution, preserves new findings", async (t) => {
  const f = fixture(t);
  await w.implement(f.cwd, f.id, "alice", "claude", {
    invoke: async () => {
      assert.throws(
        () => c.offer(f.cwd, f.id, "alice", "bob", "Take over"),
        /active run/,
      );
      await assert.rejects(w.implement(f.cwd, f.id, "alice", "codex"), /lock/);
      c.reportFinding(f.cwd, f.id, "Keep during execution", "bob");
      return implementMock({ cwd: f.work });
    },
  });
  assert.equal(c.task(f.cwd, f.id).findings.length, 1);
  assert.equal(c.task(f.cwd, f.id).status, "needs_work");
});
test("oversized review fails instead of truncating", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.work, "large.txt"), "a".repeat(210000));
  git(f.work, ["add", "large.txt"]);
  git(f.work, ["commit", "-m", "Large"]);
  assert.throws(
    () => patch(f.work, c.task(f.cwd, f.id).baseRevision),
    /exceeds/,
  );
});
test("CLI errors are nonzero and test failures propagate", (t) => {
  const f = fixture(t),
    bin = path.resolve("bin/agentbridge.js");
  const unknown = spawnSync(process.execPath, [bin, "unknown"], { cwd: f.cwd });
  assert.equal(unknown.status, 1);
  const fail = spawnSync(
    process.execPath,
    [bin, "test", "run", f.id, "--actor", "alice"],
    { cwd: f.cwd, encoding: "utf8" },
  );
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /failed/);
});
test("accepted decisions invalidate an existing review", async (t) => {
  const f = await ready(t);
  await w.runTests(f.cwd, f.id, "alice");
  assert.equal(c.verification(f.cwd, f.id).eligible, true);
  const d = c.addDecision(
    f.cwd,
    f.id,
    "Return integer",
    "New accepted requirement",
  );
  c.acceptDecision(f.cwd, d.id, "alice");
  assert.match(
    c.verification(f.cwd, f.id).reasons.join(";"),
    /decisions or criteria changed/,
  );
});
test("complete CLI workflow with fake provider executables and real test process", async (t) => {
  const f = fixture(t),
    bin = path.resolve("bin/agentbridge.js"),
    fakeBin = path.join(s.root(f.cwd), "local", "fake-bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "claude"),
    `#!/usr/bin/env node\n(async()=>{let input='';for await (const chunk of process.stdin)input+=chunk;if(!input.includes('Returns two'))process.exit(3);const fs=await import('node:fs');fs.writeFileSync('app.cjs','module.exports = 2;\\n');console.log(JSON.stringify({is_error:false,result:'Implemented',permission_denials:[]}));})();\n`,
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "codex"),
    `#!/usr/bin/env node\n(async()=>{let input='';for await (const chunk of process.stdin)input+=chunk;if(!input.includes('PATCH'))process.exit(4);const fs=await import('node:fs');const args=process.argv.slice(2);fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({outcome:'pass',summary:'Reviewed fixture',findings:[]}));})();\n`,
    { mode: 0o700 },
  );
  // Executable scripts use CommonJS-safe dynamic imports; no live provider access.
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [bin, ...args], {
      cwd: f.cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      },
      timeout: 15000,
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  cli("implement", f.id, "--actor", "alice", "--provider", "claude");
  git(f.work, ["add", "app.cjs"]);
  git(f.work, ["commit", "-m", "CLI implementation"]);
  cli(
    "handoff",
    "offer",
    f.id,
    "--actor",
    "alice",
    "--to",
    "bob",
    "--next",
    "Review and test",
  );
  cli("handoff", "receive", f.id, "--actor", "bob");
  cli("review", f.id, "--actor", "bob", "--provider", "codex");
  cli("test", "run", f.id, "--actor", "bob");
  cli("verify", f.id, "--actor", "bob");
  cli("accept", f.id, "--actor", "bob");
  assert.equal(cli("task", "show", f.id).effectiveStatus, "done");
});
test("rerunning tests reopens accepted work until explicit reacceptance", async (t) => {
  const f = await ready(t);
  await w.runTests(f.cwd, f.id, "alice");
  c.setStatus(f.cwd, f.id, "verified", "alice");
  c.setStatus(f.cwd, f.id, "done", "alice");
  await w.runTests(f.cwd, f.id, "alice");
  assert.equal(c.status(f.cwd, f.id).effectiveStatus, "implemented");
  assert.equal(c.task(f.cwd, f.id).acceptance, null);
  assert.throws(
    () => c.setStatus(f.cwd, f.id, "done", "alice"),
    /Verify before/,
  );
});
test("all criteria require mapped checks and live locks cannot be recovered", async (t) => {
  const f = await ready(t);
  await w.runTests(f.cwd, f.id, "alice");
  s.mutate(f.cwd, f.id, (t) =>
    t.criteria.push({ id: "c2", text: "Additional acceptance requirement" }),
  );
  assert.match(
    c.verification(f.cwd, f.id).reasons.join(";"),
    /lack configured checks/,
  );
  const release = s.lock(f.cwd, "execution");
  try {
    assert.throws(() => s.recoverLock(f.cwd, "execution"), /still running/);
  } finally {
    release();
  }
});
test("cancellation stops the subprocess and yields no success", async (t) => {
  const f = fixture(t);
  const running = runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { cwd: f.work, timeoutMs: 3000 },
  );
  const timer = setTimeout(() => process.emit("SIGINT"), 50);
  const result = await running;
  clearTimeout(timer);
  assert.equal(result.reason, "cancelled");
  assert.notEqual(result.exitCode, 0);
});
test("Claude pass with structured findings fails closed and a corrected review succeeds", async (t) => {
  const f = fixture(t);
  const dir = path.join(f.cwd, "claude-review-protocol");
  fs.mkdirSync(dir);
  const request = {
    provider: "claude",
    kind: "review",
    cwd: f.work,
    prompt: "Review fixture",
    artifactDir: dir,
  };
  const respond = (structured_output) => async () => ({
    exitCode: 0,
    reason: null,
    stdout: JSON.stringify({
      is_error: false,
      subtype: "success",
      structured_output,
    }),
    stderr: "",
  });
  await assert.rejects(
    invokeProvider(
      request,
      respond({
        outcome: "pass",
        summary: "Tests still pending",
        findings: [{ description: "Record test results", severity: "low" }],
      }),
    ),
    /Passing review cannot contain unresolved findings/,
  );
  const corrected = await invokeProvider(
    request,
    respond({
      outcome: "pass",
      summary: "Static review passed; test execution remains a separate gate",
      findings: [],
    }),
  );
  assert.equal(corrected.outcome, "pass");
  assert.deepEqual(corrected.findings, []);
});
test("unchecked status only hides a missing workspace, never record-level problems", async (t) => {
  const f = await ready(t);
  await w.runTests(f.cwd, f.id, "alice");
  c.setStatus(f.cwd, f.id, "verified", "alice");
  c.setStatus(f.cwd, f.id, "done", "alice");
  fs.rmSync(s.file(f.cwd, "local", f.id));
  assert.equal(c.status(f.cwd, f.id).effectiveStatus, "done-unchecked");
  c.reportFinding(f.cwd, f.id, "Regression found later", "bob");
  s.mutate(f.cwd, f.id, (t) => {
    t.status = "done";
  });
  assert.equal(c.status(f.cwd, f.id).effectiveStatus, "stale");
});
test("work done outside AgentBridge can be recorded and still needs separate review and tests", async (t) => {
  const f = fixture(t);
  assert.throws(
    () => w.recordImplementation(f.cwd, f.id, "alice", "claude", "Did it"),
    /No committed changes/,
  );
  fs.writeFileSync(path.join(f.work, "app.cjs"), "module.exports = 2;\n");
  assert.throws(
    () => w.recordImplementation(f.cwd, f.id, "alice", "claude", "Did it"),
    /Commit code changes first/,
  );
  git(f.work, ["commit", "-am", "Interactive Claude Code session"]);
  assert.throws(
    () => w.recordImplementation(f.cwd, f.id, "alice", "cursor", "Did it"),
    /Tool must be one of/,
  );
  assert.throws(
    () => w.recordImplementation(f.cwd, f.id, "alice", "claude", " "),
    /summary required/,
  );
  assert.throws(
    () => w.recordImplementation(f.cwd, f.id, "bob", "claude", "Did it"),
    /owned by alice/,
  );
  const run = w.recordImplementation(
    f.cwd,
    f.id,
    "alice",
    "claude",
    "Returned two from an interactive session",
  );
  assert.equal(run.source, "external-record");
  const t1 = c.task(f.cwd, f.id);
  assert.equal(t1.status, "implemented");
  assert.equal(t1.attempts, 1);
  assert.equal(t1.implementations[0].snapshot.revision, git(f.work, ["rev-parse", "HEAD"]));
  assert.match(c.handoff(f.cwd, f.id), /alice via claude \(recorded after the fact; a claim\)/);
  assert.match(
    c.verification(f.cwd, f.id).reasons.join(";"),
    /Passing separate review required/,
  );
  await assert.rejects(
    w.review(f.cwd, f.id, "alice", "claude", { invoke: reviewMock }),
    /different supported provider/,
  );
  await w.review(f.cwd, f.id, "alice", "codex", { invoke: reviewMock });
  await w.runTests(f.cwd, f.id, "alice");
  c.setStatus(f.cwd, f.id, "verified", "alice");
  assert.equal(c.status(f.cwd, f.id).effectiveStatus, "verified");
});
test("human-recorded implementation may be reviewed by either provider; attempts stay bounded", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.work, "app.cjs"), "module.exports = 2;\n");
  git(f.work, ["commit", "-am", "Hand-written change"]);
  w.recordImplementation(f.cwd, f.id, "alice", "human", "Manual edit");
  await w.review(f.cwd, f.id, "alice", "claude", { invoke: reviewMock });
  w.recordImplementation(f.cwd, f.id, "alice", "human", "Second pass");
  w.recordImplementation(f.cwd, f.id, "alice", "human", "Third pass");
  assert.throws(
    () => w.recordImplementation(f.cwd, f.id, "alice", "human", "Fourth"),
    /attempts exhausted/,
  );
  assert.match(
    c.verification(f.cwd, f.id).reasons.join(";"),
    /Review predates latest implementation/,
  );
});
test("provider timeouts default per role, are configurable and bounded", async (t) => {
  assert.equal(providerTimeout("implement"), defaultTimeouts.implement);
  assert.equal(providerTimeout("review"), defaultTimeouts.review);
  assert.ok(defaultTimeouts.implement >= 1800000);
  assert.equal(providerTimeout("implement", "2400000"), 2400000);
  for (const bad of ["abc", "999", "7200001", "1500.5"])
    assert.throws(() => providerTimeout("implement", bad), /Timeout must be/);
  const f = fixture(t),
    seen = [];
  await w.implement(f.cwd, f.id, "alice", "claude", {
    timeoutMs: 2400000,
    invoke: async (req) => {
      seen.push(req.timeoutMs);
      return implementMock(req);
    },
  });
  git(f.work, ["commit", "-am", "Implement"]);
  await w.review(f.cwd, f.id, "alice", "codex", {
    invoke: async (req) => {
      seen.push(req.timeoutMs);
      return reviewMock();
    },
  });
  assert.deepEqual(seen, [2400000, defaultTimeouts.review]);
  await assert.rejects(
    w.implement(f.cwd, f.id, "alice", "claude", {
      timeoutMs: 5,
      invoke: implementMock,
    }),
    /Timeout must be/,
  );
  assert.equal(c.task(f.cwd, f.id).attempts, 1, "invalid timeout uses no attempt");
  const dir = path.join(f.cwd, "artifacts");
  fs.mkdirSync(dir);
  const passed = [];
  await invokeProvider(
    { provider: "claude", kind: "implement", cwd: f.work, prompt: "x", artifactDir: dir },
    async (cmd, args, opts) => {
      passed.push(opts.timeoutMs);
      return { exitCode: 0, reason: null, stdout: JSON.stringify({ result: "ok" }), stderr: "" };
    },
  );
  assert.deepEqual(passed, [defaultTimeouts.implement]);
});
test("provider binaries resolve from override, PATH, then a known app bundle", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "codex");
  fs.writeFileSync(fake, "#!/bin/sh\n", { mode: 0o700 });
  const empty = path.join(dir, "empty");
  fs.mkdirSync(empty);
  assert.equal(
    resolveBinary("codex", { AGENTBRIDGE_CODEX_BIN: fake, PATH: empty }),
    fake,
  );
  assert.throws(
    () => resolveBinary("codex", { AGENTBRIDGE_CODEX_BIN: "codex", PATH: dir }),
    /absolute path/,
  );
  assert.throws(
    () =>
      resolveBinary("codex", {
        AGENTBRIDGE_CODEX_BIN: path.join(dir, "missing"),
        PATH: dir,
      }),
    /absolute path/,
  );
  assert.equal(resolveBinary("codex", { PATH: dir }), "codex");
  assert.equal(resolveBinary("claude", { PATH: empty }), "claude");
  const cmd = providerCommand("codex", "review", dir, {
    AGENTBRIDGE_CODEX_BIN: fake,
    PATH: empty,
  });
  assert.equal(cmd.command, fake);
});
test("CLI records decision proposers, project decisions and external implementations", (t) => {
  const f = fixture(t),
    bin = path.resolve("bin/agentbridge.js");
  const run = (...args) =>
    spawnSync(process.execPath, [bin, ...args], {
      cwd: f.cwd,
      encoding: "utf8",
      timeout: 15000,
    });
  const cli = (...args) => {
    const r = run(...args);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const unnamed = run("decision", "add", f.id, "No actor", "--why", "Because");
  assert.equal(unnamed.status, 0, unnamed.stderr);
  assert.ok(JSON.parse(unnamed.stdout).proposedBy, "a person in a terminal needs no --actor");
  const d = cli("decision", "add", f.id, "Numbers", "--why", "Callers", "--actor", "bob");
  assert.equal(d.proposedBy, "bob");
  const p = cli("decision", "propose", "Mobile first", "--why", "Most shoppers are on phones", "--actor", "bob");
  cli("decision", "accept", p.id, "--actor", "alice");
  assert.equal(cli("decision", "list")[0].acceptedBy, "alice");
  fs.writeFileSync(path.join(f.work, "app.cjs"), "module.exports = 2;\n");
  git(f.work, ["commit", "-am", "Outside work"]);
  const rec = cli("implement", "record", f.id, "--actor", "alice", "--tool", "codex", "--summary", "Codex desktop session");
  assert.equal(rec.provider, "codex");
  const handoffText = cli("context", f.id).handoff;
  assert.match(handoffText, /accepted by alice\] Mobile first/);
  assert.match(handoffText, /proposed by bob\] Numbers/);
  const bad = run("implement", f.id, "--actor", "alice", "--provider", "claude", "--timeout", "10");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Timeout must be/);
});
