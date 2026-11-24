import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import * as c from "./core.js";
import * as co from "./coordination.js";
import * as team from "./team.js";
import * as id from "./identity.js";
import { setProvenance, resolveTaskId } from "./store.js";
import { autoSync, freshen } from "./sync.js";
import { spawnSync } from "node:child_process";
import { logBlocked } from "./stats.js";

const editTools = { Edit: "file_path", MultiEdit: "file_path", Write: "file_path", NotebookEdit: "notebook_path" };

function conflictText(r) {
  const groups = new Map();
  for (const x of r.conflicts) {
    const k = `${x.path}\0${x.owner || ""}`;
    groups.set(k, [...(groups.get(k) || []), x]);
  }
  return [...groups.values()]
    .map((xs) => {
      const [x] = xs, hint = xs.find((y) => y.hint)?.hint;
      const tasks = xs.length === 1
        ? `task "${x.title}", ${x.task.slice(5, 13)}, ${team.statusWords[x.status] || x.status}`
        : `${xs.length} open tasks: ${xs.slice(0, 3).map((y) => `"${clip(y.title, 50)}" (${y.task.slice(5, 13)})`).join(", ")}${xs.length > 3 ? `, +${xs.length - 3} more` : ""}`;
      return `AgentBridge: ${x.owner || "nobody"} is working on ${x.path} (${tasks}). ${hint || "Do not edit it; ask the owner to hand it off, or ask the user."}`;
    })
    .join("\n");
}

function topLevel(dir) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

const patchFile = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;

export function editedPaths(input) {
  const ti = input?.tool_input || {};
  const key = editTools[input?.tool_name];
  if (key && typeof ti[key] === "string") return [ti[key]];
  const patch = Array.isArray(ti.command) ? ti.command.join("\n") : ti.command ?? ti.input ?? ti.patch;
  if (typeof patch !== "string" || !patch.includes("*** Begin Patch")) return [];
  return [...new Set([...patch.matchAll(patchFile)].map((m) => m[1].trim()))];
}

