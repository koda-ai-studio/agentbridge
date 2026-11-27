import fs from "node:fs";
import { git } from "./git.js";

const protectedBranches = new Set(["main", "master", "agentbridge-records"]);
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const ok = (cwd, args) => { try { git(cwd, args); return true; } catch { return false; } };

function worktrees(cwd) {
  return git(cwd, ["worktree", "list", "--porcelain"]).split("\n\n").filter(Boolean).map((block, i) => {
    const line = (k) => block.split("\n").find((l) => l.startsWith(`${k} `))?.slice(k.length + 1);
    return { path: line("worktree"), branch: line("branch")?.replace(/^refs\/heads\//, ""), main: i === 0 };
  });
}

export function cleanupPlan(cwd, merged) {
  const here = real(git(cwd, ["rev-parse", "--show-toplevel"]));
  let base = "";
  try { base = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, ""); } catch {}
  const trees = worktrees(cwd);
  const seen = new Set();
  const remove = [], keep = [];
  for (const { branch, head, pr } of merged) {
    if (!branch || seen.has(branch) || protectedBranches.has(branch) || branch === base) continue;
    seen.add(branch);
    if (!ok(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) continue;
    const tree = trees.find((w) => w.branch === branch);
    const item = { branch, pr, worktree: tree && !tree.main ? tree.path : undefined };
    const tip = git(cwd, ["rev-parse", `refs/heads/${branch}`]);
    if (!head) keep.push({ ...item, why: "GitHub did not say which commit was merged" });
    else if (!(tip === head || ok(cwd, ["merge-base", "--is-ancestor", tip, head])))
      keep.push({ ...item, why: "it has commits that are not in the merged pull request" });
    else if (tree && (tree.main || real(tree.path) === here))
      keep.push({ ...item, why: "it is checked out here; switch branches first" });
    else if (tree && git(tree.path, ["status", "--porcelain", "--untracked-files=all"]))
      keep.push({ ...item, why: "its worktree has uncommitted changes" });
    else remove.push(item);
  }
  return { remove, keep };
}

export function cleanup(cwd, plan) {
  const done = [], failed = [];
  for (const x of plan.remove) {
    try {
      if (x.worktree) git(cwd, ["worktree", "remove", x.worktree]);
      git(cwd, ["branch", "-D", x.branch]);
      done.push(x);
    } catch (e) {
      failed.push({ ...x, why: e.message.replace(/^Git failed: /, "").trim() });
    }
  }
  return { done, failed };
}
