import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as c from "./core.js";
import * as identity from "./identity.js";
import { installGitHook } from "./agents.js";
import * as signing from "./signing.js";
import * as sync from "./sync.js";
import { gh } from "./github.js";

export const rulesetName = "AgentBridge records: append-only";
const ruleset = {
  name: rulesetName,
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: [`refs/heads/${sync.branch}`], exclude: [] } },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
};
export const installCommand = "npm install -g github:koda-ai-studio/agentbridge";
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => String(v).split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

const home = () => process.env.HOME || os.homedir();
const q = (s) => (/^[\w./@-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

function backup(file) {
  const copy = `${file}.bak-agentbridge`;
  if (!fs.existsSync(copy)) fs.copyFileSync(file, copy);
}

function topLevel(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw Error(`${cwd} is not inside a Git repository. cd into the repository first, e.g. cd ~/repos/my-project && agentbridge onboard`);
  return r.stdout.trim();
}

const gitPerson = (top) => {
  const r = spawnSync("git", ["config", "--get", "agentbridge.person"], { cwd: top, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
};
export function onboard(cwd, bin, { solo = false, dryRun = false } = {}) {
  const top = topLevel(cwd);
  const steps = [];
  const step = (name, fn) => {
    try {
      const [state, detail] = fn();
      steps.push({ step: name, state, ...(detail ? { detail } : {}) });
    } catch (e) {
      steps.push({ step: name, state: "needs-you", detail: e.message });
    }
  };
  const act = (fn) => (dryRun ? null : fn());
  const node = identity.nodeBin();
  const run = `${q(node)} ${q(bin)}`;

  step("version", () => {
    const own = JSON.parse(fs.readFileSync(path.resolve(path.dirname(bin), "..", "package.json"), "utf8")).version;
    let latest;
    try {
      latest = JSON.parse(gh(top, ["api", "repos/koda-ai-studio/agentbridge/contents/package.json", "-H", "Accept: application/vnd.github.raw"])).version;
    } catch {
      return ["info", `${own} (could not check for a newer one)`];
    }
    return newer(latest, own) ? ["info", `${own}; ${latest} is available: ${installCommand}`] : ["info", `${own}, the latest`];
  });

  step("records", () => {
    const w = c.where(top);
    if (!solo && sync.isSynced(top)) return ["already", `shared through origin/${sync.branch}`];
    const origin = spawnSync("git", ["remote", "get-url", "origin"], { cwd: top, encoding: "utf8" }).status === 0;
    if (w.initialized && !solo && w.mode === "repository" && origin) {
      if (dryRun) return ["planned", `move .agentbridge/ to the ${sync.branch} branch on origin`];
      const r = sync.setupSync(top);
      return ["done", `moved to origin/${sync.branch}${r.joined ? " (joined existing records)" : ""}; syncs on its own. Commit the removal: git commit -m "Move AgentBridge records to their own branch"`];
    }
    if (w.initialized) return ["already", `${w.mode}: ${w.recordsDir}`];
    if (solo) {
      const dir = path.join(home(), ".agentbridge", "records", `${path.basename(top)}-${c.repoKey(top)}`);
      act(() => c.init(top, { recordsDir: dir }));
      return [dryRun ? "planned" : "done", `shared by this machine's worktrees: ${dir}`];
    }
    if (!origin) {
      act(() => c.init(top));
      return [dryRun ? "planned" : "done", "committed in .agentbridge/ (no origin remote to sync through; commit it)"];
    }
    if (dryRun) return ["planned", `shared through the ${sync.branch} branch on origin`];
    const r = sync.setupSync(top);
    return ["done", `shared through origin/${sync.branch}${r.joined ? " (joined existing records)" : " (new, pushed)"}; syncs on its own`];
  });

  if (!solo)
    step("records branch protection", () => {
      if (!sync.isSynced(top)) return ["skipped", "records are not on a sync branch"];
      const url = spawnSync("git", ["remote", "get-url", "origin"], { cwd: top, encoding: "utf8" }).stdout.trim();
      if (!/github\.com[:/]/.test(url)) return ["skipped", "origin is not on GitHub; protect the branch on your host"];
      let names;
      try {
        names = gh(top, ["api", "repos/{owner}/{repo}/rulesets", "--jq", ".[].name"]).split("\n").map((x) => x.trim());
      } catch (e) {
        return ["skipped", `could not read rulesets (${e.message.split("\n")[0]})`];
      }
      if (names.includes(rulesetName)) return ["already", `GitHub ruleset "${rulesetName}"`];
      let admin = false;
      try {
        admin = gh(top, ["api", "repos/{owner}/{repo}", "--jq", ".permissions.admin"]).trim() === "true";
      } catch {}
      if (!admin) return ["skipped", `ask a repository admin to run agentbridge onboard once, so ${sync.branch} cannot be force-pushed or deleted`];
      if (dryRun) return ["planned", `GitHub ruleset blocking force-push and deletion of ${sync.branch}`];
      gh(top, ["api", "-X", "POST", "repos/{owner}/{repo}/rulesets", "--input", "-"], JSON.stringify(ruleset));
      return ["done", `GitHub ruleset "${rulesetName}": ${sync.branch} cannot be force-pushed or deleted, by anyone`];
    });

  step("identity and record merging", () => {
    if (solo) {
      const saved = gitPerson(top);
      const known = identity.githubId(top) && saved;
      if (known) return ["already", `you are ${saved} (GitHub id ${identity.githubId(top)}); agents are claude, codex`];
      if (dryRun) return ["planned", "your GitHub login via gh; agents are claude, codex"];
      try {
        const r = identity.recordPerson(top);
        return ["done", `you are ${r.person} (GitHub id ${r.githubId}); agents are claude, codex`];
      } catch {
        return ["skipped", `gh not logged in; you are ${saved || os.userInfo().username} (no GitHub id). Your name is saved once gh is logged in (gh auth login)`];
      }
    }
    const me = identity.login(top);
    if (me && identity.githubId(top)) return ["already", `${me} (GitHub id ${identity.githubId(top)})`];
    if (me) {
      if (dryRun) return ["planned", `add GitHub id for ${me}`];
      return ["done", `${me} (added GitHub id ${identity.recordGithubId(top)})`];
    }
    if (dryRun) return ["planned", "GitHub login via gh"];
    return ["done", identity.setup(top, bin).login];
  });

  step("approval signing", () => {
    const key = signing.signingKey(top);
    if (!key) return ["skipped", "no SSH signing key; approvals are recorded unsigned (set gpg.format ssh and user.signingkey)"];
    const mine = signing.fingerprint(key);
    const touch = mine.presence ? "touch required" : "no touch required: an agent with access to this key could sign";
    const gid = identity.githubId(top);
    if (!gid) return ["already", `${mine.key} (${mine.type}, ${touch}); GitHub id unknown, so others cannot check it`];
    let registered;
    try {
      registered = signing.githubSigners(top, gid).keys.some((k) => signing.fingerprint(k).key === mine.key);
    } catch {
      return ["already", `${mine.key} (${mine.type}, ${touch}); GitHub not reachable to confirm registration`];
    }
    if (!registered) throw Error(`${mine.key} is not one of your GitHub SSH signing keys, so others cannot verify your approvals. Add it at github.com/settings/keys as a Signing Key.`);
    return ["already", `${mine.key} (${mine.type}), registered on GitHub; ${touch}`];
  });

  step("commit ownership check", () => {
    if (dryRun) return ["planned", "Git pre-commit hook, chained before existing hooks"];
    const r = installGitHook(top, bin);
    return [r.installed ? "done" : "already", r.repaired ? `${r.hook} (now runs this install)` : r.hook];
  });

  for (const [tool, dir] of [["Claude Code", ".claude"], ["Codex", ".codex"]]) {
    step(`${tool} skill`, () => {
      if (!fs.existsSync(path.join(home(), dir))) return ["skipped", `${tool} not found`];
      const link = path.join(home(), dir, "skills", "agentbridge");
      const target = path.resolve(path.dirname(bin), "..", "skills", "agentbridge");
      const current = fs.lstatSync(link, { throwIfNoEntry: false });
      if (current && !current.isSymbolicLink()) return ["already", `${link} (your own copy; not replaced)`];
      if (current && path.resolve(path.dirname(link), fs.readlinkSync(link)) === target) return ["already", link];
      act(() => {
        fs.mkdirSync(path.dirname(link), { recursive: true });
        if (current) fs.unlinkSync(link);
        fs.symlinkSync(target, link);
      });
      return [dryRun ? "planned" : "done", current ? `${link} (now points at this install)` : link];
    });
  }

  const hookStep = (tool, dir, file, actor, matcher, after = "") =>
    step(`${tool} hooks`, () => {
      if (!fs.existsSync(path.join(home(), dir))) return ["skipped", `${tool} not found`];
      const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      const hooks = (settings.hooks ??= {});
      const want = { PreToolUse: "pre-edit", UserPromptSubmit: "prompt" };
      const changed = [];
      for (const [event, sub] of Object.entries(want)) {
        const ours = (hooks[event] || []).flatMap((m) => (m.hooks || []).filter((h) => /agentbridge/.test(h.command || "") && h.command.includes(`hook ${sub}`)));
        if (!ours.length) {
          (hooks[event] ??= []).push({ ...(event === "PreToolUse" ? { matcher } : {}), hooks: [{ type: "command", command: `${run} hook ${sub} --actor ${actor}` }] });
          changed.push(event);
        }
        for (const h of ours) {
          const fixed = `${run} ${h.command.slice(h.command.indexOf(`hook ${sub}`))}`;
          if (h.command !== fixed) {
            h.command = fixed;
            changed.push(`${event} (repaired command)`);
          }
        }
      }
      if (!changed.length) return ["already", file];
      act(() => {
        if (fs.existsSync(file)) backup(file);
        fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
      });
      return [dryRun ? "planned" : "done", `${changed.join(", ")} in ${file}${after}`];
    });

  hookStep("Claude Code", ".claude", path.join(home(), ".claude", "settings.json"), "claude", "Edit|MultiEdit|Write|NotebookEdit");
  hookStep("Codex", ".codex", path.join(home(), ".codex", "hooks.json"), "codex", "apply_patch|Edit|Write", " (approve once in Codex: /hooks, or Settings > Hooks in the app)");

  step("Codex MCP tools", () => {
    const file = path.join(home(), ".codex", "config.toml");
    if (!fs.existsSync(path.dirname(file))) return ["skipped", "Codex not found"];
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const want = `command = ${JSON.stringify(node)}\nargs = [${JSON.stringify(bin)}, "mcp", "--actor", "codex"]`;
    const section = /^\[mcp_servers\.agentbridge\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text);
    if (section) {
      const body = section[1];
      const fixed = body.replace(/^command = .*\n?/m, "").replace(/^args = \[.*\]\n?/m, "");
      if (body.startsWith(`${want}\n`) || body === want) return ["already", file];
      if (!/^command = /m.test(body) || /^args = \[[^\]]*$/m.test(body)) return ["already", `${file} (agentbridge entry left as you wrote it)`];
      act(() => {
        backup(file);
        fs.writeFileSync(file, text.slice(0, section.index) + `[mcp_servers.agentbridge]\n${want}\n${fixed}` + text.slice(section.index + section[0].length));
      });
      return [dryRun ? "planned" : "done", `${file} (now runs this install; restart Codex)`];
    }
    act(() => {
      if (fs.existsSync(file)) backup(file);
      fs.appendFileSync(file, (text && !text.endsWith("\n") ? "\n" : "") + `\n[mcp_servers.agentbridge]\n${want}\n`);
    });
    return [dryRun ? "planned" : "done", `${file} (restart Codex)`];
  });

  return { repository: top, mode: solo ? "solo" : "team", dryRun, steps };
}

export function onboardText(r) {
  const mark = { done: "✓", already: "✓", info: "·", planned: "→", skipped: "–", "needs-you": "!" };
  const lines = [`AgentBridge ${r.dryRun ? "plan" : "setup"} for ${r.repository} (${r.mode})`];
  for (const s of r.steps) lines.push(`  ${mark[s.state]} ${s.step}${s.state === "already" ? " (already set)" : ""}${s.detail ? ` — ${s.detail}` : ""}`);
  const todo = r.steps.filter((s) => s.state === "needs-you");
  if (todo.length) lines.push("", "Needs you:", ...todo.map((s) => `  ${s.step}: ${s.detail}`));
  else if (!r.dryRun) lines.push("", r.mode === "team" ? "Done. From now on just run `agentbridge`: it asks about anything that needs you. Teammates run `agentbridge onboard` in their clone." : "Done. Agents pick it up in their next session. From now on just run `agentbridge`: it asks about anything that needs you.");
  return lines.join("\n");
}
