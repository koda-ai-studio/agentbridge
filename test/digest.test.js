import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as c from "../lib/core.js";
import { digest, digestText } from "../lib/digest.js";
import { git } from "../lib/git.js";
import { conforms } from "./schema.js";

function repo(t) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-digest-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  git(cwd, ["config", "agentbridge.person", "sam"]);
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src/pay.js"), "export {};\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "init"]);
  c.init(cwd);
  return cwd;
}

const openPrs = () => [
  { number: 12, title: "Cart totals", author: { login: "sam" }, headRefName: "claude/cart", isDraft: false },
  { number: 13, title: "Docs pass", author: { login: "dana" }, headRefName: "docs", isDraft: true },
];

test("digest is the catch-up: merged, finished, handoffs, decisions, findings, open work with linked PRs, untracked PRs and what waits on the person", (t) => {
  const cwd = repo(t);
  const shipped = c.addTask(cwd, "Checkout", "Pays", "claude", ["src/pay.js"]);
  c.closeMerged(cwd, shipped.id, "claude", { number: 9, mergedAt: new Date().toISOString(), headRefName: "claude/checkout" });
  const dropped = c.addTask(cwd, "Old idea", "x", "codex");
  c.cancel(cwd, dropped.id, "codex", "Superseded by checkout");
  const cart = c.addTask(cwd, "Cart", "Totals", "claude", ["src/cart"]);
  c.note(cwd, cart.id, "claude", "PR #12 · CI green · waiting on review");
  c.offer(cwd, cart.id, "claude", "codex", "Address review comments");
  c.receive(cwd, cart.id, "codex");
  c.reportFinding(cwd, cart.id, "Tax rounding off by a cent", "claude");
  const d = c.proposeProjectDecision(cwd, "Prices in cents", "Rounding", "claude");
  c.acceptDecision(cwd, d.id, "sam");
  c.proposeProjectDecision(cwd, "Drop IE", "Old", "codex");
  const search = c.addTask(cwd, "Search", "Finds", "claude");
  c.note(cwd, search.id, "claude", "PR #20 on claude/search");
  const twin = c.addTask(cwd, "Checkout copy", "Pays", "codex");
  c.closeMerged(cwd, twin.id, "codex", { number: 9, mergedAt: new Date().toISOString() });
  const offered = c.addTask(cwd, "Write docs", "Docs", "claude");
  c.offer(cwd, offered.id, "claude", "sam", "Start with the README");

  const r = digest(cwd, "sam", { merged: null, openPrs, viewPr: (_, n) => (n === 20 ? "merged" : null) });
  assert.deepEqual(r.merged.map((m) => [m.title, m.pr]), [["Checkout", 9], ["Checkout copy", 9]]);
  assert.deepEqual(r.working.find((w) => w.owner === "claude").tasks.find((x) => x.title === "Search").pr, { number: 20, state: "merged" }, "a PR named in a note but not open is looked up");
  assert.deepEqual(r.finished.map((f) => [f.title, f.how, f.reason]), [["Old idea", "cancelled", "Superseded by checkout"]]);
  assert.deepEqual(r.handoffs.map((h) => [h.title, h.from, h.to, h.state]), [["Cart", "claude", "codex", "accepted"], ["Write docs", "claude", "sam", "waiting"]]);
  assert.deepEqual(r.decisions.accepted.map((x) => x.summary), ["Prices in cents"]);
  assert.deepEqual(r.decisions.proposed.map((x) => x.summary), ["Drop IE"]);
  assert.deepEqual(r.findings.map((f) => f.description), ["Tax rounding off by a cent"]);
  const cartNow = r.working.find((w) => w.owner === "codex").tasks.find((x) => x.title === "Cart");
  assert.deepEqual(cartNow.pr, { number: 12, state: "open" }, "the PR named in the note is linked and its state read from GitHub");
  assert.deepEqual(r.pullRequests.withoutTask.map((p) => p.number), [13], "open PRs nobody tracks are listed");
  assert.ok(r.waitingOnYou.some((x) => /claude offers you "Write docs"/.test(x)));
  assert.ok(r.waitingOnYou.some((x) => /"Drop IE"/.test(x)));
  conforms(r, "digest");

  const text = digestText(r);
  for (const s of ["AgentBridge digest for sam", "Waiting on you (run agentbridge", "Merged\n  - PR #9: 2 tasks (claude, codex): \"Checkout\"; \"Checkout copy\"", "\"Cart\": claude → codex, accepted", "Decided\n  - Prices in cents (project, accepted by sam)", "Tax rounding off by a cent (on \"Cart\", by claude)", "codex: \"Cart\" [needs work] · PR #12 open · PR #12 · CI green", "Open pull requests with no AgentBridge task\n  - #13 Docs pass (dana), draft"])
    assert.ok(text.includes(s), s);
  assert.ok(!text.includes("Proposed, not yet decided"), "a proposal already waiting on the person is not listed twice");

  const again = digest(cwd, "sam", { merged: null, openPrs: null, advance: false });
  assert.equal(again.since, r.until, "the next digest starts where the last one ended");
  assert.deepEqual([again.merged, again.handoffs, again.findings], [[], [], []]);
  assert.equal(digest(cwd, "sam", { merged: null, openPrs: null }).since, r.until, "--peek did not move the cursor");
  assert.equal(digest(cwd, "sam", { since: "1d", merged: null, openPrs: null, advance: false }).merged.length, 2);
  assert.throws(() => digest(cwd, "sam", { since: "yesterday-ish" }), /--since/);

  const agent = digest(cwd, "claude", { merged: null, openPrs: null, since: "1d" });
  assert.equal(agent.person, "sam", "an agent's digest says what waits on its person");
  assert.match(digestText(agent), /Waiting on sam \(they run agentbridge/);

  const env = { ...process.env, CLAUDECODE: "", CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "", AI_AGENT: "", AGENTBRIDGE_GH_BIN: "/nonexistent/gh" };
  const mcp = spawnSync(process.execPath, [path.resolve("bin/agentbridge.js"), "mcp", "--actor", "codex"], {
    cwd, env, encoding: "utf8", timeout: 15000, input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "digest", arguments: { since: "1d" } } }) + "\n",
  });
  assert.equal(JSON.parse(mcp.stdout.trim()).result.structuredContent.merged[0].title, "Checkout");
  const cli = spawnSync(process.execPath, [path.resolve("bin/agentbridge.js"), "digest", "--since", "1d", "--format", "text"], { cwd, env, encoding: "utf8" });
  assert.match(cli.stdout, /^AgentBridge digest for sam/);
});

test("finding add acts as the session's agent and refuses another name inside a session", (t) => {
  const cwd = repo(t);
  const task = c.addTask(cwd, "Cart", "Totals", "claude");
  const run = (args, session) => spawnSync(process.execPath, [path.resolve("bin/agentbridge.js"), ...args], {
    cwd, encoding: "utf8", env: { ...process.env, CLAUDECODE: "", CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "", AI_AGENT: "", ...session },
  });
  assert.equal(run(["finding", "add", task.id, "Off by one"], { CODEX_THREAD_ID: "t1" }).status, 0);
  assert.equal(c.task(cwd, task.id).findings[0].author, "codex");
  assert.notEqual(run(["finding", "add", task.id, "Fake", "--by", "claude"], { CODEX_THREAD_ID: "t1" }).status, 0, "cannot report as another agent");
});
