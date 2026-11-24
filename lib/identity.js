import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gh } from "./github.js";
import * as c from "./core.js";

export const agentNames = ["claude", "codex", "cursor", "copilot", "gemini", "aider", "devin", "windsurf", "amp", "goose", "jules", "opencode"];
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" });

export function agentSession(env = process.env) {
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_SESSION_ID) return { agent: "claude", session: env.CLAUDE_CODE_SESSION_ID || null };
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX) return { agent: "codex", session: env.CODEX_THREAD_ID || null };
  if (env.AI_AGENT?.trim()) return { agent: env.AI_AGENT.trim().split(/[_-]/)[0].toLowerCase(), session: null };
  return null;
}
const agentOf = (actor) => actor.split("/").pop().toLowerCase();

export function guardSession(actor, env = process.env) {
  const s = agentSession(env);
  if (!s || !actor) return actor;
  const a = agentOf(actor);
  if (a === s.agent || a.startsWith(`${s.agent}-`)) return actor;
  throw Error(`This runs inside a ${s.agent} session, so it acts as ${s.agent}, not ${actor}. People act from their own terminal under their own name; Claude Code's ! prefix runs inside this session too. Never suggest acting as another agent. If another agent holds work you need, ask the user to run in their own terminal: agentbridge assign TASK --to ${s.agent}`);
}

export function githubId(cwd) {
  const r = git(cwd, ["config", "--get", "agentbridge.githubId"]);
  return r.status === 0 && /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) : null;
}

export function provenance(cwd, env = process.env, via = null) {
  const s = agentSession(env);
  const gid = githubId(cwd);
  const head = git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const branch = head.status === 0 ? head.stdout.trim() : "";
  return {
    via: via || (s ? "agent" : "terminal"),
    ...(s ? { agent: s.agent, ...(s.session ? { session: s.session } : {}) } : {}),
    ...(gid ? { github: gid } : {}),
    ...(branch ? { branch } : {}),
  };
}

export function login(cwd) {
  const r = git(cwd, ["config", "--get", "agentbridge.login"]);
  return r.status === 0 ? r.stdout.trim() || null : null;
}
export const isAgent = (actor) => actor.includes("/");

export function personName(cwd) {
  const r = git(cwd, ["config", "--get", "agentbridge.person"]);
  let name = r.status === 0 ? r.stdout.trim() : "";
  if (!name && !agentSession()) {
    try {
      name = recordPerson(cwd).person;
    } catch {}
  }
  if (!name) {
    try {
      name = os.userInfo().username;
    } catch {}
  }
  name = (name || "").replace(/\s+/g, "");
  return name && !agentNames.includes(agentOf(name)) ? name : "";
}

export function resolveActor(cwd, name, { self = true } = {}) {
  const me = login(cwd);
  const raw = (name || "").trim();
  if (!me) return raw || (self ? personName(cwd) : "");
  if (!raw || raw === "me") return self ? me : raw;
  if (agentNames.includes(raw.toLowerCase())) return `${me}/${raw.toLowerCase()}`;
  if (!self) return raw;
  if (raw === me || raw.startsWith(`${me}/`)) return raw;
  throw Error(`This clone acts as ${me} (GitHub login). Use --actor ${me} or ${me}/<agent>, not ${raw}`);
}

export function principalOf(cwd, actor, owner, env = process.env) {
  if (agentSession(env) || !actor || !owner) return null;
  const me = login(cwd);
  if (me) return actor === me && owner.startsWith(`${me}/`) ? actor : null;
  return !agentNames.includes(agentOf(actor)) && agentNames.includes(agentOf(owner)) ? actor : null;
}

export function ownedBy(cwd, person, x) {
  if (!person || !x) return false;
  return x === person || (login(cwd) ? x.startsWith(`${person}/`) : agentNames.includes(agentOf(x)) && !x.includes("/"));
}