export function preEdit(input, actor) {
  if (!actor?.trim()) return { exit: 2, message: "AgentBridge hook: --actor required" };
  const raw = editedPaths(input);
  if (!raw.length) return { exit: 0 };
  const files = raw.map((p) => path.resolve(input.cwd || process.cwd(), p));
  const existing = co.nearestExisting(files[0]);
  const dir = fs.existsSync(existing) && fs.statSync(existing).isDirectory() ? existing : path.dirname(existing);
  const top = topLevel(dir);
  if (!top || !c.where(top).initialized) return { exit: 0 };
  try {
    const who = id.resolveActor(top, actor);
    const r = co.checkPaths(top, who, files);
    if (r.allowed) return { exit: 0 };
    logBlocked(top, "edit", who, r);
    return { exit: 2, message: conflictText(r) };
  } catch (e) {
    if (/not inside a Git repository/.test(e.message)) return { exit: 0 };
    return { exit: 2, message: `AgentBridge could not check ${raw.join(", ")}: ${e.message}` };
  }
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const runGit = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" });

export function knownActors(cwd) {
  const names = new Set();
  for (const t of c.tasks(cwd)) {
    if (t.owner) names.add(t.owner);
    for (const e of t.history) if (e.actor) names.add(e.actor);
  }
  return names;
}

export function commitActor(top, env = process.env) {
  if (env.AGENTBRIDGE_ACTOR?.trim()) return { actor: id.resolveActor(top, env.AGENTBRIDGE_ACTOR), source: "AGENTBRIDGE_ACTOR" };
  const session = id.agentSession(env);
  if (session) return { actor: id.resolveActor(top, session.agent), source: `${session.agent} session` };
  const branch = runGit(top, ["symbolic-ref", "--short", "-q", "HEAD"]).stdout.trim();
  const prefix = branch.includes("/") ? branch.split("/")[0] : "";
  let candidate = null;
  try {
    candidate = prefix ? id.resolveActor(top, prefix) : null;
  } catch {}
  if (candidate && knownActors(top).has(candidate)) return { actor: candidate, source: `branch ${branch}` };
  return { actor: null, source: branch ? `branch ${branch}` : "detached HEAD" };
}

export function preCommit(cwd, env = process.env) {
  const top = topLevel(cwd);
  if (!top || !c.where(top).initialized) return { exit: 0 };
  const staged = runGit(top, ["diff", "--cached", "--name-only", "-z", "--no-renames"]).stdout.split("\0").filter(Boolean);
  if (!staged.length) return { exit: 0 };
  const { actor, source } = commitActor(top, env);
  if (!actor) {
    const owned = co.checkPaths(top, "\u0000nobody", staged).conflicts;
    if (!owned.length) return { exit: 0 };
    return {
      exit: 0,
      message: `AgentBridge: could not tell who is committing (${source}); not blocking. Staged files owned by active tasks:\n${owned.map((x) => `  ${x.path} — ${x.owner} (${x.title})`).join("\n")}\nSet AGENTBRIDGE_ACTOR or use an <actor>/ branch prefix to enforce ownership.`,
    };
  }
  const r = co.checkPaths(top, actor, staged);
  if (r.allowed) return { exit: 0 };
  logBlocked(top, "commit", actor, r);
  return {
    exit: 1,
    message: `AgentBridge: commit blocked for ${actor} (from ${source}).\n${conflictText(r)}\nUnstage those files, or get the task handed to you first.`,
  };
}

export function promptUpdate(input, actor) {
  if (!actor?.trim()) return "";
  const top = topLevel(input?.cwd || process.cwd());
  if (!top || !c.where(top).initialized) return "";
  actor = id.resolveActor(top, actor);
  const r = co.inbox(top, actor, { since: "last" });
  const lines = [];
  if (r.incoming.length)
    lines.push("Handoffs waiting for you (receive before working on them):", ...r.incoming.map((x) => `- ${x.title} from ${x.from}: ${x.next} (${x.id})`));
  const prs = team.mergedPullRequests(top);
  const merged = prs?.length
    ? c.tasks(top).filter((t) => t.owner === actor && ["planned", "in_progress", "needs_work", "implemented", "ready_for_review"].includes(t.status)).map((t) => [t, team.mergedWork(t, prs)]).filter(([, m]) => m)
    : [];
  if (merged.length)
    lines.push(
      "Your tasks whose pull request is merged; unless work remains, close them so their files are released (task close TASK --pr N):",
      ...merged.slice(0, 10).map(([t, m]) => `- ${clip(t.title, 60)} (${t.id}): PR #${m.pr}`),
    );
  if (r.decisions.accepted.length)
    lines.push("Newly accepted project decisions:", ...r.decisions.accepted.map((d) => `- ${d.summary} (${d.by})`));
  if (r.changes.length) {
    const byTask = new Map();
    for (const x of r.changes) {
      const g = byTask.get(x.task) || { at: "", events: new Map() };
      const who = `${x.actor || "provider"} ${x.event}`;
      g.events.set(who, (g.events.get(who) || 0) + 1);
      g.at = x.at > g.at ? x.at : g.at;
      byTask.set(x.task, g);
    }
    const recent = [...byTask].sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, 10);
    lines.push(`Changes by others since your last check${byTask.size > recent.length ? ` (latest ${recent.length} of ${byTask.size} tasks)` : ""}:`);
    for (const [task, g] of recent) {
      const t = c.task(top, task);
      const what = [...g.events].map(([e, n]) => (n > 1 ? `${e} x${n}` : e)).join(", ");
      lines.push(`- "${clip(t.title, 60)}" (${task}): ${what}${t.note ? ` — note: ${clip(t.note.text, 120)}` : ""}`);
    }
  }
  return lines.length ? `AgentBridge updates for ${actor}:\n${lines.join("\n")}` : "";
}

const hookMarker = "# agentbridge pre-commit";
export function installGitHook(cwd, bin) {
  const top = topLevel(cwd);
  if (!top) throw Error("Not inside a Git repository");
  const hooks = path.resolve(top, runGit(top, ["rev-parse", "--git-path", "hooks"]).stdout.trim());
  fs.mkdirSync(hooks, { recursive: true });
  const hook = path.join(hooks, "pre-commit"), next = path.join(hooks, "pre-commit.agentbridge-next");
  const current = fs.existsSync(hook) ? fs.readFileSync(hook, "utf8") : null;
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const body = `#!/bin/sh\n${hookMarker}\n${q(id.nodeBin())} ${q(bin)} hook pre-commit || exit 1\nnext="$(dirname "$0")/pre-commit.agentbridge-next"\nif [ -x "$next" ]; then exec "$next" "$@"; fi\nexit 0\n`;
  if (current?.includes(hookMarker)) {
    if (current === body) return { hook, installed: false, chained: fs.existsSync(next) };
    fs.writeFileSync(hook, body, { mode: 0o755 });
    return { hook, installed: true, repaired: true, chained: fs.existsSync(next) };
  }
  if (current !== null) {
    if (fs.existsSync(next)) throw Error(`${next} already exists; resolve it before installing`);
    fs.renameSync(hook, next);
  }
  fs.writeFileSync(hook, body, { mode: 0o755 });
  return { hook, installed: true, chained: current !== null };
}

