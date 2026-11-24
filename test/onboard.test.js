import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { git } from "../lib/git.js";

const bin = path.resolve("bin/agentbridge.js");
function world(t, { claude = true, codex = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-onboard-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), repo = path.join(root, "repo");
  fs.mkdirSync(home);
  if (claude) fs.mkdirSync(path.join(home, ".claude"));
  if (codex) fs.mkdirSync(path.join(home, ".codex"));
  fs.mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
  const gh = path.join(root, "gh");
  fs.writeFileSync(gh, `#!${process.execPath}\nif (process.env.FAKE_LOGIN) process.stdout.write((process.argv.includes(".id") ? "1001" : process.env.FAKE_LOGIN + " 1001") + "\\n"); else { process.stderr.write("not logged in"); process.exit(1); }\n`, { mode: 0o755 });
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [bin, "onboard", "--json", ...args], {
      cwd: repo, encoding: "utf8", timeout: 20000,
      env: { ...process.env, HOME: home, AGENTBRIDGE_GH_BIN: gh, FAKE_LOGIN: "alice-gh", ...env },
    });
  return { home, repo, run };
}
const states = (r) => Object.fromEntries(JSON.parse(r.stdout).steps.filter((s) => !["approval signing", "version", "records branch protection"].includes(s.step)).map((s) => [s.step, s.state]));

test("one command sets up a team clone end to end, and running it again changes nothing", (t) => {
  const { home, repo, run } = world(t);
  const claudeSettings = path.join(home, ".claude/settings.json"), codexConfig = path.join(home, ".codex/config.toml");
  fs.writeFileSync(claudeSettings, JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "say hi" }] }] } }));
  fs.writeFileSync(codexConfig, 'model = "y"');
  const first = run([]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(new Set(Object.values(states(first))), new Set(["done"]));
  assert.ok(fs.existsSync(path.join(repo, ".agentbridge/project.json")));
  assert.equal(git(repo, ["config", "--get", "agentbridge.login"]), "alice-gh");
  assert.match(fs.readFileSync(path.join(repo, ".git/hooks/pre-commit"), "utf8"), /agentbridge pre-commit/);
  for (const d of [".claude", ".codex"]) assert.ok(fs.lstatSync(path.join(home, d, "skills/agentbridge")).isSymbolicLink());
  const s = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
  assert.equal(s.model, "x");
  assert.equal(s.hooks.Stop[0].hooks[0].command, "say hi", "existing hooks kept");
  assert.match(s.hooks.PreToolUse[0].hooks[0].command, /hook pre-edit --actor claude$/);
  assert.match(s.hooks.UserPromptSubmit[0].hooks[0].command, /hook prompt --actor claude$/);
  const toml = fs.readFileSync(codexConfig, "utf8");
  assert.ok(toml.startsWith('model = "y"\n'), "existing Codex config kept");
  assert.match(toml, /\[mcp_servers\.agentbridge\][\s\S]*"mcp", "--actor", "codex"\]/);
  const codexHooks = JSON.parse(fs.readFileSync(path.join(home, ".codex/hooks.json"), "utf8")).hooks;
  assert.equal(codexHooks.PreToolUse[0].matcher, "apply_patch|Edit|Write");
  assert.match(codexHooks.PreToolUse[0].hooks[0].command, /hook pre-edit --actor codex$/);
  assert.match(codexHooks.UserPromptSubmit[0].hooks[0].command, /hook prompt --actor codex$/);
  assert.match(JSON.parse(first.stdout).steps.find((x) => x.step === "Codex hooks").detail, /approve once in Codex/);
  assert.ok(fs.existsSync(`${claudeSettings}.bak-agentbridge`) && fs.existsSync(`${codexConfig}.bak-agentbridge`));
  const again = run([]);
  assert.deepEqual(new Set(Object.values(states(again))), new Set(["already"]));
  assert.equal(fs.readFileSync(codexConfig, "utf8"), toml, "no duplicate blocks");
  assert.equal(JSON.parse(fs.readFileSync(claudeSettings, "utf8")).hooks.PreToolUse.length, 1);
});

test("hooks installed with a bare node command are repaired to an absolute path, keeping their actor", (t) => {
  const { home, run } = world(t, { codex: false });
  const file = path.join(home, ".claude/settings.json");
  const stale = { type: "command", command: "node /old/agentbridge.js hook pre-edit --actor claude/review" };
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit", hooks: [stale] }] } }));
  const r = run(["--solo"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).steps.find((x) => x.step === "Claude Code hooks").detail, /PreToolUse \(repaired command\), UserPromptSubmit/);
  const hooks = JSON.parse(fs.readFileSync(file, "utf8")).hooks;
  assert.equal(hooks.PreToolUse.length, 1, "repaired in place, not duplicated");
  assert.match(hooks.PreToolUse[0].hooks[0].command, /^\/\S*node\S* \S*bin\/agentbridge\.js hook pre-edit --actor claude\/review$/);
  assert.equal(states(run(["--solo"]))["Claude Code hooks"], "already");
});

