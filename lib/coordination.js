import fs from "node:fs";
import path from "node:path";
import * as s from "./store.js";
import * as core from "./core.js";
import { git } from "./git.js";
import { pathInScope } from "./scope.js";
import { releasedByMerge, mergedPullRequests } from "./merged.js";
export { pathInScope, scopesOverlap } from "./scope.js";

export const contractVersion = 1;
export const doNotEditLimit = 50;
const closed = core.closedStatuses;
export function nearestExisting(p) {
  let dir = p;
  while (!fs.existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return dir;
}
export function toRepoPath(p) {
  if (typeof p !== "string" || !p.trim()) throw Error("Path required");
  if (!path.isAbsolute(p)) return core.normalizeScope([p])[0];
  const existing = nearestExisting(p);
  const dir = fs.statSync(existing).isDirectory()
    ? existing
    : path.dirname(existing);
  const top = fs.realpathSync(git(dir, ["rev-parse", "--show-toplevel"]));
  const real = path.join(fs.realpathSync(existing), path.relative(existing, p));
  const rel = path.relative(top, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
    throw Error(`Path ${JSON.stringify(p)} is not inside a Git repository file`);
  return core.normalizeScope([rel.split(path.sep).join("/")])[0];
}
function activeTasksCovering(cwd, paths) {
  return core
    .tasks(cwd)
    .filter((t) => t.scope.some((e) => paths.some((p) => pathInScope(e, p))))
    .map((t) => ({ t, status: core.effectiveStatus(cwd, t) }))
    .filter((x) => !closed.includes(x.status));
}
export const sameParty = (actor, owner) =>
  Boolean(actor && owner) && (actor === owner || actor.startsWith(`${owner}/`) || owner.startsWith(`${actor}/`));
export function checkPaths(cwd, actor, paths, { merged = mergedPullRequests, now = Date.now() } = {}) {
  if (!actor?.trim()) throw Error("Actor required");
  if (!Array.isArray(paths) || !paths.length)
    throw Error("At least one path required");
  const repoPaths = paths.map(toRepoPath);
  const active = activeTasksCovering(cwd, repoPaths);
  const conflicts = [],
    owned = [];
  for (const p of repoPaths)
    for (const { t, status } of active) {
      if (!t.scope.some((e) => pathInScope(e, p))) continue;
      if (sameParty(actor, t.owner)) {
        owned.push({ path: p, task: t.id, ...(t.owner !== actor ? { for: t.owner } : {}) });
        continue;
      }
      conflicts.push({
        path: p,
        task: t.id,
        title: t.title,
        owner: t.owner,
        status,
        since: t.updatedAt,
        ...(t.pendingHandoff?.to === actor
          ? { hint: "Handoff to you is pending; run handoff receive first" }
          : {}),
      });
    }
  const gone = releasedByMerge(cwd, [...new Set(conflicts.map((x) => x.task))].map((id) => active.find(({ t }) => t.id === id).t), { merged });
  const idleSince = now - core.idleHours * 36e5;
  const why = (x) => (gone.has(x.task) ? { reason: "merged", pr: gone.get(x.task).pr } : Date.parse(x.since) < idleSince ? { reason: "idle", since: x.since } : null);
  const released = conflicts
    .map((x) => [x, why(x)])
    .filter(([, w]) => w)
    .map(([{ path, task, title, owner }, w]) => ({ path, task, title, owner, ...w }));
  const blocking = conflicts.filter((x) => !why(x));
  const mode = core.ownershipMode(cwd);
  return {
    v: contractVersion,
    actor,
    mode,
    allowed: blocking.length === 0,
    conflicts: blocking,
    owned,
    ...(released.length ? { released } : {}),
    unclaimed: repoPaths.filter(
      (p) => !active.some(({ t }) => t.scope.some((e) => pathInScope(e, p))),
    ),
  };
}
const noteOf = (t) => ({ ...(t.ref ? { ref: t.ref } : {}), ...(t.note ? { note: t.note.text } : {}) });
const cursorFile = (cwd, actor) =>
  path.join(s.root(cwd), "local", "inbox", `${s.digest(actor).slice(0, 16)}.json`);
function resolveSince(cwd, actor, since) {
  if (!since) return null;
  if (since === "last") {
    const p = cursorFile(cwd, actor);
    return fs.existsSync(p) ? s.read(p).at : null;
  }
  if (Number.isNaN(Date.parse(since)))
    throw Error("--since must be an ISO timestamp or 'last'");
  return new Date(since).toISOString();
}
export function inbox(cwd, actor, { since = "" } = {}) {
  if (!actor?.trim()) throw Error("Actor required");
  const at = s.now(),
    after = resolveSince(cwd, actor, since),
    fresh = (when) => !after || when > after;
  const all = core
    .tasks(cwd)
    .map((t) => ({ t, status: core.effectiveStatus(cwd, t) }));
  const mine = all.filter(({ t }) => t.owner === actor);
  const involved = all.filter(
    ({ t }) =>
      t.owner === actor ||
      t.pendingHandoff?.to === actor ||
      t.history.some((e) => (e.actor ?? e.from) === actor),
  );
  const decisions = core.projectDecisions(cwd);
  const others = all
    .filter(({ t, status }) => !sameParty(actor, t.owner) && !closed.includes(status) && t.scope.length)
    .sort((a, b) => (b.t.updatedAt || "").localeCompare(a.t.updatedAt || "") || b.t.version - a.t.version);
  const result = {
    v: contractVersion,
    actor,
    at,
    since: after,
    owned: mine
      .filter(({ status }) => !closed.includes(status))
      .map(({ t, status }) => ({
        id: t.id,
        title: t.title,
        status,
        next: t.pendingHandoff?.next || t.nextAction || null,
        scope: t.scope,
        openFindings: t.findings.filter((f) => f.status === "open").length,
        ...noteOf(t),
      })),
    incoming: all
      .filter(({ t }) => t.pendingHandoff?.to === actor)
      .map(({ t }) => ({
        id: t.id,
        title: t.title,
        from: t.pendingHandoff.from,
        next: t.pendingHandoff.next,
        ...(t.ref ? { ref: t.ref } : {}),
      })),
    outgoing: mine
      .filter(({ t }) => t.pendingHandoff)
      .map(({ t }) => ({ id: t.id, title: t.title, to: t.pendingHandoff.to })),
    doNotEdit: others.slice(0, doNotEditLimit).map(({ t }) => ({
        task: t.id,
        owner: t.owner,
        scope: t.scope,
        ...noteOf(t),
      })),
    doNotEditTotal: others.length,
    decisions: {
      accepted: decisions
        .filter((d) => d.status === "accepted" && fresh(d.acceptedAt))
        .map((d) => ({ id: d.id, summary: d.summary, by: d.acceptedBy })),
      proposed: decisions
        .filter((d) => d.status === "proposed")
        .map((d) => ({
          id: d.id,
          summary: d.summary,
          by: d.proposedBy,
          ...(d.supersedes ? { supersedes: d.supersedes } : {}),
        })),
    },
    changes: involved
      .flatMap(({ t }) =>
        t.history
          .map((e) => ({ ...e, actor: e.actor ?? e.from ?? null }))
          .filter((e) => e.actor !== actor && fresh(e.at))
          .map((e) => ({ task: t.id, event: e.event, actor: e.actor, at: e.at })),
      )
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-50),
  };
  if (since === "last") s.atomic(cursorFile(cwd, actor), { actor, at });
  return result;
}
export function inboxText(r) {
  const lines = [`Inbox for ${r.actor}${r.since ? ` (changes since ${r.since})` : ""}`];
  const section = (title, items, fmt) => {
    if (items.length) lines.push(`\n${title}`, ...items.map((x) => `- ${fmt(x)}`));
  };
  section("Handoffs waiting for you", r.incoming, (x) => `${x.title} from ${x.from}: ${x.next} (${x.ref ? `${x.ref}, ` : ""}${x.id})`);
  section("Your tasks", r.owned, (x) => `[${x.status}] ${x.title}${x.openFindings ? `, ${x.openFindings} open findings` : ""}${x.note ? ` — note: ${x.note}` : ""}${x.next ? ` — next: ${x.next}` : ""} (${x.ref ? `${x.ref}, ` : ""}${x.id})`);
  section("Offered by you, not yet received", r.outgoing, (x) => `${x.title} → ${x.to}`);
  section(`Do not edit (owned by others${r.doNotEditTotal > r.doNotEdit.length ? `; ${r.doNotEdit.length} most recent of ${r.doNotEditTotal}, check covers all` : ""})`, r.doNotEdit, (x) => `${x.scope.join(", ")} — ${x.owner}${x.note ? ` (${x.note})` : ""}`);
  section("Project decisions", r.decisions.accepted, (x) => `${x.summary} (accepted by ${x.by})`);
  section("Proposed decisions awaiting acceptance", r.decisions.proposed, (x) => `${x.summary} (proposed by ${x.by})`);
  section("Changes by others", r.changes, (x) => `${x.at} ${x.actor || "provider"} ${x.event} on ${x.task}`);
  if (lines.length === 1) lines.push("Nothing for you.");
  return lines.join("\n");
}