const cwdProp = {
  cwd: { type: "string", description: "Absolute path of your checkout or worktree. Defaults to the server's working directory." },
};
const tool = (name, description, properties = {}, required = []) => ({
  name,
  description,
  inputSchema: { type: "object", properties: { ...cwdProp, ...properties }, required, additionalProperties: false },
});
export const tools = [
  tool("inbox", "Your coordination inbox: tasks you own, handoffs waiting for you, paths owned by others (do not edit), project decisions and recent changes by others. Call at the start of work.", {
    since: { type: "string", description: "'last' for changes since your previous inbox call, or an ISO timestamp" },
  }),
  tool("board", "Team view: every owner's open tasks and notes, offers not yet accepted, decisions and work waiting for a person, and work needing attention."),
  tool("check", "Check paths before editing. allowed=false means another owner's active task covers a path: do not edit it.", {
    paths: { type: "array", items: { type: "string" }, minItems: 1 },
  }, ["paths"]),
  tool("start_task", "Create a task you own, claim its paths and mark it in progress. Do this before editing files nobody owns yet.", {
    title: { type: "string" },
    criteria: { type: "string", description: "Acceptance checks separated by semicolons" },
    scope: { type: "array", items: { type: "string" }, description: "Repository paths; a trailing * matches by prefix" },
    ref: { type: "string", description: "Issue key or URL in the team's tracker (Jira, Linear, GitHub); the description lives there, not here" },
  }, ["title", "criteria", "scope"]),
  tool("set_scope", "Claim the paths of a task you own, for example one you received without a scope. Refused if another owner's active task covers them.", {
    task: { type: "string" },
    scope: { type: "array", items: { type: "string" }, minItems: 1 },
  }, ["task", "scope"]),
  tool("note", "Set the one-line status note on a task you own (at most 200 characters): branch, PR, what is left. Details belong in the PR or tracker.", {
    task: { type: "string" },
    text: { type: "string", maxLength: c.noteLimit },
  }, ["task", "text"]),
  tool("handoff_offer", "Offer a task you own to someone else with the next step.", {
    task: { type: "string" },
    to: { type: "string" },
    next: { type: "string" },
  }, ["task", "to", "next"]),
  tool("handoff_receive", "Accept a handoff addressed to you; you become the owner.", { task: { type: "string" } }, ["task"]),
  tool("handoff_decline", "Turn down a handoff addressed to you, only when the user says so; the offerer keeps the task.", { task: { type: "string" }, reason: { type: "string", maxLength: 200 } }, ["task"]),
  tool("handoff_withdraw", "Take back an offer you made, only when the user says so.", { task: { type: "string" } }, ["task"]),
  tool("resume_task", "Everything needed to continue a task: goal, done bar, next step, branch, head, changed files, PR, accepted decisions, open findings, latest checks, related work and how fresh the records are. Without task, your most recently updated open task.", { task: { type: "string" } }),
  tool("report_finding", "Record a problem found in a task (review, failing check, bug). It goes back to needs work for its owner.", { task: { type: "string" }, description: { type: "string", maxLength: 2000 } }, ["task", "description"]),
  tool("resolve_finding", "Mark an open finding on a task you own as resolved, saying how. The checks must pass again afterwards.", { task: { type: "string" }, finding: { type: "string" }, resolution: { type: "string", maxLength: 500 } }, ["task", "finding", "resolution"]),
  tool("close_task", "Close a task you own whose pull request is merged on GitHub, unless work remains. Its paths are released. Without pr, the PR is matched from the task's branch or note.", { task: { type: "string" }, pr: { type: "integer", minimum: 1 } }, ["task"]),
  tool("cancel_task", "Close a task you own without finishing it, only when the user says so. Its paths are released.", { task: { type: "string" }, reason: { type: "string", maxLength: 200 } }, ["task", "reason"]),
];

