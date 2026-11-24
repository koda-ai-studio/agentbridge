import * as c from "./core.js";
import * as team from "./team.js";
import * as identity from "./identity.js";
import { sameParty } from "./coordination.js";
import { scopesOverlap } from "./scope.js";

const short = (id) => id.slice(5, 13);
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || "");
const hoursSince = (t) => Math.floor((Date.now() - Date.parse(t.history?.at(-1)?.at || t.updatedAt)) / 36e5);
const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function reviewItems(cwd, me, { merged = team.mergedPullRequests, agents = ["claude", "codex"] } = {}) {
  const mine = (owner) => identity.ownedBy(cwd, me, owner);
  const principal = (t) => identity.principalOf(cwd, me, t.owner);
  const open = c
    .tasks(cwd)
    .map((t) => ({ t, status: c.effectiveStatus(cwd, t) }))
    .filter(({ status }) => !c.closedStatuses.includes(status))
    .sort((a, b) => a.t.createdAt.localeCompare(b.t.createdAt));
  const items = [];
  const handled = new Set();

  for (const { t } of open)
    if (t.pendingHandoff?.to === me)
      items.push({
        text: `${t.pendingHandoff.from} offers you "${t.title}": ${t.pendingHandoff.next}`,
        choices: {
          y: ["accept it", () => c.receive(cwd, t.id, me) && "accepted; it is yours"],
          d: ["decline it", () => c.decline(cwd, t.id, me, "Declined in review") && `declined; ${t.pendingHandoff.from} keeps it`],
        },
      });

  for (const d of c.projectDecisions(cwd).filter((d) => d.status === "proposed"))
    items.push({
      text: `${d.proposedBy} proposes, for the whole project: "${d.summary}"${d.rationale ? ` (${clip(d.rationale, 120)})` : ""}`,
      choices: { y: ["accept it", (ctx) => c.acceptDecision(cwd, d.id, ctx.signed()) && "accepted"] },
    });

  for (const { t, status } of open)
    if (status.startsWith("verified") && mine(t.owner))
      items.push({
        text: `"${t.title}" (${t.owner}) passed its checks and waits for you`,
        choices: { y: ["accept it as done", (ctx) => c.setStatus(cwd, t.id, "done", ctx.signed()) && "done"] },
      });

  const dupes = new Map();
  for (const { t } of open) if (mine(t.owner) || mine(t.pendingHandoff?.from)) dupes.set(norm(t.title), [...(dupes.get(norm(t.title)) || []), t]);
  for (const ts of dupes.values()) {
    if (ts.length < 2) continue;
    const keep = ts.find((t) => t.owner === me) || ts[0];
    for (const t of ts.filter((x) => x !== keep)) {
      handled.add(t.id);
      items.push({
        text: `"${t.title}" exists twice: ${short(keep.id)} (${keep.owner}) and ${short(t.id)} (${t.owner})`,
        choices: { y: [`close ${short(t.id)} as the duplicate`, () => c.cancel(cwd, t.id, me, `Duplicate of ${short(keep.id)}`, { principal: principal(t) }) && "closed"] },
      });
    }
  }

  const found = team.mergedOpen(cwd, { merged }) || [];
  const done = found.filter((x) => mine(x.owner) && !handled.has(x.id));
  for (const x of done) handled.add(x.id);
  if (done.length)
    items.push({
      text: `${done.length} task${done.length > 1 ? "s" : ""} of yours ha${done.length > 1 ? "ve" : "s"} a merged pull request:\n${done.map((x) => `    ${x.title} (PR #${x.pr})${x.note ? `\n      last note: ${clip(x.note, 110)}` : ""}`).join("\n")}`,
      choices: {
        y: [`close ${done.length > 1 ? "all" : "it"}`, () => {
          let n = 0;
          for (const x of done) {
            try {
              team.closeMerged(cwd, x.id, me, { pr: x.pr, principal: identity.principalOf(cwd, me, x.owner) });
              n++;
            } catch {}
          }
          return `closed ${n}; their files are free`;
        }],
      },
    });

  for (const { t, status } of open) {
    if (handled.has(t.id) || status !== "in_progress" || !t.scope.length || !mine(t.owner) || t.owner === me) continue;
    const idle = hoursSince(t);
    if (idle < team.idleHours) continue;
    const agent = t.owner.split("/").pop();
    const other = agents.find((a) => a !== agent) || "claude";
    const to = identity.login(cwd) ? `${identity.login(cwd)}/${other}` : other;
    items.push({
      text: `"${t.title}" (${agent}) has had no activity for ${idle >= 48 ? `${Math.floor(idle / 24)} days` : `${idle}h`} and holds ${t.scope.length} file path${t.scope.length > 1 ? "s" : ""}${t.note ? `\n      last note: ${clip(t.note.text, 140)}` : ""}`,
      choices: {
        c: ["close it (finished or abandoned)", () => c.cancel(cwd, t.id, me, `Closed in review after ${idle}h without activity`, { principal: principal(t) }) && "closed; its files are free"],
        m: [`move it to ${other}`, () => c.reassign(cwd, t.id, me, to, `Moved in review after ${idle}h without activity`) && `moved to ${other}`],
      },
    });
  }

  for (const { t, status } of open) {
    if (handled.has(t.id) || !held.includes(status) || !t.owner || !mine(t.owner)) continue;
    const first = open.find(({ t: o, status: os }) => o !== t && held.includes(os) && o.owner && !sameParty(o.owner, t.owner) && o.createdAt < t.createdAt && t.scope.some((a) => o.scope.some((b) => scopesOverlap(a, b))));
    if (first)
      items.push({
        text: `"${t.title}" (${t.owner}) and "${first.t.title}" (${first.t.owner}, first) hold the same files, so neither can edit them`,
        choices: { y: [`close ${short(t.id)} as the duplicate`, () => c.cancel(cwd, t.id, me, `Overlaps ${short(first.t.id)}`, { principal: principal(t) }) && "closed"] },
      });
  }
  return items;
}

const held = ["planned", "in_progress", "needs_work", "implemented", "ready_for_review"];

export async function review(cwd, me, ask, ctx, opts) {
  const items = reviewItems(cwd, me, opts);
  const out = [];
  if (!items.length) return { asked: 0, acted: 0 };
  out.push(`${items.length} thing${items.length > 1 ? "s" : ""} need${items.length > 1 ? "" : "s"} you. Enter skips.`);
  ctx.print(out.join("\n"));
  let acted = 0;
  for (const [i, item] of items.entries()) {
    const keys = Object.keys(item.choices);
    const menu = keys.map((k) => `${k} = ${item.choices[k][0]}`).join(", ");
    const answer = (await ask(`\n${i + 1}. ${item.text}\n   ${menu}, Enter = skip: `)).trim().toLowerCase();
    const choice = item.choices[answer] || (answer === "yes" && item.choices.y);
    if (!choice) {
      ctx.print("   skipped");
      continue;
    }
    try {
      ctx.print(`   ${choice[1](ctx)}`);
      acted++;
    } catch (e) {
      ctx.print(`   not done: ${e.message}`);
    }
  }
  return { asked: items.length, acted };
}
