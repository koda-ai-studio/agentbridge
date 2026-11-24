import fs from "node:fs";
import path from "node:path";
import * as c from "./core.js";
import * as st from "./store.js";
import * as team from "./team.js";
import { reviewItems } from "./review.js";
import { git } from "./git.js";
import { gh } from "./github.js";
import { contractVersion } from "./coordination.js";
import * as identity from "./identity.js";
import { freshen } from "./sync.js";

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || "");
const short = (id) => id.slice(5, 13);
const prMentions = (text = "") => [...String(text).matchAll(/\b(?:PR|pull request)\s*#?(\d+)\b|\/pull\/(\d+)\b/gi)].map((m) => Number(m[1] || m[2]));
const cursorFile = (cwd) => path.join(st.root(cwd), "local", "digest-cursors.json");
const defaultDays = 7;

export function openPullRequests(cwd) {
  try {
    if (!/github\.com[:/]/.test(git(cwd, ["remote", "get-url", "origin"]))) return null;
    return JSON.parse(gh(cwd, ["pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,author,headRefName,isDraft"]));
  } catch {
    return null;
  }
}

function personFor(cwd, actor) {
  if (identity.login(cwd)) return actor.split("/")[0];
  return identity.agentNames.includes(actor.toLowerCase()) ? identity.personName(cwd) || null : actor;
}

export function viewPullRequest(cwd, number) {
  try {
    const v = JSON.parse(gh(cwd, ["pr", "view", String(number), "--json", "state,isDraft"]));
    return v.state === "OPEN" ? (v.isDraft ? "draft" : "open") : String(v.state).toLowerCase();
  } catch {
    return null;
  }
}

function readCursors(cwd) {
  try {
    return JSON.parse(fs.readFileSync(cursorFile(cwd), "utf8"));
  } catch {
    return {};
  }
}

export function digest(cwd, me, { since = "", advance = true, merged = team.mergedPullRequests, openPrs = openPullRequests, viewPr = viewPullRequest, now = Date.now() } = {}) {
  let synced = null;
  try {
    synced = freshen(cwd);
  } catch {}
  const cursors = readCursors(cwd);
  const fallback = new Date(now - defaultDays * 864e5).toISOString();
  const after = !since || since === "last" ? cursors[me] || fallback : team.parseSince(since, now);
  const until = new Date(now).toISOString();
  const tasks = c.tasks(cwd).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const fresh = (e) => e.at > after;
  const prs = openPrs ? openPrs(cwd) : null;
  const mergedPrs = merged ? merged(cwd) : null;
  const branchOf = (t) => (t.history || []).map((e) => e.by?.branch).filter(Boolean).at(-1) || null;

  const r = {
    v: contractVersion,
    me,
    since: after,
    until,
    waitingOnYou: [],
    merged: [],
    finished: [],
    handoffs: [],
    decisions: { accepted: [], proposed: [] },
    findings: [],
    working: [],
    pullRequests: null,
    ...(synced && !synced.fresh ? { warning: `Could not sync records; this shows what this machine knew at ${synced.lastSync || "its last sync"}` } : {}),
  };

  const person = personFor(cwd, me);
  if (person !== me) r.person = person;
  try {
    if (person) r.waitingOnYou = reviewItems(cwd, person, { merged }).map((x) => x.text.replace(/:?\s*\n\s*/g, (m) => (m.trim().startsWith(":") ? ": " : "; ")).trim());
  } catch {}

  for (const t of tasks) {
    for (const [i, e] of t.history.entries()) {
      if (!fresh(e)) continue;
      if (e.event === "closed_merged") r.merged.push({ task: t.id, title: t.title, owner: t.owner, pr: e.pr?.number ?? null, at: e.at });
      if (e.event === "cancelled") r.finished.push({ task: t.id, title: t.title, owner: t.owner, how: "cancelled", reason: clip(e.reason, 120), at: e.at });
      if (e.event === "human_accepted") r.finished.push({ task: t.id, title: t.title, owner: t.owner, how: "accepted done", at: e.at });
      if (e.event === "handoff_offered") {
        const end = t.history.slice(i + 1).find((x) => ["handoff_received", "handoff_declined", "handoff_withdrawn", "cancelled", "closed_merged", "reassigned"].includes(x.event));
        const state = !end ? "waiting" : { handoff_received: "accepted", handoff_declined: "declined", handoff_withdrawn: "withdrawn" }[end.event] || "closed";
        r.handoffs.push({ task: t.id, title: t.title, from: e.actor, to: e.to, state, at: e.at });
      }
      if (e.event === "finding_opened") {
        const f = t.findings.find((x) => x.id === e.ref);
        if (f && f.status === "open") r.findings.push({ task: t.id, title: t.title, description: clip(f.description, 160), author: f.author, at: e.at });
      }
    }
    for (const d of t.decisions || [])
      if (d.status === "accepted" && d.acceptedAt > after) r.decisions.accepted.push({ summary: d.summary, scope: "task", task: t.id, acceptedBy: d.acceptedBy, at: d.acceptedAt });
  }
  for (const d of c.projectDecisions(cwd)) {
    if (d.status === "accepted" && (d.acceptedAt || "") > after) r.decisions.accepted.push({ summary: d.summary, scope: "project", acceptedBy: d.acceptedBy, at: d.acceptedAt });
    if (d.status === "proposed") r.decisions.proposed.push({ summary: d.summary, proposedBy: d.proposedBy });
  }

  const linked = new Set();
  let lookups = 0;
  const owners = new Map();
  for (const t of tasks) {
    const status = c.effectiveStatus(cwd, t);
    if (c.closedStatuses.includes(status)) continue;
    const branch = branchOf(t);
    const mentioned = prMentions(t.note?.text || "").at(-1) ?? null;
    const open = prs?.find((p) => p.number === mentioned || (branch && p.headRefName === branch)) || null;
    const m = team.mergedWork(t, mergedPrs);
    if (open) linked.add(open.number);
    const pr = m ? { number: m.pr, state: "merged" }
      : open ? { number: open.number, state: open.isDraft ? "draft" : "open" }
      : mentioned ? { number: mentioned, state: prs && viewPr && lookups++ < 5 ? viewPr(cwd, mentioned) : null }
      : null;
    const key = t.owner || "unowned";
    if (!owners.has(key)) owners.set(key, []);
    owners.get(key).push({
      task: t.id,
      title: t.title,
      status,
      ...(t.note ? { note: clip(t.note.text, 140) } : {}),
      ...(t.pendingHandoff ? { offeredTo: t.pendingHandoff.to } : {}),
      ...(t.ref ? { ref: t.ref } : {}),
      pr,
      changed: (t.history.at(-1)?.at || t.updatedAt) > after,
    });
  }
  r.working = [...owners.entries()].map(([owner, ts]) => ({ owner, tasks: ts.sort((a, b) => b.changed - a.changed) }));
  if (prs) r.pullRequests = { open: prs.length, withoutTask: prs.filter((p) => !linked.has(p.number)).map((p) => ({ number: p.number, title: clip(p.title, 80), author: p.author?.login || null, draft: Boolean(p.isDraft) })) };

  if (advance && me) {
    try {
      fs.mkdirSync(path.dirname(cursorFile(cwd)), { recursive: true });
      st.atomic(cursorFile(cwd), { ...readCursors(cwd), [me]: until });
    } catch {}
  }
  return r;
}

const when = (iso) => iso.slice(0, 16).replace("T", " ");
const words = (s) => team.statusWords[s] || s;

export function digestText(r) {
  const out = [`AgentBridge digest for ${r.me}, since ${when(r.since)} UTC`];
  const section = (title, lines) => {
    if (lines.length) out.push("", title, ...lines.map((l) => `  - ${l}`));
  };
  section(r.person ? `Waiting on ${r.person} (they run agentbridge to answer, one key each)` : "Waiting on you (run agentbridge to answer, one key each)", r.waitingOnYou);
  const byPr = new Map();
  for (const m of r.merged) byPr.set(m.pr ?? `t${m.task}`, [...(byPr.get(m.pr ?? `t${m.task}`) || []), m]);
  section("Merged", [...byPr.values()].map((ms) => ms.length === 1
    ? `"${ms[0].title}" (${ms[0].owner})${ms[0].pr ? `, PR #${ms[0].pr}` : ""}`
    : `PR #${ms[0].pr}: ${ms.length} tasks (${[...new Set(ms.map((m) => m.owner))].join(", ")}): ${ms.map((m) => `"${clip(m.title, 50)}"`).join("; ")}`));
  section("Finished otherwise", r.finished.map((f) => `"${f.title}" (${f.owner}), ${f.how}${f.reason ? `: ${f.reason}` : ""}`));
  section("Handoffs", r.handoffs.map((h) => `"${h.title}": ${h.from} → ${h.to}, ${h.state}`));
  section("Decided", r.decisions.accepted.map((d) => `${d.summary} (${d.scope}, accepted by ${d.acceptedBy})`));
  section("Proposed, not yet decided", r.decisions.proposed.filter((d) => !r.waitingOnYou.some((w) => w.includes(`"${d.summary}"`))).map((d) => `${d.summary} (proposed by ${d.proposedBy})`));
  section("New findings, still open", r.findings.map((f) => `${f.description} (on "${f.title}", by ${f.author})`));
  const pr = (p) => (p ? ` · PR #${p.number}${p.state ? ` ${p.state}` : ""}` : "");
  const line = (w, t) => `${w.owner}: "${t.title}" [${words(t.status)}]${pr(t.pr)}${t.offeredTo ? ` · offered to ${t.offeredTo}` : ""}${t.note ? ` · ${t.note}` : ""}`;
  section("Open work that changed", r.working.flatMap((w) => w.tasks.filter((t) => t.changed).map((t) => line(w, t))));
  const quiet = r.working.flatMap((w) => w.tasks.filter((t) => !t.changed).map((t) => line(w, t)));
  if (quiet.length) section(`Open work, unchanged (${quiet.length})`, quiet.slice(0, 10).concat(quiet.length > 10 ? [`… ${quiet.length - 10} more: agentbridge board`] : []));
  if (r.pullRequests?.withoutTask.length)
    section("Open pull requests with no AgentBridge task", r.pullRequests.withoutTask.map((p) => `#${p.number} ${p.title}${p.author ? ` (${p.author})` : ""}${p.draft ? ", draft" : ""}`));
  if (r.warning) out.splice(1, 0, r.warning);
  if (out.length === 1) out.push("", "Nothing new, and no open work.");
  else if (!r.waitingOnYou.length) out.splice(1, 0, r.person ? `Nothing waits on ${r.person}.` : "Nothing waits on you.");
  return out.join("\n");
}