export function freshened(cwd) {
  const f = freshen(cwd);
  return f && !f.fresh ? { warning: `Could not sync records (${String(f.error).split("\n")[0]}); last synced ${f.lastSync || "never"}. Someone elsewhere may already hold these files; sync when back online.` } : {};
}
const brief = (t) => ({ id: t.id, title: t.title, owner: t.owner, status: t.status, scope: t.scope, ...(t.ref ? { ref: t.ref } : {}), ...(t.note ? { note: t.note.text } : {}), ...(t.pendingHandoff ? { pendingHandoff: t.pendingHandoff } : {}) });

export function callTool(name, args, actor, defaultCwd) {
  const given = args.cwd ?? defaultCwd;
  if (!path.isAbsolute(given)) throw Error("cwd must be an absolute path");
  const cwd = topLevel(given) || given;
  actor = id.resolveActor(cwd, actor);
  if (typeof args.task === "string" && args.task) args = { ...args, task: resolveTaskId(cwd, args.task) };
  setProvenance({ ...id.provenance(cwd, process.env, "mcp"), agent: actor.split("/").pop().toLowerCase() });
  switch (name) {
    case "inbox":
      return co.inbox(cwd, actor, { since: args.since || "" });
    case "check":
      return co.checkPaths(cwd, actor, args.paths);
    case "board":
      return team.board(cwd);
    case "start_task": {
      if (!Array.isArray(args.scope) || !args.scope.length) throw Error("scope must list at least one path");
      const f = freshened(cwd);
      const t = c.addTask(cwd, args.title, args.criteria, actor, args.scope, args.ref, { exclusive: true });
      return { ...brief(c.setStatus(cwd, t.id, "in_progress", actor)), ...f };
    }
    case "set_scope": {
      const f = freshened(cwd);
      return { ...brief(c.setScope(cwd, args.task, actor, args.scope)), ...f };
    }
    case "resume_task":
      return team.resumeFor(cwd, actor, args.task || "");
    case "report_finding":
      return c.reportFinding(cwd, args.task, args.description, actor);
    case "resolve_finding":
      return brief(c.resolveFinding(cwd, args.task, args.finding, actor, args.resolution));
    case "note":
      return brief(c.note(cwd, args.task, actor, args.text));
    case "handoff_offer":
      return brief(c.offer(cwd, args.task, actor, id.resolveActor(cwd, args.to, { self: false }), args.next));
    case "handoff_receive": {
      const f = freshened(cwd);
      const t = c.receive(cwd, args.task, actor);
      return { ...brief(t), ...f, resume: team.resume(cwd, t.id) };
    }
    case "handoff_decline":
      return brief(c.decline(cwd, args.task, actor, args.reason || ""));
    case "handoff_withdraw":
      return brief(c.withdraw(cwd, args.task, actor));
    case "close_task":
      return brief(team.closeMerged(cwd, args.task, actor, { pr: args.pr ?? null }));
    case "cancel_task":
      return brief(c.cancel(cwd, args.task, actor, args.reason));
    default:
      return undefined;
  }
}

const supported = ["2025-06-18", "2025-03-26", "2024-11-05"];
const selfBin = new URL("../bin/agentbridge.js", import.meta.url).pathname;

export function handle(msg, actor, defaultCwd, version) {
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid request");
  if (msg.id === undefined) return null;
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: supported.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : supported[0],
        capabilities: { tools: {} },
        serverInfo: { name: "agentbridge", version },
        instructions: `You are "${actor}" in AgentBridge. Call inbox at the start, check before editing files, start_task to claim new work, note to record status, handoff_offer when passing work on.`,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools });
    case "tools/call": {
      const { name, arguments: args = {} } = msg.params || {};
      if (!tools.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        const result = callTool(name, args, actor, defaultCwd);
        try {
          const top = topLevel(args.cwd ?? defaultCwd);
          if (top) autoSync(top, selfBin, ["inbox", "board", "check"].includes(name) ? { minIntervalMs: 60000 } : { onlyIfChanged: true });
        } catch {}
        return reply({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (e) {
        return reply({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export function serve(actor, { input = process.stdin, output = process.stdout, cwd = process.cwd() } = {}) {
  if (!actor?.trim()) throw Error("--actor required");
  const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)));
  const rl = readline.createInterface({ input });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      return;
    }
    const res = handle(msg, actor, cwd, version);
    if (res) output.write(JSON.stringify(res) + "\n");
  });
  return new Promise((resolve) => rl.on("close", resolve));
}
