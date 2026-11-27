import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git } from "../lib/git.js";
import { cleanupPlan, cleanup } from "../lib/cleanup.js";

function repo(t) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-clean-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(cwd, "a.txt"), "a\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "init"]);
  return cwd;
}
function branchWithWork(cwd, name, { worktree = true } = {}) {
  const wt = path.join(cwd, "..", `${path.basename(cwd)}-${name}`);
  git(cwd, ["worktree", "add", "-b", name, wt]);
  fs.writeFileSync(path.join(wt, `${name}.txt`), "x\n");
  git(wt, ["add", "."]);
  git(wt, ["commit", "-m", name]);
  const head = git(wt, ["rev-parse", "HEAD"]);
  if (!worktree) git(cwd, ["worktree", "remove", wt]);
  return { wt, head };
}
const branches = (cwd) => git(cwd, ["branch", "--format=%(refname:short)"]).split("\n");

test("done removes a merged task's clean worktree and branch, and keeps anything it cannot prove merged", (t) => {
  const cwd = repo(t);
  const merged = branchWithWork(cwd, "feat-a");
  t.after(() => fs.rmSync(merged.wt, { recursive: true, force: true }));
  const noTree = branchWithWork(cwd, "feat-b", { worktree: false });
  const dirty = branchWithWork(cwd, "feat-dirty");
  t.after(() => fs.rmSync(dirty.wt, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dirty.wt, "wip.txt"), "unsaved\n");
  const ahead = branchWithWork(cwd, "feat-ahead");
  t.after(() => fs.rmSync(ahead.wt, { recursive: true, force: true }));
  const prHead = ahead.head;
  fs.writeFileSync(path.join(ahead.wt, "more.txt"), "after merge\n");
  git(ahead.wt, ["add", "."]);
  git(ahead.wt, ["commit", "-m", "after merge"]);

  const plan = cleanupPlan(cwd, [
    { branch: "feat-a", head: merged.head, pr: 1 },
    { branch: "feat-b", head: noTree.head, pr: 2 },
    { branch: "feat-dirty", head: dirty.head, pr: 3 },
    { branch: "feat-ahead", head: prHead, pr: 4 },
    { branch: "feat-unknown", head: undefined, pr: 5 },
    { branch: "main", head: git(cwd, ["rev-parse", "HEAD"]), pr: 6 },
  ]);
  assert.deepEqual(plan.remove.map((x) => [x.branch, Boolean(x.worktree)]), [["feat-a", true], ["feat-b", false]]);
  assert.deepEqual(plan.keep.map((x) => [x.branch, x.why]), [
    ["feat-dirty", "its worktree has uncommitted changes"],
    ["feat-ahead", "it has commits that are not in the merged pull request"],
  ]);
  assert.equal(cleanupPlan(cwd, [{ branch: "feat-b", pr: 2 }]).keep[0].why, "GitHub did not say which commit was merged");
  const r = cleanup(cwd, plan);
  assert.deepEqual(r.failed, []);
  assert.ok(!fs.existsSync(merged.wt), "the merged worktree is gone");
  assert.ok(fs.existsSync(path.join(dirty.wt, "wip.txt")), "uncommitted work is untouched");
  assert.deepEqual(branches(cwd).sort(), ["feat-ahead", "feat-dirty", "main"]);
});

test("done never removes the branch you are standing on", (t) => {
  const cwd = repo(t);
  git(cwd, ["checkout", "-b", "feat-here"]);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const plan = cleanupPlan(cwd, [{ branch: "feat-here", head, pr: 1 }]);
  assert.deepEqual(plan.remove, []);
  assert.match(plan.keep[0].why, /checked out here/);
});
