import * as signing from "./signing.js";
import { gh } from "./github.js";
import { git } from "./git.js";
import * as st from "./store.js";
import path from "node:path";
import * as c from "./core.js";
import { contractVersion, sameParty } from "./coordination.js";
import { scopesOverlap } from "./scope.js";
import * as sync from "./sync.js";
import { agentNames } from "./identity.js";
import { mergedPullRequests, mergedWork, prMentions } from "./merged.js";
export { mergedPullRequests, mergedWork };

const closed = c.closedStatuses;
export const defaultAssignNext = "Take this task; the criteria are the done bar";

export function assign(cwd, title, criteria, actor, to, { scope = [], ref = "", next = "" } = {}) {
  if (!to?.trim()) throw Error("Recipient required");
  if (to === actor) throw Error("Assign to someone else, or create the task for yourself");
  const t = c.addTask(cwd, title, criteria, actor, scope, ref);
  return c.offer(cwd, t.id, actor, to, next || defaultAssignNext);
}

const openFindings = (t) => t.findings.filter((f) => f.status === "open").length;
const extras = (t) => ({
  ...(t.ref ? { ref: t.ref } : {}),
  ...(t.note ? { note: t.note.text } : {}),
});

export function closeMerged(cwd, id, actor, { pr = null, principal = null } = {}) {
  let number = pr == null || pr === "" ? null : Number(String(pr).replace(/^#/, ""));
  if (number !== null && !(Number.isInteger(number) && number > 0)) throw Error("--pr must be a pull request number");
  const t = c.task(cwd, id);
  if (c.closedStatuses.includes(t.status)) throw Error(`Task is already ${t.status}`);
  if (number === null) {
    const prs = mergedPullRequests(cwd);
    if (!prs) throw Error("Could not list merged pull requests (needs a GitHub origin and gh); pass --pr N");
    const m = mergedWork(t, prs);
    if (!m) throw Error("No merged pull request matches this task's branch or note; pass --pr N");
    number = m.pr;
  }
  let view;
  try {
    view = JSON.parse(gh(cwd, ["pr", "view", String(number), "--json", "number,state,mergedAt,headRefName,url"]));
  } catch (e) {
    throw Error(`Could not read PR #${number} from GitHub: ${e.message}`);
  }
  if (view.state !== "MERGED" || !view.mergedAt) throw Error(`PR #${number} is ${String(view.state).toLowerCase()}, not merged`);
  return c.closeMerged(cwd, id, actor, view, { principal });
}

const openStatuses = ["planned", "in_progress", "needs_work", "implemented", "ready_for_review"];
export function mergedOpen(cwd, { merged = mergedPullRequests } = {}) {
  const prs = merged ? merged(cwd) : null;
  if (!prs) return null;
  return c
    .tasks(cwd)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((t) => ({ t, status: c.effectiveStatus(cwd, t) }))
    .filter(({ status }) => openStatuses.includes(status))
    .map(({ t, status }) => ({ t, status, m: mergedWork(t, prs) }))
    .filter(({ m }) => m)
    .map(({ t, status, m }) => ({ id: t.id, title: t.title, owner: t.owner, status, note: t.note?.text || "", pr: m.pr, how: m.how, branch: m.branch, head: m.head }));
}

export const idleHours = c.idleHours;
export function board(cwd, { merged = mergedPullRequests, now = Date.now() } = {}) {
  const prs = merged ? merged(cwd) : null;
  const strict = c.ownershipMode(cwd) === "block";
  const all = c
    .tasks(cwd)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((t) => ({ t, status: c.effectiveStatus(cwd, t) }));
  const active = all.filter(({ status }) => !closed.includes(status));
  const people = new Map();
  const person = (actor) => {
    if (!people.has(actor)) people.set(actor, { actor, tasks: [], offered: [] });
    return people.get(actor);
  };
  let mergedOpenCount = 0;
  const unowned = [],
    attention = [],
    acceptance = [];
  for (const { t, status } of active) {
    const findings = openFindings(t);
    const item = { id: t.id, title: t.title, status, scope: t.scope, openFindings: findings, ...extras(t), ...(t.pendingHandoff ? { offeredTo: t.pendingHandoff.to } : {}) };
    if (t.owner) person(t.owner).tasks.push(item);
    else unowned.push(item);
    if (t.pendingHandoff)
      person(t.pendingHandoff.to).offered.push({
        id: t.id,
        title: t.title,
        from: t.pendingHandoff.from,
        next: t.pendingHandoff.next,
        at: t.pendingHandoff.at,
        ...(t.ref ? { ref: t.ref } : {}),
      });
    const reasons = [], short = t.id.slice(5, 13);
    if (status === "stale") reasons.push("its code changed after its checks passed; its owner reruns them");
    if (status === "needs_work") reasons.push("sent back for more work; its owner continues it");
    if (findings) reasons.push(`${findings} open finding${findings > 1 ? "s" : ""} for its owner to resolve`);
    if (t.mergeConflicts?.length) reasons.push(`two people changed ${t.mergeConflicts.map((x) => x.field).join(", ")} at once; a person picks one: agentbridge resolve-merge ${short} FIELD ours|theirs`);
    if (status === "in_progress" && !t.scope.length) reasons.push("working without claiming files, so others may edit them; its owner claims them with task scope");
    const lastAt = Date.parse(t.history?.at(-1)?.at || t.updatedAt || "");
    const idle = Math.floor((now - lastAt) / 36e5);
    const m = openStatuses.includes(status) ? mergedWork(t, prs) : null;
    if (m) reasons.push(`PR #${m.pr} (${m.how}) is merged but the task is still ${statusWords[status]}; close it: agentbridge done ${short}`);
    else if (status === "in_progress" && t.scope.length && idle >= idleHours)
      reasons.push(`no activity for ${idle >= 48 ? `${Math.floor(idle / 24)} days` : `${idle}h`} while holding its files; if its owner stopped, move it: agentbridge assign ${short} --to AGENT`);
    if (m) mergedOpenCount++;
    if (openStatuses.includes(status) && t.owner && t.scope.length)
      for (const { t: o, status: os } of active) {
        if (o === t || !openStatuses.includes(os) || !o.owner || sameParty(o.owner, t.owner) || o.createdAt > t.createdAt) continue;
        const paths = t.scope.filter((a) => o.scope.some((b) => scopesOverlap(a, b)));
        if (paths.length)
          reasons.push(`${o.owner} also holds ${paths.join(", ")} ("${o.title}", claimed first), so ${strict ? "neither can edit it" : "both are warned before editing it"}; if it is the same work, a person keeps one: agentbridge done ${short} --reason "duplicate", or hand it over: agentbridge assign ${short} --to ${o.owner}`);
      }
    if (reasons.length) attention.push({ task: t.id, title: t.title, owner: t.owner, reasons });
    if (status.startsWith("verified"))
      acceptance.push({ task: t.id, title: t.title, owner: t.owner });
  }
  return {
    v: contractVersion,
    at: new Date().toISOString(),
    people: [...people.values()].sort((a, b) => a.actor.localeCompare(b.actor)),
    unowned,
    waitingForPeople: {
      decisions: c
        .projectDecisions(cwd)
        .filter((d) => d.status === "proposed")
        .map((d) => ({ id: d.id, summary: d.summary, by: d.proposedBy })),
      acceptance,
    },
    attention,
    done: all.filter(({ status }) => !["cancelled", "merged"].includes(status)).length - active.length,
    merged: all.filter(({ status }) => status === "merged").length,
    mergedOpen: mergedOpenCount,
    cancelled: all.filter(({ status }) => status === "cancelled").length,
  };
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
export const statusWords = {
  planned: "not started",
  in_progress: "working",
  implemented: "built",
  ready_for_review: "in review",
  needs_work: "needs work",
  verified: "verified",
  "verified-unchecked": "verified",
  stale: "checks out of date",
  done: "done",
  "done-unchecked": "done",
  merged: "merged",
  cancelled: "cancelled",
};
const isAgentName = (actor) => agentNames.includes(String(actor).split("/").pop().toLowerCase());
export function boardText(b) {
  const lines = [`Team board — ${b.at}`];
  const task = (x) =>
    `  [${statusWords[x.status] || x.status}] ${x.title}${x.offeredTo ? ` → offered to ${x.offeredTo}` : ""}${x.note ? ` — ${clip(x.note, 120)}` : ""}${x.ref ? ` (${x.ref})` : ""}`;
  for (const p of b.people) {
    lines.push("", p.actor);
    lines.push(...p.tasks.map(task));
    lines.push(...p.offered.map((o) => `  ← offered by ${o.from}, not yet accepted: ${o.title} — ${o.next}${isAgentName(p.actor) ? ` (accept: agentbridge handoff receive ${o.id.slice(5, 13)})` : ""}`));
  }
  if (b.unowned.length) lines.push("", "Unowned", ...b.unowned.map(task));
  const w = b.waitingForPeople;
  if (w.decisions.length || w.acceptance.length)
    lines.push(
      "",
      "Waiting for a person",
      ...w.decisions.map((d) => `  decide: ${d.summary} (proposed by ${d.by})`),
      ...w.acceptance.map((a) => `  accept: ${a.title} (verified, owner ${a.owner})`),
    );
  if (b.attention.length)
    lines.push("", "Needs attention", ...b.attention.map((a) => `  ${a.title} (${a.owner || "unowned"}): ${a.reasons.join("; ")}`));
  if (b.mergedOpen > 1) lines.push("", `${b.mergedOpen} tasks have a merged pull request. Close all of yours at once: agentbridge done`);
  if (b.people.some((p) => p.offered.length && !isAgentName(p.actor)) || w.decisions.length || w.acceptance.length || b.attention.length)
    lines.push("", "Run agentbridge in your own terminal: it asks you about each of these, one key per answer.");
  if (lines.length === 1) lines.push("", "No open work.");
  lines.push("", `${b.done} task${b.done === 1 ? "" : "s"} done${b.merged ? `, ${b.merged} closed by a merged PR` : ""}${b.cancelled ? `, ${b.cancelled} cancelled` : ""}.`);
  return lines.join("\n");
}

export function parseSince(since, now = Date.now()) {
  if (!since) return null;
  const rel = /^(\d+)([mhd])$/.exec(since);
  if (rel) return new Date(now - Number(rel[1]) * { m: 6e4, h: 36e5, d: 864e5 }[rel[2]]).toISOString();
  if (Number.isNaN(Date.parse(since))) throw Error("--since must be an ISO timestamp or a duration like 30m, 24h, 7d");
  return new Date(since).toISOString();
}

const detail = (e) => {
  if (e.event === "handoff_offered") return `to ${e.to}: ${e.next}`;
  if (e.event === "handoff_received") return `from ${e.from}`;
  if (e.event === "status_changed") return `${e.from} → ${e.to}`;
  if (e.event === "scope_changed") return `${e.from.join(", ") || "none"} → ${e.to.join(", ")}`;
  if (e.event === "scope_inferred") return `+ ${e.added.join(", ")} (edited)`;
  if (e.event === "overlap") return `shares files with ${e.with.map((o) => `${o.owner} ("${o.title}")`).join(", ")}`;
  if (e.event === "released") return `${e.scope.join(", ")}: ${e.reason}`;
  return e.text ?? e.summary ?? e.description ?? e.result ?? null;
};

export function log(cwd, { since = "", actor = "", limit = 100 } = {}) {
  const after = parseSince(since);
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > 5000) throw Error("--limit must be an integer from 1 to 5000");
  const entries = [];
  for (const t of c.tasks(cwd))
    for (const e of t.history)
      entries.push({ at: e.at, actor: e.actor ?? e.from ?? null, event: e.event, task: t.id, title: t.title, detail: detail(e), seq: entries.length });
  for (const d of c.projectDecisions(cwd))
    for (const e of d.history)
      entries.push({ at: e.at, actor: e.actor ?? null, event: e.event, decision: d.id, title: d.summary, detail: null, seq: entries.length });
  const picked = entries
    .filter((e) => (!after || e.at > after) && (!actor || e.actor === actor))
    .sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq)
    .map(({ seq, ...e }) => e);
  return { v: contractVersion, since: after, actor: actor || null, total: picked.length, entries: picked.slice(0, n) };
}

export function logText(r) {
  if (!r.entries.length) return "No activity.";
  const rows = r.entries.map(
    (e) => `${e.at.slice(0, 16).replace("T", " ")}  ${(e.actor || "provider").padEnd(10)} ${e.event.padEnd(18)} ${clip(e.title, 60)}${e.detail ? ` — ${clip(e.detail, 100)}` : ""}`,
  );
  if (r.total > r.entries.length) rows.push(`… ${r.total - r.entries.length} older entries; raise --limit`);
  return rows.join("\n");
}

const short = (sha) => (sha ? sha.slice(0, 7) : "none");
const marker = (id) => `<!-- agentbridge:${id} -->`;

export function prSummary(cwd, id) {
  const t = c.status(cwd, id);
  const project = c.projectDecisions(cwd).filter((d) => d.status === "accepted");
  const open = t.findings.filter((f) => f.status === "open");
  const tests = t.evidence.filter((e) => e.source === "verified-run");
  const lastTest = tests.at(-1);
  const verified = t.acceptance?.snapshot ?? t.verification?.current ?? null;
  const row = (k, v) => `| ${k} | ${String(v).replace(/\|/g, "\\|").replace(/\n/g, " ")} |`;
  const lines = [
    marker(t.id),
    `### AgentBridge: ${t.title}`,
    "",
    "| | |",
    "|---|---|",
    row("Owner", t.owner || "unowned"),
    row("Status", t.effectiveStatus),
    ...(t.ref ? [row("Tracker", t.ref)] : []),
    ...(t.note ? [row("Note", `${t.note.text} (${t.note.by})`)] : []),
    row("Verified commit", short(verified?.revision)),
    row("Accepted by", t.acceptance ? `${t.acceptance.actor} at ${t.acceptance.at}` : "not yet"),
    row("Open findings", open.length),
    "",
  ];
  const list = (title, items) => {
    if (items.length) lines.push(`**${title}**`, ...items.map((x) => `- ${x}`), "");
  };
  list("Open findings", open.map((f) => f.description));
  list("Decisions", [
    ...project.map((d) => `${d.summary} (project, accepted by ${d.acceptedBy})`),
    ...t.decisions.filter((d) => d.status === "accepted").map((d) => `${d.summary} (accepted by ${d.acceptedBy})`),
  ]);
  list("Work", [
    ...t.implementations.map((i) => `Implemented by ${i.actor} with ${i.provider}${i.source === "external-record" ? " (recorded claim)" : ""}`),
    ...t.reviews.map((r) => `Reviewed by ${r.actor} with ${r.provider}: ${r.outcome} at ${short(r.snapshot?.revision)}`),
    ...(lastTest ? [`Latest test run: ${lastTest.result} at ${short(lastTest.snapshot?.revision)}`] : []),
  ]);
  lines.push("_From AgentBridge records. Actor names are labels, not authenticated identities._");
  return { task: t, verified, open, markdown: lines.join("\n") };
}

export function prState({ task, verified, open }, head, signature = null) {
  const s = task.effectiveStatus;
  if (open.length) return ["failure", `${open.length} open finding${open.length > 1 ? "s" : ""}`];
  if (s === "stale") return ["failure", "Code changed after its checks"];
  if (s === "needs_work") return ["failure", "Needs work"];
  if (verified && verified.revision !== head)
    return ["failure", `Checks cover ${short(verified.revision)}, PR head is ${short(head)}`];
  if (s.startsWith("done") && signature?.required && signature.state !== "verified")
    return ["failure", `Acceptance signature ${signature.state}${signature.reason ? `: ${signature.reason}` : ""}`];
  if (s.startsWith("done"))
    return ["success", `Verified and accepted by ${task.acceptance.actor}${signature?.state === "verified" ? ` (signed by ${signature.login})` : ""}`];
  if (s.startsWith("verified")) return ["pending", "Verified; waiting for human acceptance"];
  return ["pending", `In progress: ${s}`];
}

export function prPublish(cwd, id, pr) {
  if (!/^\d+$/.test(String(pr))) throw Error("--pr must be a pull request number");
  const summary = prSummary(cwd, id);
  const head = gh(cwd, ["pr", "view", String(pr), "--json", "headRefOid", "-q", ".headRefOid"]).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw Error("Could not read the pull request head commit");
  const comments = JSON.parse(gh(cwd, ["api", `repos/{owner}/{repo}/issues/${pr}/comments`, "--paginate", "--slurp"]) || "[]").flat();
  const existing = comments.find((x) => x.body?.startsWith(marker(summary.task.id)));
  const body = JSON.stringify({ body: summary.markdown });
  if (existing) gh(cwd, ["api", "-X", "PATCH", `repos/{owner}/{repo}/issues/comments/${existing.id}`, "--input", "-"], body);
  else gh(cwd, ["api", "-X", "POST", `repos/{owner}/{repo}/issues/${pr}/comments`, "--input", "-"], body);
  const t = c.task(cwd, summary.task.id);
  const accepted = t.history.findLast((e) => e.event === "human_accepted");
  const signature = accepted ? { required: signing.required(cwd), ...signing.verifyEvent(cwd, t.id, accepted) } : null;
  const [state, description] = prState(summary, head, signature);
  gh(
    cwd,
    ["api", "-X", "POST", `repos/{owner}/{repo}/statuses/${head}`, "--input", "-"],
    JSON.stringify({ state, context: "agentbridge", description: description.slice(0, 140) }),
  );
  return { pr: Number(pr), head, comment: existing ? "updated" : "created", status: { state, description } };
}

export function approvals(cwd, { verify = false } = {}) {
  const cache = new Map();
  const out = [];
  const records = [
    ...c.tasks(cwd).map((t) => ({ r: t, title: t.title })),
    ...c.projectDecisions(cwd).map((d) => ({ r: d, title: d.summary })),
    { r: { id: "project", history: st.read(path.join(st.root(cwd), "project.json")).history || [] }, title: "Project policy" },
  ];
  for (const { r, title } of records)
    for (const e of r.history || [])
      if (signing.approvalEvents.has(e.event)) {
        const check = verify ? signing.verifyEvent(cwd, r.id, e, cache) : { state: e.sig ? "signed" : "unsigned" };
        out.push({ record: r.id, title, event: e.event, actor: e.actor ?? null, at: e.at, via: e.by?.via ?? null, ...check });
      }
  out.sort((a, b) => b.at.localeCompare(a.at));
  return { required: signing.required(cwd), verified: verify, approvals: out };
}

export function approvalsText(r) {
  const mark = { verified: "✓", signed: "•", unsigned: "–", invalid: "✗", unchecked: "?" };
  const lines = [`Approvals${r.required ? " (signatures required)" : ""}${r.verified ? ", checked against GitHub signing keys" : ""}`];
  for (const a of r.approvals)
    lines.push(`  ${mark[a.state]} ${a.at.slice(0, 16).replace("T", " ")}  ${a.state.padEnd(9)} ${String(a.actor).padEnd(12)} ${a.event.padEnd(17)} ${clip(a.title, 50)}${a.login ? `  [${a.login}${a.presence ? ", touch" : ""}]` : ""}${a.reason ? `  ${a.reason}` : ""}`);
  if (!r.approvals.length) lines.push("  none");
  return lines.join("\n");
}

export const setApprovalPolicy = (cwd, value, actor) => setPolicy(cwd, "signedApprovals", value, actor);
export function setPolicy(cwd, key, value, actor) {
  const release = st.lock(cwd);
  try {
    const p = path.join(st.root(cwd), "project.json");
    const config = st.read(p);
    const record = { id: "project", history: (config.history ??= []) };
    st.event(record, "policy_changed", { actor, [key]: value });
    config[key] = value;
    st.atomic(p, config);
    const e = config.history.at(-1);
    return { [key]: value, by: actor, at: e.at, signed: !!e.sig };
  } finally {
    release();
  }
}

const tryGit = (cwd, args) => {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
};
function codeState(cwd, branch) {
  if (!branch || tryGit(cwd, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]) === null) return branch ? { branch, local: false } : null;
  const head = tryGit(cwd, ["rev-parse", "--short=12", branch]);
  const def = (tryGit(cwd, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]) || "").trim();
  const base = [def, "origin/main", "main", "origin/master", "master"].find((b) => b && b !== branch && tryGit(cwd, ["rev-parse", "--verify", "-q", b]) !== null);
  if (!base) return { branch, local: true, head };
  const files = (tryGit(cwd, ["diff", "--name-only", `${base}...${branch}`]) || "").split("\n").filter(Boolean);
  const ahead = Number(tryGit(cwd, ["rev-list", "--count", `${base}..${branch}`]) || 0);
  return { branch, local: true, head, base, commitsAhead: ahead, changedFiles: files.slice(0, 30), ...(files.length > 30 ? { moreFiles: files.length - 30 } : {}) };
}

