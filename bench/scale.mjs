import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process";
const AB = path.resolve(new URL("..", import.meta.url).pathname);
const c = await import(`${AB}/lib/core.js`); const { git } = await import(`${AB}/lib/git.js`);
const N = Number(process.argv[2] || 1000), WS = Number(process.argv[3] || 0);
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ab-bench-")));
git(cwd, ["init", "-q", "-b", "main"]); git(cwd, ["config", "user.email", "t@e.invalid"]); git(cwd, ["config", "user.name", "t"]); git(cwd, ["config", "commit.gpgsign", "false"]);
fs.writeFileSync(path.join(cwd, "a.txt"), "a"); git(cwd, ["add", "."]); git(cwd, ["commit", "-qm", "i"]);
c.init(cwd);
const actors = ["claude", "codex", "alice", "bob"];
let t0 = Date.now(); const ids = [];
for (let i = 0; i < N; i++) {
  const t = c.addTask(cwd, `Task ${i}`, "ok", actors[i % 4], [`src/mod${i}/*`]);
  if (i % 3 === 0) c.setStatus(cwd, t.id, "in_progress", actors[i % 4]);
  if (i % 5 === 0) c.note(cwd, t.id, actors[i % 4], "branch x, PR y");
  ids.push(t.id);
}
for (let i = 0; i < WS; i++) c.createWorkspace(cwd, ids[i], actors[i % 4]);
const create = Date.now() - t0;
const run = (...a) => { const s = process.hrtime.bigint(); const r = spawnSync(process.execPath, [`${AB}/bin/agentbridge.js`, ...a], { cwd, encoding: "utf8", input: a[0] === "hook" ? JSON.stringify({ cwd, tool_name: "Edit", tool_input: { file_path: path.join(cwd, "src/mod1/x.ts") } }) : undefined }); return [Number(process.hrtime.bigint() - s) / 1e6, r.stdout.length, r.status]; };
const out = { N, workspaces: WS, createMs: create, recordsKB: Math.round(Number(spawnSync("du", ["-sk", path.join(cwd, ".agentbridge")], { encoding: "utf8" }).stdout.split("\t")[0])) };
for (const [k, a] of Object.entries({ check: ["check", "src/mod1/x.ts", "--actor", "claude"], hook: ["hook", "pre-edit", "--actor", "claude"], inbox: ["inbox", "--actor", "codex"], board: ["board", "--format", "json"], log: ["log", "--format", "json"] })) {
  const [ms, bytes, status] = run(...a); out[k] = { ms: Math.round(ms), bytes, status };
}
console.log(JSON.stringify(out));
fs.rmSync(cwd, { recursive: true, force: true });
