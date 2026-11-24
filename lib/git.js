import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { digest } from "./store.js";
export function git(cwd, args) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30000,
  });
  if (r.error || r.status !== 0)
    throw Error(`Git failed: ${r.error?.message || r.stderr}`);
  return r.stdout.trimEnd();
}
const paths = [".", ":(exclude).agentbridge"];
export function snapshot(cwd) {
  if (
    fs.realpathSync(cwd) !==
    fs.realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]))
  )
    throw Error("Run from the Git project root");
  const revision = git(cwd, ["rev-parse", "HEAD"]);
  const dirty = git(cwd, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ...paths,
  ]);
  if (dirty)
    throw Error(
      "Commit code changes first: verification requires a clean code working tree (AgentBridge records excluded)",
    );
  const entries = git(cwd, ["ls-tree", "-r", "-z", "--full-tree", revision])
    .split("\0")
    .filter(
      (entry) =>
        entry &&
        !entry.split("\t").slice(1).join("\t").startsWith(".agentbridge/"),
    )
    .join("\0");
  if (entries.split("\0").some((l) => l.startsWith("160000 ")))
    throw Error("Submodules are not supported by this verification slice");
  return { revision, codeDigest: digest(entries) };
}
export function patch(cwd, base) {
  if (!/^[a-f0-9]{40,64}$/.test(base)) throw Error("Invalid base revision");
  const text = git(cwd, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    base,
    "HEAD",
    "--",
    ...paths,
  ]);
  if (Buffer.byteLength(text) > 200000)
    throw Error(
      "Patch exceeds 200 KB review limit; split the task (no truncation)",
    );
  return { text, digest: digest(text) };
}
