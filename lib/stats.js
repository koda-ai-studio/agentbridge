import fs from "node:fs";
import path from "node:path";
import * as c from "./core.js";
import * as st from "./store.js";
import { agentNames } from "./identity.js";

const blockedFile = (cwd) => path.join(st.root(cwd), "local", "blocked.jsonl");

export function logBlocked(cwd, kind, actor, r) {
  try {
    const owners = [...new Set(r.conflicts.map((x) => x.owner).filter(Boolean))];
    const tasks = [...new Set(r.conflicts.map((x) => x.task))];
    fs.mkdirSync(path.dirname(blockedFile(cwd)), { recursive: true });
    fs.appendFileSync(blockedFile(cwd), JSON.stringify({ at: new Date().toISOString(), kind, actor, owners, tasks }) + "\n", { mode: 0o600 });
  } catch {}
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const minutes = (a, b) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 60000);
const isAgent = (actor) => agentNames.includes(String(actor).split("/").pop().toLowerCase());
const monday = (iso) => {
  const d = new Date(iso);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const settled = new Set(["handoff_received", "handoff_declined", "handoff_withdrawn", "reassigned", "cancelled", "closed_merged"]);

export function stats(cwd, { since = "" } = {}) {
  const from = since ? Date.parse(since) : 0;
  if (Number.isNaN(from)) throw Error("--since must be a date, for example 2026-11-01");
  const tasks = c.tasks(cwd);
  const r = {
    since: since || null,
    handoffs: { offered: 0, accepted: 0, declined: 0, withdrawn: 0, minutesToAccept: null, minutesToResume: null, resumed: 0 },
    tasks: { created: 0, closedByMergedPr: 0, done: 0, cancelled: 0, movedBetweenAgents: 0 },
    blockedEdits: { total: 0, byActor: {}, commits: 0 },
    weeks: [],
  };
  const toAccept = [], toResume = [], weeks = new Map();
  for (const t of tasks) {
    const h = (t.history || []).filter((e) => Date.parse(e.at) >= from);
    for (const [i, e] of h.entries()) {
      if (e.actor) {
        const w = weeks.get(monday(e.at)) || { people: new Set(), agents: new Set() };
        (isAgent(e.actor) ? w.agents : w.people).add(e.actor);
        weeks.set(monday(e.at), w);
      }
      if (e.event === "created") r.tasks.created++;
      if (e.event === "closed_merged") r.tasks.closedByMergedPr++;
      if (e.event === "cancelled") r.tasks.cancelled++;
      if (e.event === "reassigned") r.tasks.movedBetweenAgents++;
      if (e.event === "status_changed" && e.to === "done") r.tasks.done++;
      if (e.event === "handoff_declined") r.handoffs.declined++;
      if (e.event === "handoff_withdrawn") r.handoffs.withdrawn++;
      if (e.event === "handoff_offered") {
        r.handoffs.offered++;
        const end = h.slice(i + 1).find((x) => settled.has(x.event));
        if (end?.event === "handoff_received") toAccept.push(minutes(e.at, end.at));
      }
      if (e.event === "handoff_received") {
        r.handoffs.accepted++;
        const next = h.slice(i + 1).find((x) => x.actor === e.actor);
        if (next) toResume.push(minutes(e.at, next.at));
      }
    }
  }
  r.handoffs.minutesToAccept = median(toAccept);
  r.handoffs.minutesToResume = median(toResume);
  r.handoffs.resumed = toResume.length;
  try {
    for (const line of fs.readFileSync(blockedFile(cwd), "utf8").split("\n").filter(Boolean)) {
      const b = JSON.parse(line);
      if (Date.parse(b.at) < from) continue;
      r.blockedEdits.total++;
      if (b.kind === "commit") r.blockedEdits.commits++;
      r.blockedEdits.byActor[b.actor] = (r.blockedEdits.byActor[b.actor] || 0) + 1;
    }
  } catch {}
  r.weeks = [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-8)
    .map(([week, w]) => ({ week, people: w.people.size, agents: w.agents.size }));
  return r;
}

const fmt = (m) => (m === null ? "n/a" : m < 90 ? `${Math.round(m)} min` : m < 48 * 60 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} days`);

export function statsText(r) {
  const h = r.handoffs, t = r.tasks, b = r.blockedEdits;
  const by = Object.entries(b.byActor).map(([a, n]) => `${a} ${n}`).join(", ");
  return [
    `AgentBridge usage${r.since ? ` since ${r.since}` : ""} (computed on this machine; nothing is sent anywhere)`,
    `Handoffs: ${h.offered} offered, ${h.accepted} accepted, ${h.declined} declined, ${h.withdrawn} withdrawn`,
    `  median time to accept: ${fmt(h.minutesToAccept)}; to first action after accepting: ${fmt(h.minutesToResume)} (${h.resumed} handoffs)`,
    `Tasks: ${t.created} created, ${t.closedByMergedPr} closed by a merged PR, ${t.done} accepted done, ${t.cancelled} cancelled, ${t.movedBetweenAgents} moved between agents`,
    `Edits blocked on this machine: ${b.total}${b.commits ? ` (${b.commits} commits)` : ""}${by ? `: ${by}` : ""}`,
    `Active per week: ${r.weeks.map((w) => `${w.week} ${w.people} people, ${w.agents} agents`).join("; ") || "none"}`,
    "",
    "Counts and actor names only: no titles, notes, paths or code. Paste it into your pilot feedback.",
  ].join("\n");
}