const lastAt = (t, event) => (t.history || []).filter((e) => e.event === event).map((e) => e.at).at(-1) || "";
const pullRef = (number, prs) => {
  const p = prs?.find((x) => x.number === number);
  return p ? { number, merged: true, mergedAt: p.mergedAt } : { number, merged: false };
};
const ago = (at) => {
  const h = Math.floor((Date.now() - Date.parse(at)) / 36e5);
  return h < 1 ? "under an hour ago" : h < 48 ? `${h}h ago` : `${Math.floor(h / 24)} days ago`;
};

export function resume(cwd, id, { merged = mergedPullRequests } = {}) {
  const t = c.status(cwd, id);
  const status = t.effectiveStatus;
  const branches = (t.history || []).map((e) => e.by?.branch).filter(Boolean);
  const main = new Set(["main", "master", (tryGit(cwd, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]) || "").replace(/^origin\//, "")]);
  const branch = branches.filter((b) => !main.has(b)).at(-1) || branches.at(-1) || null;
  const prs = merged ? merged(cwd) : null;
  const m = c.closedStatuses.includes(status) ? null : mergedWork(t, prs);
  const mentioned = prMentions(t.note?.text || "");
  const findings = t.findings.filter((f) => f.status === "open").map((f) => ({ id: f.id, description: clip(f.description, 300), author: f.author }));
  const decisions = [
    ...c.projectDecisions(cwd).filter((d) => d.status === "accepted").map((d) => ({ summary: d.summary, scope: "project", acceptedBy: d.acceptedBy })),
    ...t.decisions.filter((d) => d.status === "accepted").map((d) => ({ summary: d.summary, scope: "task", acceptedBy: d.acceptedBy })),
  ];
  const pendingDecisions = [
    ...c.projectDecisions(cwd).filter((d) => d.status === "proposed"),
    ...t.decisions.filter((d) => d.status === "proposed"),
  ].map((d) => ({ id: d.id, summary: d.summary, proposedBy: d.proposedBy }));
  const short = t.id.slice(5, 13);
  const next = c.closedStatuses.includes(status) ? `Nothing; the task is ${statusWords[status] || status}. Reopen it only if the user asks.`
    : t.pendingHandoff ? `${t.pendingHandoff.to} accepts it (agentbridge handoff receive ${short}), then: ${t.pendingHandoff.next}`
    : m ? `PR #${m.pr} is merged. If nothing remains, close it: agentbridge done ${short} (agents: close_task)`
    : findings.length && !(t.nextAction && lastAt(t, "handoff_received") > lastAt(t, "finding_opened")) ? `Resolve ${findings.length} open finding${findings.length > 1 ? "s" : ""} below, then rerun the checks`
    : status === "stale" ? "The code changed after its checks passed; rerun the checks"
    : status.startsWith("verified") ? `Checks pass; a person accepts it: agentbridge done ${short}`
    : ["implemented", "ready_for_review"].includes(status) ? (mentioned.length
      ? `Built. When PR #${mentioned.at(-1)} merges, close the task: agentbridge task close ${short}`
      : `Built. Open a pull request and note its number (agentbridge task note ${short} "PR #N"); when it merges, close the task`)
    : t.nextAction ? `${t.nextAction}${findings.length ? ` (${findings.length} open finding${findings.length > 1 ? "s" : ""} below)` : ""}`
    : t.note ? "Continue from the last note" : "No next step recorded; read the criteria, and ask the user if unclear";
  const st = sync.isSynced(cwd) ? sync.status(cwd) : null;
  const others = c.context(cwd, id).related.filter((x) => !(x.owner && t.owner && sameParty(x.owner, t.owner)));
  return {
    v: contractVersion,
    task: t.id,
    short,
    goal: t.title,
    criteria: t.criteria.map((x) => x.text),
    owner: t.owner,
    status,
    statusWords: statusWords[status] || status,
    scope: t.scope,
    ...(t.ref ? { ref: t.ref } : {}),
    note: t.note ? { text: t.note.text, by: t.note.by, at: t.note.at } : null,
    next,
    code: codeState(cwd, branch),
    pullRequest: m ? { number: m.pr, merged: true, mergedAt: m.mergedAt } : mentioned.length ? pullRef(mentioned.at(-1), prs) : null,
    decisions,
    pendingDecisions,
    openFindings: findings,
    checks: {
      unresolved: t.evidence.length || t.runs.length || t.reviews.length || t.implementations.length ? t.verificationCheck.reasons : [],
      evidence: t.evidence.slice(-3).map((e) => ({ result: e.result, command: e.command || e.argv?.join(" "), revision: e.snapshot?.revision || e.revision || null, at: e.at })),
    },
    related: others.slice(0, 5).map((x) => ({ id: x.id, title: x.title, owner: x.owner, status: x.status })),
    ...(others.length > 5 ? { moreRelated: others.length - 5 } : {}),
    freshness: { taskUpdatedAt: t.updatedAt, recordsSyncedAt: st ? st.lastSync : null, unsharedChanges: st ? st.pending + (st.ahead || 0) : null },
  };
}

export function resumeText(r) {
  const lines = [`${r.short}  "${r.goal}"  [${r.statusWords}, owner ${r.owner || "nobody"}]`, `Next: ${r.next}`];
  if (r.criteria.length) lines.push(`Done when: ${r.criteria.join("; ")}`);
  if (r.note) lines.push(`Last note (${r.note.by}, ${r.note.at.slice(0, 16).replace("T", " ")}): ${r.note.text}`);
  if (r.code) lines.push(r.code.local ? `Code: branch ${r.code.branch} @ ${r.code.head}${r.code.base ? `, ${r.code.commitsAhead} commit(s) ahead of ${r.code.base}, ${r.code.changedFiles.length + (r.code.moreFiles || 0)} file(s) changed${r.code.changedFiles.length ? `: ${r.code.changedFiles.slice(0, 8).join(", ")}${r.code.changedFiles.length > 8 || r.code.moreFiles ? ", …" : ""}` : ""}` : ""}` : `Code: branch ${r.code.branch} (not in this clone; git fetch)`);
  if (r.pullRequest) lines.push(`PR #${r.pullRequest.number}${r.pullRequest.merged ? " (merged)" : ""}`);
  if (r.scope.length) lines.push(`Files held: ${r.scope.join(", ")}`);
  if (r.decisions.length) lines.push("Decided:", ...r.decisions.map((d) => `  - ${d.summary} (${d.scope}, accepted by ${d.acceptedBy})`));
  if (r.pendingDecisions.length) lines.push("Waiting for a person to decide:", ...r.pendingDecisions.map((d) => `  - ${d.summary} (proposed by ${d.proposedBy})`));
  if (r.openFindings.length) lines.push("Open findings:", ...r.openFindings.map((f) => `  - ${f.description} (${f.author}, ${f.id})`));
  if (r.checks.unresolved.length && ["implemented", "ready_for_review", "stale"].includes(r.status)) lines.push("Checks not yet satisfied:", ...r.checks.unresolved.slice(0, 5).map((x) => `  - ${x}`));
  if (r.checks.evidence.length) lines.push("Latest checks:", ...r.checks.evidence.map((e) => `  - ${e.result}: ${e.command || "?"}${e.revision ? ` @ ${String(e.revision).slice(0, 12)}` : ""}`));
  if (r.related.length) lines.push("Others on overlapping files:", ...r.related.map((x) => `  - ${x.title} (${x.owner}, ${statusWords[x.status] || x.status})`), ...(r.moreRelated ? [`  +${r.moreRelated} more`] : []));
  const f = r.freshness;
  lines.push(f.recordsSyncedAt ? `Records synced ${ago(f.recordsSyncedAt)} (${f.recordsSyncedAt.slice(0, 16).replace("T", " ")})${f.unsharedChanges ? `; ${f.unsharedChanges} local change(s) not shared yet` : ""}` : "Records are local to this machine");
  if (r.otherOpenTasks?.length) lines.push(`Also open: ${r.otherOpenTasks.map((x) => `${x.id.slice(5, 13)} "${clip(x.title, 40)}"`).join(", ")}`);
  return lines.join("\n");
}

export function resumeFor(cwd, actor, id, opts) {
  if (id) return resume(cwd, id, opts);
  const mine = c
    .tasks(cwd)
    .filter((t) => t.owner && sameParty(actor, t.owner) && !closed.includes(c.effectiveStatus(cwd, t)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!mine.length) throw Error(`${actor} has no open tasks; name one: resume TASK`);
  return { ...resume(cwd, mine[0].id, opts), ...(mine.length > 1 ? { otherOpenTasks: mine.slice(1, 10).map((t) => ({ id: t.id, title: t.title, owner: t.owner })) } : {}) };
}