test("clones set up before GitHub ids existed get the id added on the next onboard", (t) => {
  const { repo, run } = world(t);
  assert.equal(run([]).status, 0);
  git(repo, ["config", "--unset", "agentbridge.githubId"]);
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  const step = JSON.parse(r.stdout).steps.find((x) => x.step === "identity and record merging");
  assert.deepEqual([step.state, step.detail], ["done", "alice-gh (added GitHub id 1001)"]);
  assert.equal(git(repo, ["config", "--get", "agentbridge.githubId"]), "1001");
  assert.equal(states(run([]))["identity and record merging"], "already");
});

test("dry run plans without touching anything; solo mode keeps records out of Git", (t) => {
  const { home, repo, run } = world(t);
  const plan = run(["--dry-run"]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.ok(Object.values(states(plan)).every((s) => s === "planned"));
  assert.ok(!fs.existsSync(path.join(repo, ".agentbridge")) && !fs.existsSync(path.join(home, ".claude/settings.json")));
  assert.equal(spawnSync("git", ["config", "--get-regexp", "agentbridge"], { cwd: repo, encoding: "utf8" }).stdout, "");
  const solo = run(["--solo"]);
  assert.equal(solo.status, 0, solo.stderr);
  assert.equal(states(solo)["identity and record merging"], "done");
  assert.equal(git(repo, ["config", "--get", "agentbridge.githubId"]), "1001", "solo records the GitHub id");
  assert.equal(git(repo, ["config", "--get", "agentbridge.person"]), "alice-gh", "solo saves the GitHub login as the person, so people need no --actor");
  assert.match(solo.stdout, /you are alice-gh/);
  assert.equal(spawnSync("git", ["config", "--get", "agentbridge.login"], { cwd: repo }).status, 1, "but keeps plain agent names");
  assert.equal(git(repo, ["status", "--porcelain", "--untracked-files=all"]), "", "nothing to commit in solo mode");
  assert.match(JSON.parse(solo.stdout).steps.find((x) => x.step === "records").detail, /\.agentbridge\/records\/repo-[0-9a-f]{8}$/);
});

test("missing tools are skipped and missing GitHub login is reported, not guessed", (t) => {
  const { run } = world(t, { claude: false, codex: false });
  const r = run([], { FAKE_LOGIN: "" });
  assert.equal(r.status, 1);
  const s = states(r);
  assert.equal(s["identity and record merging"], "needs-you");
  assert.equal(s["Claude Code hooks"], "skipped");
  assert.equal(s["Codex MCP tools"], "skipped");
  assert.equal(s["records"], "done");
});

test("after switching installs, onboard repoints the Codex MCP entry, the skill link and the commit hook", (t) => {
  const { home, repo, run } = world(t);
  const config = path.join(home, ".codex/config.toml");
  fs.writeFileSync(config, 'model = "y"\n\n[mcp_servers.agentbridge]\ncommand = "/usr/bin/node"\nargs = ["/old/install/bin/agentbridge.js", "mcp", "--actor", "codex"]\nenv = { A = "1" }\n\n[other]\nx = 1\n');
  const skill = path.join(home, ".claude/skills/agentbridge");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.symlinkSync("/old/install/skills/agentbridge", skill);
  const first = run([]);
  assert.equal(first.status, 0, first.stderr);
  const firstSteps = Object.fromEntries(JSON.parse(first.stdout).steps.map((x) => [x.step, x]));
  assert.match(firstSteps["Codex MCP tools"].detail, /now runs this install/);
  assert.match(firstSteps["Claude Code skill"].detail, /now points at this install/);
  const hook = path.join(repo, ".git/hooks/pre-commit");
  fs.writeFileSync(hook, fs.readFileSync(hook, "utf8").replace(/'[^']*agentbridge\.js'/, "'/old/install/bin/agentbridge.js'"));
  const r = run([]);
  const steps = Object.fromEntries(JSON.parse(r.stdout).steps.map((x) => [x.step, x]));
  assert.match(steps["commit ownership check"].detail, /now runs this install/);
  const toml = fs.readFileSync(config, "utf8");
  assert.doesNotMatch(toml, /\/old\/install/);
  assert.match(toml, /\[mcp_servers\.agentbridge\]\ncommand = "[^"]+"\nargs = \["[^"]*bin\/agentbridge\.js", "mcp", "--actor", "codex"\]\nenv = \{ A = "1" \}\n\n\[other\]\nx = 1\n$/, "other settings and sections kept");
  assert.equal(fs.readlinkSync(skill), path.resolve("skills/agentbridge"));
  assert.doesNotMatch(fs.readFileSync(hook, "utf8"), /\/old\/install/);
  assert.deepEqual(new Set(Object.values(states(run([])))), new Set(["already"]));
});
