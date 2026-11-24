import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as c from "../lib/core.js";
import { summarize } from "../lib/summary.js";
import { git } from "../lib/git.js";

test("terminal summaries show the record in two or three lines and the next command to run", (t) => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-summary-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  git(cwd, ["init", "-q", "-b", "main"]);
  c.init(cwd);
  const d = c.proposeProjectDecision(cwd, "Mobile first", "Phones", "codex");
  assert.equal(summarize(d), `${d.id}  "Mobile first"\n  proposed by codex. A person accepts it with:\n  agentbridge decision accept ${d.id} --actor YOUR-NAME`);
  const accepted = c.acceptDecision(cwd, d.id, "alice");
  accepted.history.at(-1).sig = { key: "SHA256:YVm4A8MWUYXvqxKz+7f0", type: "ED25519", signature: "x" };
  assert.equal(summarize(accepted), `${d.id}  "Mobile first"\n  accepted by alice (signed SHA256:YVm4A8MW…)`);
  const task = c.addTask(cwd, "Canvas", "Renders", "claude", ["ui/lib"]);
  assert.equal(summarize(task), `${task.id}  "Canvas"\n  planned, owner claude, scope ui/lib`);
  const offered = c.offer(cwd, task.id, "claude", "codex", "Fix the nav chain");
  assert.match(summarize(offered), /offered to codex: Fix the nav chain\n  they accept with: agentbridge handoff receive [0-9a-f]{8} --actor codex$/);
  assert.match(summarize(c.addTask(cwd, "Loose", "ok", "bob")), /no scope claimed/);
  const pr = { number: 12, mergedAt: "2026-11-20T10:00:00Z", headRefName: "feat/canvas" };
  assert.match(summarize(c.closeMerged(cwd, c.addTask(cwd, "Shipped", "ok", "bob").id, "bob", pr)), /merged, owner bob.*\n  closed: PR #12 merged 2026-11-20; its paths are released$/);
  assert.match(summarize(c.cancel(cwd, c.addTask(cwd, "Dropped", "ok", "bob").id, "bob", "Duplicate")), /\n  cancelled: Duplicate$/);
  assert.equal(summarize({ allowed: true }), null, "anything else stays JSON");
});