export function requirePersonHere(cwd, actor, what, env = process.env) {
  const s = agentSession(env);
  if (s) throw Error(`Only a person ${what}, and this runs inside a ${s.agent} session. Ask the user to run it in their own terminal (Claude Code's ! prefix runs inside this session too).`);
  if (!actor) throw Error("Actor required: --actor YOUR-NAME");
  if (login(cwd) ? isAgent(actor) : agentNames.includes(agentOf(actor))) throw Error(`${actor} is an agent; only a person ${what}`);
}

export function requireReassign(cwd, actor, owner, to, env = process.env) {
  requirePersonHere(cwd, actor, "reassigns work", env);
  const ours = (x) => ownedBy(cwd, actor, x);
  if (!owner || !ours(owner)) throw Error(`This task belongs to ${owner || "nobody"}; you can reassign only your own or your agents' tasks. Use handoff offer to pass work to another person.`);
  if (!ours(to)) throw Error(`${to} is not you or one of your agents; use handoff offer to pass work to another person`);
}

export function requirePerson(cwd, actor, env = process.env) {
  const s = agentSession(env);
  if (s) throw Error(`Only people accept, and this runs inside a ${s.agent} session. Run it yourself in a terminal outside the agent.`);
  if (login(cwd) ? isAgent(actor) : agentNames.includes(agentOf(actor || "")))
    throw Error(`${actor} is an agent; only people accept. Agents propose.`);
}

export function nodeBin() {
  const r = spawnSync("sh", ["-c", "command -v node"], { encoding: "utf8" });
  const found = r.status === 0 ? r.stdout.trim() : "";
  return found && path.isAbsolute(found) ? found : process.execPath;
}
export function mergeDriverCommand(bin) {
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  return `${q(nodeBin())} ${q(bin)} merge-driver %O %A %B %P`;
}

export function recordPerson(cwd) {
  const [found, gid] = gh(cwd, ["api", "user", "--jq", '.login + " " + (.id|tostring)']).trim().split(" ");
  if (!found || !/^\d+$/.test(gid || "")) throw Error("GitHub did not return a login and numeric id");
  for (const [k, v] of [["agentbridge.person", found], ["agentbridge.githubId", gid]]) {
    const r = git(cwd, ["config", "--local", k, v]);
    if (r.status !== 0) throw Error(`git config failed: ${r.stderr.trim()}`);
  }
  return { person: found, githubId: Number(gid) };
}

export function recordGithubId(cwd) {
  const gid = gh(cwd, ["api", "user", "--jq", ".id"]).trim();
  if (!/^\d+$/.test(gid)) throw Error("GitHub did not return a numeric user id");
  const r = git(cwd, ["config", "--local", "agentbridge.githubId", gid]);
  if (r.status !== 0) throw Error(`git config failed: ${r.stderr.trim()}`);
  return Number(gid);
}

export function setup(cwd, bin) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) throw Error("Not inside a Git repository");
  const dir = top.stdout.trim();
  const [found, gid] = gh(dir, ["api", "user", "--jq", '.login + " " + (.id|tostring)']).trim().split(" ");
  if (!loginPattern.test(found)) throw Error(`Unexpected GitHub login ${JSON.stringify(found)}`);
  if (!/^\d+$/.test(gid || "")) throw Error("GitHub did not return a numeric user id");
  const set = (k, v) => {
    const r = git(dir, ["config", "--local", k, v]);
    if (r.status !== 0) throw Error(`git config ${k} failed: ${r.stderr.trim()}`);
  };
  set("agentbridge.login", found);
  set("agentbridge.githubId", gid);
  set("merge.agentbridge.name", "AgentBridge record merge");
  set("merge.agentbridge.driver", mergeDriverCommand(bin));
  const w = c.where(dir);
  let attributes = null;
  if (w.initialized) {
    attributes = path.join(w.recordsDir, ".gitattributes");
    if (!fs.existsSync(attributes) || !fs.readFileSync(attributes, "utf8").includes("merge=agentbridge"))
      fs.appendFileSync(attributes, "*.json merge=agentbridge\n");
  }
  return { login: found, githubId: Number(gid), mergeDriver: true, attributes, records: w.recordsDir, mode: w.mode };
}
