import fs from "node:fs";
import path from "node:path";
import * as s from "./store.js";
import { snapshot, git } from "./git.js";
import { scopesOverlap } from "./scope.js";
import { releasedByMerge } from "./merged.js";

const sameOwnerParty = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
export const dirname = ".agentbridge";
export const { root, task, tasks, saveTask } = s;
export const requirementsDigest = (t) =>
  s.digest({
    criteria: t.criteria,
    decisions: t.decisions.filter((d) => d.status === "accepted"),
  });
export const repoKey = (top) => s.digest(top).slice(0, 8);
function createRecords(dir) {
  fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
  s.atomic(path.join(dir, "project.json"), { schema: 2, createdAt: s.now() });
  fs.writeFileSync(path.join(dir, ".gitignore"), "local/\nevidence/\n*.tmp\n");
  fs.writeFileSync(path.join(dir, ".gitattributes"), "*.json merge=agentbridge\n");
}
export function init(cwd, { recordsDir = "" } = {}) {
  if (!recordsDir) {
    if (fs.existsSync(root(cwd))) throw Error(".agentbridge already exists");
    createRecords(root(cwd));
    return root(cwd);
  }
  if (!path.isAbsolute(recordsDir))
    throw Error("--records-dir must be an absolute path");
  const common = s.gitCommonDir(cwd);
  if (!common) throw Error("Shared records require a Git repository");
  if (fs.existsSync(path.join(cwd, ".agentbridge")))
    throw Error("This checkout already has .agentbridge records");
  const pointer = path.join(common, s.pointerName);
  if (fs.existsSync(pointer))
    throw Error(`Already linked to ${s.read(pointer).recordsDir}`);
  if (fs.existsSync(path.join(recordsDir, "project.json"))) s.ensureAt(recordsDir);
  else createRecords(recordsDir);
  s.atomic(pointer, { recordsDir, linkedAt: s.now() });
  s.forgetRoot(cwd);
  return { recordsDir, pointer, mode: "shared" };
}
export function where(cwd) {
  const { dir, mode } = s.locate(cwd);
  return {
    recordsDir: dir,
    mode,
    initialized: fs.existsSync(path.join(dir, "project.json")),
    shared:
      mode === "repository"
        ? "Committed with the repository; share through Git"
        : "Shared by every worktree on this machine; not in Git history",
  };
}
export function migrate(cwd) {
  const config = s.read(path.join(root(cwd), "project.json"));
  if (config.schema === 2) return { migrated: false };
  if (config.schema !== 1) throw Error("Unknown schema");
  const release = s.lock(cwd);
  try {
    const dir = path.join(root(cwd), "tasks");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const load = (kind, id) => {
      const p = s.file(cwd, kind, id);
      return fs.existsSync(p)
        ? s.read(p)
        : {
            id,
            source: "unavailable",
            result: "unknown",
            summary: "Legacy private artifact unavailable",
          };
    };
    for (const name of files) {
      const p = path.join(dir, name),
        t = s.read(p);
      if (t.schema === 2) continue;
      s.atomic(path.join(root(cwd), "local", "legacy-backup", name), t);
      Object.assign(t, {
        schema: 2,
        version: 0,
        owner: null,
        scope: [],
        pendingHandoff: null,
        activeRun: null,
        baseRevision: null,
        implementations: [],
        runs: [],
        testPlan: [],
        acceptance: null,
        verification: null,
        attempts: 0,
      });
      t.decisions = t.decisions.map((id) => load("decisions", id));
      t.evidence = t.evidence.map((id) => load("evidence", id));
      t.criteria = criteria(
        t.criteria || "Define acceptance criteria before execution",
      );
      t.reviews = [];
      s.event(t, "migrated", {
        note: "Legacy reviews remain in private backup; they cannot satisfy verification",
      });
      s.atomic(p, t);
    }
    fs.writeFileSync(
      path.join(root(cwd), ".gitignore"),
      "local/\nevidence/\n*.tmp\n",
    );
    s.atomic(path.join(root(cwd), "project.json"), { ...config, schema: 2 });
    return { migrated: true, tasks: files.length };
  } finally {
    release();
  }
}
function criteria(text) {
  const items = String(text)
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!items.length) throw Error("Acceptance criteria required");
  return items.map((text, i) => ({ id: `c${i + 1}`, text }));
}
export function normalizeScope(scope = []) {
  if (!Array.isArray(scope))
    throw Error("Invalid scope: expected an array of path strings");
  const out = [];
  for (const raw of scope) {
    if (typeof raw !== "string")
      throw Error(
        `Invalid scope entry of type ${raw === null ? "null" : typeof raw}: expected a string`,
      );
    const label = JSON.stringify(raw);
    let p = raw.trim();
    if (!p) throw Error(`Invalid scope entry ${label}: empty path`);
    if (p.includes("\\"))
      throw Error(`Invalid scope entry ${label}: use POSIX "/" separators`);
    if (p.startsWith("/") || /^[A-Za-z]:/.test(p))
      throw Error(`Invalid scope entry ${label}: must be repository-relative`);
    while (p.startsWith("./")) p = p.slice(2);
    while (p.endsWith("/")) p = p.slice(0, -1);
    if (!p || p === ".")
      throw Error(`Invalid scope entry ${label}: must name a path inside the repository`);
    const parts = p.split("/");
    if (parts.includes(".."))
      throw Error(`Invalid scope entry ${label}: ".." segments are not allowed`);
    if (parts.some((x) => x === "" || x === "."))
      throw Error(`Invalid scope entry ${label}: empty or "." segments are not allowed`);
    if (p === "*" || p.slice(0, -1).includes("*"))
      throw Error(`Invalid scope entry ${label}: "*" is only allowed as the final character of a path prefix`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
export function normalizeRef(ref) {
  if (!ref) return null;
  ref = String(ref).trim();
  if (!ref || ref.length > 300 || /\s/.test(ref))
    throw Error("--ref must be one issue key or URL without spaces, at most 300 characters");
  return ref;
}
export function addTask(cwd, title, criteriaText = "", actor = "", scope = [], ref = "", { exclusive = false } = {}) {
  s.ensure(cwd);
  if (!title?.trim()) throw Error("Task title required");
  scope = normalizeScope(scope);
  ref = normalizeRef(ref);
  const t = {
    schema: 2,
    version: 0,
    id: s.uid("task"),
    title,
    criteria: criteria(criteriaText),
    owner: actor || null,
    scope,
    ...(ref ? { ref } : {}),
    status: "planned",
    createdAt: s.now(),
    updatedAt: s.now(),
    baseRevision: null,
    decisions: [],
    evidence: [],
    findings: [],
    reviews: [],
    implementations: [],
    runs: [],
    history: [],
    testPlan: [],
    activeRun: null,
    pendingHandoff: null,
    verification: null,
    acceptance: null,
    attempts: 0,
  };
  s.event(t, "created", { actor });
  const release = s.lock(cwd);
  try {
    if (exclusive && scope.length && actor) refuseClashes(cwd, t.id, actor, scope);
    s.atomic(s.file(cwd, "tasks", t.id), t);
  } finally {
    release();
  }
  return t;
}
export function claim(cwd, id, actor) {
  if (!actor?.trim()) throw Error("Actor required");
  return s.mutate(cwd, id, (t) => {
    s.idle(t);
    if (t.owner && t.owner !== actor)
      throw Error("Owner must offer a handoff first");
    t.owner = actor;
    s.event(t, "claimed", { actor });
  });
}
export function offer(cwd, id, actor, to, next, { principal = null } = {}) {
  if (!to?.trim() || !next?.trim())
    throw Error("Recipient and next action required");
  return s.mutate(cwd, id, (t) => {
    s.idle(t);
    if (!controls(t, actor, principal)) s.owner(t, actor);
    if (to === actor || to === t.owner)
      throw Error("Handoff recipient must be a different person");
    t.pendingHandoff = { from: actor, to, next, at: s.now() };
    s.event(t, "handoff_offered", { actor, ...t.pendingHandoff, ...(actor !== t.owner ? { for: t.owner } : {}) });
  });
}
export function receive(cwd, id, actor) {
  return s.mutate(cwd, id, (t) => {
    s.idle(t);
    if (t.pendingHandoff?.to !== actor)
      throw Error("No handoff addressed to this actor");
    const h = t.pendingHandoff;
    t.owner = actor;
    t.nextAction = h.next;
    t.pendingHandoff = null;
    s.event(t, "handoff_received", { actor, from: h.from, next: h.next });
  });
}
export const closedStatuses = ["done", "done-unchecked", "merged", "cancelled"];
export const idleHours = 24;
export const ownershipModes = ["warn", "block"];
export function ownershipMode(cwd) {
  try {
    const m = s.read(path.join(s.root(cwd), "project.json")).ownership;
    return ownershipModes.includes(m) ? m : "warn";
  } catch {
    return "warn";
  }
}
function stillHolding(cwd, list) {
  const fresh = list.filter((o) => Date.parse(o.updatedAt) >= Date.now() - idleHours * 36e5);
  const gone = releasedByMerge(cwd, fresh);
  return fresh.filter((o) => !gone.has(o.id));
}
const heartbeatMs = (idleHours / 4) * 36e5;
const sharedFile = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|go\.(mod|sum)|Cargo\.(toml|lock)|pyproject\.toml|poetry\.lock|uv\.lock|requirements[^/]*\.txt|Gemfile(\.lock)?|composer\.(json|lock)|CHANGELOG[^/]*|\.gitignore)$/i;
export function noteActivity(cwd, actor, unclaimed, ownTasks) {
  unclaimed = unclaimed.filter((p) => !sharedFile.test(p));
  const open = tasks(cwd).filter((t) => t.owner === actor && t.status === "in_progress");
  const target = unclaimed.length ? (open.length === 1 ? open[0] : null) : open.find((t) => ownTasks.includes(t.id));
  if (!target) return null;
  const add = unclaimed.filter((p) => !target.scope.some((e) => scopesOverlap(e, p)));
  if (!add.length && Date.now() - Date.parse(target.updatedAt) < heartbeatMs) return null;
  return s.mutate(cwd, target.id, (t) => {
    if (add.length) {
      refuseClashes(cwd, t.id, actor, add);
      s.event(t, "scope_inferred", { actor, added: add });
      t.scope = [...t.scope, ...add];
    } else s.event(t, "active", { actor });
    return { task: t.id, title: t.title, added: add };
  });
}
export function release(cwd, id, actor, reason) {
  if (!reason?.trim()) throw Error("Say why: --reason \"...\"");
  if (reason.length > 200) throw Error("Reason must be at most 200 characters");
  return s.mutate(cwd, id, (t) => {
    s.idle(t);
    if (closedStatuses.includes(t.status)) throw Error(`Task is already ${t.status}; its files are free`);
    if (!t.scope.length) throw Error("This task holds no files");
    const scope = t.scope;
    t.scope = [];
    s.event(t, "released", { actor, reason: reason.trim(), scope, ...(actor !== t.owner ? { for: t.owner } : {}) });
  });
}
const controls = (t, actor, onBehalf) => actor && (actor === t.owner || (onBehalf && t.owner && actor === onBehalf));

export function withdraw(cwd, id, actor, { principal = null } = {}) {
  return s.mutate(cwd, id, (t) => {
    const h = t.pendingHandoff;
    if (!h) throw Error("This task has no pending offer");
    if (!(actor === h.from || controls(t, actor, principal)))
      throw Error(`Only ${h.from} (who made the offer) or the task owner can withdraw it`);
    t.pendingHandoff = null;
    s.event(t, "handoff_withdrawn", { actor, from: h.from, to: h.to, ...(actor !== t.owner ? { for: t.owner } : {}) });
  });
}
export function decline(cwd, id, actor, reason = "") {
  return s.mutate(cwd, id, (t) => {
    const h = t.pendingHandoff;
    if (h?.to !== actor) throw Error("No handoff addressed to this actor");
    t.pendingHandoff = null;
    s.event(t, "handoff_declined", { actor, from: h.from, ...(reason.trim() ? { reason: reason.trim() } : {}) });
  });
}
export function cancel(cwd, id, actor, reason, { principal = null } = {}) {
  if (!reason?.trim()) throw Error("Say why: --reason \"...\"");
  if (reason.length > 200) throw Error("Reason must be at most 200 characters");
  return s.mutate(cwd, id, (t) => {
    s.idle(t);
    if (!controls(t, actor, principal)) throw Error(`Only the owner (${t.owner || "nobody"}) can cancel this task`);
    if (closedStatuses.includes(t.status)) throw Error(`Task is already ${t.status}`);
    const from = t.status;
    t.status = "cancelled";
    t.acceptance = null;
    const h = t.pendingHandoff;
    t.pendingHandoff = null;
    s.event(t, "cancelled", { actor, from, reason: reason.trim(), ...(h ? { withdrew: h.to } : {}), ...(actor !== t.owner ? { for: t.owner } : {}) });
  });
}
export function closeMerged(cwd, id, actor, pr, { principal = null } = {}) {
  if (!Number.isInteger(pr?.number) || !pr.mergedAt) throw Error("A merged pull request is required");
  return s.mutate(cwd, id, (t) => {
    s.idle(t);
    if (!controls(t, actor, principal)) throw Error(`Only the owner (${t.owner || "nobody"}) can close this task`);
    if (closedStatuses.includes(t.status)) throw Error(`Task is already ${t.status}`);
    const from = t.status;
    t.status = "merged";
    const h = t.pendingHandoff;
    t.pendingHandoff = null;
    s.event(t, "closed_merged", {
      actor,
      from,
      pr: { number: pr.number, mergedAt: pr.mergedAt, ...(pr.headRefName ? { branch: pr.headRefName } : {}), ...(pr.url ? { url: pr.url } : {}) },
      ...(h ? { withdrew: h.to } : {}),
      ...(actor !== t.owner ? { for: t.owner } : {}),
    });
  });
}
export function reassign(cwd, id, actor, to, reason) {
  if (!to?.trim()) throw Error("--to required");
  if (!reason?.trim()) throw Error("Say why: --reason \"...\"");
  if (reason.length > 200) throw Error("Reason must be at most 200 characters");
  return s.mutate(cwd, id, (t) => {
    s.idle(t);
    if (closedStatuses.includes(t.status)) throw Error(`Task is ${t.status}; reopen it first`);
    if (t.owner === to) throw Error(`${to} already owns this task`);
    const from = t.owner;
    t.owner = to;
    const h = t.pendingHandoff;
    t.pendingHandoff = null;
    s.event(t, "reassigned", { actor, from, to, reason: reason.trim(), ...(h ? { withdrew: h.to } : {}) });
  });
}
function refuseClashes(cwd, id, actor, scope) {
  if (!fs.existsSync(path.join(s.root(cwd), "tasks"))) return;
  let clashes = tasks(cwd)
    .filter((o) => o.id !== id && o.owner && o.owner !== actor)
    .filter((o) => o.scope.some((a) => scope.some((b) => scopesOverlap(a, b))))
    .filter((o) => !closedStatuses.includes(effectiveStatus(cwd, o)));
  clashes = stillHolding(cwd, clashes);
  if (clashes.length)
    throw Error(
      `Someone else is already working on these files: ${clashes.map((o) => `"${o.title}" (${o.owner}, ${o.id.slice(5, 13)}, ${o.scope.join(", ")})`).join("; ")}. Claim other files, or ask the user to have it handed over`,
    );
}
export function setScope(cwd, id, actor, scope) {
  scope = normalizeScope(scope);
  if (!scope.length) throw Error("Scope must list at least one path");
  return s.mutate(cwd, id, (t) => {
    s.owner(t, actor);
    refuseClashes(cwd, id, actor, scope);
    s.event(t, "scope_changed", { actor, from: t.scope, to: scope });
    t.scope = scope;
  });
}
export const noteLimit = 200;
export function note(cwd, id, actor, text) {
  if (!text?.trim()) throw Error("Note text required");
  if (text.length > noteLimit)
    throw Error(`Note must be at most ${noteLimit} characters`);
  return s.mutate(cwd, id, (t) => {
    s.owner(t, actor);
    t.note = { text: text.trim(), by: actor, at: s.now() };
    s.event(t, "noted", { actor, text: t.note.text });
  });
}
export function addDecision(cwd, id, summary, rationale, actor = "") {
  if (!summary?.trim() || !rationale?.trim())
    throw Error("Summary and rationale required");
  return s.mutate(cwd, id, (t) => {
    s.idle(t);
    const d = {
      id: s.uid("decision"),
      taskId: id,
      summary,
      rationale,
      proposedBy: actor || null,
      status: "proposed",
      at: s.now(),
    };
    t.decisions.push(d);
    s.event(t, "decision_proposed", { ref: d.id, actor: actor || null });
    return d;
  });
}
const projectDecisionDir = (cwd) => path.join(root(cwd), "project-decisions");
export function projectDecisions(cwd) {
  s.ensure(cwd);
  const dir = projectDecisionDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => s.read(path.join(dir, f)))
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
export function proposeProjectDecision(
  cwd,
  summary,
  rationale,
  actor,
  supersedes = "",
) {
  s.ensure(cwd);
  if (!summary?.trim() || !rationale?.trim())
    throw Error("Summary and rationale required");
  if (!actor?.trim()) throw Error("Actor required");
  const release = s.lock(cwd);
  try {
    if (supersedes) {
      const p = s.file(cwd, "project-decisions", supersedes);
      if (!fs.existsSync(p) || s.read(p).status !== "accepted")
        throw Error("Can only supersede an accepted project decision");
    }
    const d = {
      id: s.uid("decision"),
      scope: "project",
      version: 0,
      summary,
      rationale,
      proposedBy: actor,
      supersedes: supersedes || null,
      status: "proposed",
      at: s.now(),
      history: [],
    };
    s.event(d, "decision_proposed", { actor, supersedes: d.supersedes });
    s.atomic(s.file(cwd, "project-decisions", d.id), d);
    return d;
  } finally {
    release();
  }
}
export function resolveMerge(cwd, id, field, side, actor) {
  if (!actor?.trim()) throw Error("Actor required");
  if (!["ours", "theirs"].includes(side)) throw Error("Choose ours or theirs");
  const kind = id.startsWith("task-") ? "tasks" : "project-decisions";
  const release = s.lock(cwd);
  try {
    const p = s.file(cwd, kind, id);
    if (!fs.existsSync(p)) throw Error(`No record ${id}`);
    const r = s.read(p);
    const i = (r.mergeConflicts || []).findIndex((c) => c.field === field);
    if (i < 0) throw Error(`No merge conflict on ${field} in ${id}`);
    const c = r.mergeConflicts[i], value = c[side];
    const item = /^(\w+)\[(.+)\]$/.exec(field);
    if (item) {
      const list = r[item[1]] || [];
      const at = list.findIndex((x) => x.id === item[2]);
      if (value === null) list.splice(at, 1);
      else if (at < 0) list.push(value);
      else list[at] = value;
      r[item[1]] = list;
    } else if (value === null) delete r[field];
    else r[field] = value;
    r.mergeConflicts.splice(i, 1);
    if (!r.mergeConflicts.length) delete r.mergeConflicts;
    r.version++;
    s.event(r, "merge_resolved", { actor, field, kept: side });
    s.atomic(p, r);
    return r;
  } finally {
    release();
  }
}
function acceptProjectDecision(cwd, id, actor) {
  if (!actor?.trim()) throw Error("Actor required");
  const release = s.lock(cwd);
  try {
    const p = s.file(cwd, "project-decisions", id),
      d = s.read(p);
    s.unmerged(d);
    if (d.status !== "proposed") throw Error("Decision already finalized");
    let old;
    if (d.supersedes) {
      old = s.read(s.file(cwd, "project-decisions", d.supersedes));
      if (old.status !== "accepted")
        throw Error(
          `Superseded decision is ${old.status}; propose against the current decision`,
        );
    }
    const at = s.now();
    Object.assign(d, { status: "accepted", acceptedBy: actor, acceptedAt: at });
    d.version++;
    s.event(d, "decision_accepted", { actor });
    if (old) {
      Object.assign(old, {
        status: "superseded",
        supersededBy: d.id,
        supersededAt: at,
      });
      old.version++;
      s.event(old, "decision_superseded", { actor, by: d.id });
      s.atomic(s.file(cwd, "project-decisions", old.id), old);
    }
    s.atomic(p, d);
    return d;
  } finally {
    release();
  }
}
export function acceptDecision(cwd, id, actor) {
  s.ensure(cwd);
  if (fs.existsSync(s.file(cwd, "project-decisions", id)))
    return acceptProjectDecision(cwd, id, actor);
  const t = tasks(cwd).find((t) => t.decisions.some((d) => d.id === id));
  if (!t) throw Error("Decision not found");
  return s.mutate(cwd, t.id, (t) => {
    s.idle(t);
    s.owner(t, actor);
    const d = t.decisions.find((d) => d.id === id);
    if (d.status !== "proposed") throw Error("Decision already finalized");
    Object.assign(d, {
      status: "accepted",
      acceptedBy: actor,
      acceptedAt: s.now(),
    });
    s.event(t, "decision_accepted", { ref: id, actor });
    return d;
  });
}
export function recordEvidence(
  cwd,
  id,
  command,
  result,
  revision = null,
  notes = "",
) {
  if (!command || !["pass", "fail", "skipped"].includes(result))
    throw Error("Evidence command and pass|fail|skipped required");
  return s.mutate(cwd, id, (t) => {
    s.idle(t);
    const e = {
      id: s.uid("evidence"),
      command,
      result,
      revision,
      notes,
      at: s.now(),
      source: "manual-attestation",
    };
    t.evidence.push(e);
    s.event(t, "evidence_recorded", { ref: e.id });
    return e;
  });
}
export function reportFinding(cwd, id, description, author) {
  if (!description?.trim()) throw Error("Finding required");
  return s.mutate(cwd, id, (t) => {
    const f = {
      id: s.uid("finding"),
      description,
      author: author || "unknown",
      status: "open",
      at: s.now(),
    };
    t.findings.push(f);
    t.status = "needs_work";
    t.acceptance = null;
    s.event(t, "finding_opened", { ref: f.id, actor: author || null, description });
    return f;
  });
}
export function resolveFinding(cwd, id, findingId, actor, resolution) {
  if (!resolution?.trim()) throw Error("Resolution rationale required");
  return s.mutate(cwd, id, (t) => {
    s.idle(t);
    s.owner(t, actor);
    const f = t.findings.find((f) => f.id === findingId);
    if (!f || f.status !== "open") throw Error("Open finding not found");
    Object.assign(f, {
      status: "resolved",
      resolution,
      resolvedBy: actor,
      resolvedAt: s.now(),
    });
    t.verification = null;
    t.acceptance = null;
    t.status = "implemented";
    s.event(t, "finding_resolved", { ref: f.id, actor, resolution });
  });
}
const noWorkspace = "Create or attach a task workspace first";
export function workspace(cwd, id) {
  task(cwd, id);
  const p = s.file(cwd, "local", id);
  if (!fs.existsSync(p)) throw Error(noWorkspace);
  return s.read(p).workspace;
}
export function createWorkspace(cwd, id, actor) {
  return s.mutate(cwd, id, (t) => {
    s.idle(t);
    s.owner(t, actor);
    const local = s.file(cwd, "local", id);
    if (fs.existsSync(local)) throw Error("Workspace already attached");
    const base = t.baseRevision || snapshot(cwd).revision;
    const dest = path.join(root(cwd), "local", "worktrees", id);
    git(cwd, ["worktree", "add", "-b", `agentbridge/${id}`, dest, base]);
    s.atomic(local, { workspace: dest });
    t.baseRevision ??= base;
    s.event(t, "workspace_created", { actor, baseRevision: base });
    return { workspace: dest, baseRevision: base };
  });
}
export function attachWorkspace(cwd, id, actor, directory) {
  const dest = fs.realpathSync(directory);
  const snap = snapshot(dest);
  return s.mutate(cwd, id, (t) => {
    s.idle(t);
    s.owner(t, actor);
    if (t.baseRevision)
      git(dest, ["merge-base", "--is-ancestor", t.baseRevision, snap.revision]);
    t.baseRevision ??= snap.revision;
    s.atomic(s.file(cwd, "local", id), { workspace: dest });
    s.event(t, "workspace_attached", { actor, revision: snap.revision });
    return { workspace: dest };
  });
}
export function configureTest(
  cwd,
  id,
  actor,
  name,
  argv,
  covers,
  timeoutMs = 120000,
) {
  if (
    !name?.trim() ||
    !Array.isArray(argv) ||
    !argv.length ||
    argv.some((a) => typeof a !== "string") ||
    !argv[0]
  )
    throw Error("Test requires a name and nonempty argv array");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    throw Error("Timeout must be 1..600000 ms");
  return s.mutate(cwd, id, (t) => {
    s.idle(t);
    s.owner(t, actor);
    if (
      !Array.isArray(covers) ||
      !covers.length ||
      covers.some((c) => !t.criteria.some((x) => x.id === c))
    )
      throw Error("Map test to valid criterion IDs");
    const spec = { name, argv, covers, timeoutMs };
    t.testPlan = t.testPlan.filter((x) => x.name !== name).concat(spec);
    t.verification = null;
    t.acceptance = null;
    if (["done", "verified"].includes(t.status)) t.status = "implemented";
    s.event(t, "test_configured", { actor, spec });
  });
}
export function verification(cwd, id) {
  const t = task(cwd, id),
    reasons = [];
  let current,
    workspaceMissing = false;
  try {
    current = snapshot(workspace(cwd, id));
  } catch (e) {
    workspaceMissing = e.message === noWorkspace;
    reasons.push(e.message);
  }
  if (t.activeRun) reasons.push("Execution is active or requires recovery");
  if (t.findings.some((f) => f.status === "open"))
    reasons.push("Open findings block verification");
  if (!t.evidence.length) reasons.push("No evidence recorded");
  const latest = t.runs.filter((r) => r.kind === "test").at(-1);
  if (!latest)
    reasons.push(
      "Manual attestations cannot automatically verify task; run configured tests",
    );
  else {
    if (latest.state !== "succeeded")
      reasons.push("Latest test batch did not pass");
    if (latest.planDigest !== s.digest(t.testPlan))
      reasons.push("Test plan changed");
    if (current && latest.snapshot?.codeDigest !== current.codeDigest)
      reasons.push("Test evidence is stale");
    const covered = new Set(t.testPlan.flatMap((x) => x.covers));
    if (t.criteria.some((c) => !covered.has(c.id)))
      reasons.push("Acceptance criteria lack configured checks");
  }
  const review = t.reviews.at(-1),
    implementation = t.implementations.at(-1);
  if (!implementation)
    reasons.push("No successful implementation run recorded");
  if (!review || review.outcome !== "pass")
    reasons.push("Passing separate review required");
  if (review && review.requirementsDigest !== requirementsDigest(t))
    reasons.push("Accepted decisions or criteria changed since review");
  if (review && implementation && review.provider === implementation.provider)
    reasons.push("Reviewer must use a different provider");
  if (review && current && review.snapshot.codeDigest !== current.codeDigest)
    reasons.push("Review evidence is stale");
  const lastAgentRun = t.runs
    .filter((r) => r.kind === "implement" || r.kind === "review")
    .at(-1);
  if (lastAgentRun && lastAgentRun.state !== "succeeded")
    reasons.push("Latest agent run failed or was interrupted");
  if (implementation && review && review.implementationId !== implementation.id)
    reasons.push("Review predates latest implementation");
  return {
    version: t.version,
    eligible: reasons.length === 0,
    checkedHere: !workspaceMissing,
    reasons,
    current: current || null,
    testRun: latest?.id || null,
    review: review?.id || null,
  };
}
export function setStatus(cwd, id, status, actor = "") {
  if (status === "verified" || status === "done") {
    const v = verification(cwd, id);
    if (!v.eligible) throw Error(v.reasons.join("; "));
    return s.mutate(cwd, id, (t) => {
      s.idle(t);
      s.owner(t, actor);
      if (t.version !== v.version)
        throw Error("Task changed during verification; retry");
      const current = snapshot(workspace(cwd, id));
      if (
        current.revision !== v.current.revision ||
        current.codeDigest !== v.current.codeDigest
      )
        throw Error("Code changed during verification; retry");
      if (status === "done" && t.status !== "verified")
        throw Error("Verify before human acceptance");
      if (status === "done") {
        t.acceptance = { actor, at: s.now(), snapshot: v.current };
      } else {
        t.verification = { at: s.now(), ...v };
      }
      t.status = status;
      s.event(t, status === "done" ? "human_accepted" : "verified", {
        actor,
        snapshot: v.current,
        testRun: v.testRun,
        review: v.review,
      });
    });
  }
  const edges = {
    planned: ["in_progress"],
    in_progress: ["implemented", "needs_work"],
    implemented: ["ready_for_review", "needs_work", "in_progress"],
    ready_for_review: ["needs_work", "in_progress"],
    needs_work: ["in_progress"],
    verified: ["needs_work", "in_progress"],
    done: ["needs_work", "in_progress"],
    cancelled: ["in_progress"],
    merged: ["in_progress"],
  };
  return s.mutate(cwd, id, (t) => {
    s.idle(t);
    s.owner(t, actor);
    if (!edges[t.status]?.includes(status))
      throw Error(`Invalid transition ${t.status} → ${status}`);
    if (status === "in_progress" && t.scope.length) {
      const earlier = tasks(cwd).filter((o) => o.id !== id && o.owner && t.owner && !sameOwnerParty(o.owner, t.owner) && o.createdAt < t.createdAt
        && !closedStatuses.includes(effectiveStatus(cwd, o)) && o.scope.some((a) => t.scope.some((b) => scopesOverlap(a, b))));
      const first = stillHolding(cwd, earlier)[0];
      if (first) throw Error(`${first.owner} claimed these files first ("${first.title}", ${first.id.slice(5, 13)}); this task cannot start while that one is open. Ask the user: close one as a duplicate, or hand it over`);
    }
    const from = t.status;
    t.status = status;
    t.acceptance = null;
    s.event(t, "status_changed", { from, to: status, actor });
  });
}
export function effectiveStatus(cwd, t) {
  return ["done", "verified"].includes(t.status) ? status(cwd, t.id).effectiveStatus : t.status;
}
export function status(cwd, id) {
  const t = task(cwd, id),
    v = verification(cwd, id);
  let effectiveStatus = t.status;
  if (["done", "verified"].includes(t.status) && !v.eligible)
    effectiveStatus =
      !v.checkedHere && v.reasons.length === 1
        ? `${t.status}-unchecked`
        : "stale";
  return { ...t, effectiveStatus, verificationCheck: v };
}
const statusLine = (t) =>
  t.effectiveStatus.endsWith("-unchecked")
    ? `${t.status} — recorded receipts qualify, but current code was not checked in this checkout (attach the implementation revision to recheck)`
    : `${t.effectiveStatus} (recorded: ${t.status})`;
const projectDecisionLines = (cwd) => {
  const all = projectDecisions(cwd);
  const accepted = all.filter((d) => d.status === "accepted");
  const proposed = all.filter((d) => d.status === "proposed");
  return [
    ...accepted.map(
      (d) =>
        `- [accepted by ${d.acceptedBy}] ${d.summary}: ${d.rationale} (${d.id})`,
    ),
    ...proposed.map(
      (d) =>
        `- [proposed by ${d.proposedBy}, not yet accepted${d.supersedes ? `; would supersede ${d.supersedes}` : ""}] ${d.summary}: ${d.rationale} (${d.id})`,
    ),
  ];
};
export function handoff(cwd, id) {
  const t = status(cwd, id);
  const project = projectDecisionLines(cwd);
  return `# AgentBridge task ${t.id}\n\n## Goal\n${t.title}\n\n## Ownership\n${t.owner || "Unassigned"}${t.pendingHandoff ? ` → ${t.pendingHandoff.to} (awaiting acknowledgment)` : ""}\nNext: ${t.pendingHandoff?.next || t.nextAction || "Inspect unresolved work below"}\n\n## Acceptance criteria\n${t.criteria.map((c) => `- ${c.id}: ${c.text}`).join("\n")}\n\n## Status\n${statusLine(t)}\n\n## Project decisions (apply to all tasks)\n${project.join("\n") || "None"}\n\n## Task decisions\n${t.decisions.map((d) => `- [${d.status}${d.proposedBy ? `, proposed by ${d.proposedBy}` : ""}${d.acceptedBy ? `, accepted by ${d.acceptedBy}` : ""}] ${d.summary}: ${d.rationale}`).join("\n") || "None"}\n\n## Implementation\n${t.implementations.map((i) => `- ${i.actor} via ${i.provider}${i.source === "external-record" ? " (recorded after the fact; a claim)" : " (AgentBridge run; a claim)"} at ${i.at}`).join("\n") || "None"}\n\n## Open findings\n${
    t.findings
      .filter((f) => f.status === "open")
      .map((f) => `- ${f.id}: ${f.description} (${f.author})`)
      .join("\n") || "None recorded"
  }\n\n## Recorded evidence\n${t.evidence.map((e) => `- ${e.result}: ${e.command || e.argv?.join(" ")} [${e.source}] @ ${e.snapshot?.revision || e.revision || "unknown revision"}`).join("\n") || "None"}\n\n## Review\n${t.reviews.map((r) => `- ${r.provider} (${r.actor}): ${r.outcome} @ ${r.snapshot.revision}`).join("\n") || "None"}\n\n## Unresolved verification\n${t.verificationCheck.reasons.join("\n") || "Required checks satisfied; human acceptance is a separate action"}\n\nRaw logs are private and may be unavailable in this checkout. Shared receipts are local runner claims, not cryptographic attestations.\n`;
}
export function context(cwd, id) {
  const t = task(cwd, id);
  return {
    handoff: handoff(cwd, id),
    related: tasks(cwd)
      .map((x) => ({ ...x, status: effectiveStatus(cwd, x) }))
      .filter(
        (x) =>
          x.id !== id &&
          !closedStatuses.includes(x.status) &&
          x.scope.some((a) => t.scope.some((b) => scopesOverlap(a, b))),
      )
      .map((x) => ({
        id: x.id,
        title: x.title,
        owner: x.owner,
        status: x.status,
        scope: x.scope,
      })),
    warning:
      "Overlap uses declared path scopes only; no semantic conflict detection.",
  };
}
