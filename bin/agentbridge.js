#!/usr/bin/env node
import * as c from "../lib/core.js";
import * as w from "../lib/workflow.js";
import { recoverLock, resolveTaskId, setProvenance, setSigner } from "../lib/store.js";
import * as signing from "../lib/signing.js";
import { doctor } from "../lib/providers.js";
import * as co from "../lib/coordination.js";
import * as agents from "../lib/agents.js";
import * as team from "../lib/team.js";
import * as identity from "../lib/identity.js";
import { onboard, onboardText } from "../lib/onboard.js";
import { mergeRecords } from "../lib/merge.js";
import { summarize } from "../lib/summary.js";
import * as sync from "../lib/sync.js";
import fs from "node:fs";
import readline from "node:readline";
import { review } from "../lib/review.js";
import { demo } from "../lib/demo.js";
import { stats, statsText } from "../lib/stats.js";
import { digest, digestText } from "../lib/digest.js";
const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const [command, ...args] = process.argv.slice(2),
  cwd = process.cwd();
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return "";
  const value = args[i + 1];
  if (!value || value.startsWith("--"))
    throw Error(`Value required for ${name}`);
  return value;
};
if (!["mcp", "hook", "merge-driver"].includes(command)) setProvenance(identity.provenance(cwd));
const actor = () => identity.guardSession(identity.resolveActor(cwd, flag("--actor") || identity.agentSession()?.agent || ""));
const other = (name) => identity.resolveActor(cwd, flag(name), { self: false });
const person = () => {
  const a = actor();
  identity.requirePerson(cwd, a);
  if (signing.signingKey(cwd)) {
    setSigner(signing.signer(cwd));
    if (!identity.githubId(cwd)) process.stderr.write("AgentBridge: signing without a GitHub id, so others cannot verify it. Run agentbridge onboard to add it.\n");
  }
  else if (signing.required(cwd))
    throw Error("This project requires signed approvals. Set git config gpg.format ssh and user.signingkey (a key registered on GitHub as a signing key).");
  else process.stderr.write("AgentBridge: approval recorded unsigned (no SSH signing key configured).\n");
  return a;
};
const bin = new URL(import.meta.url).pathname;
async function guided() {
  const a = actor();
  identity.requirePersonHere(cwd, a, "answers what needs them");
  const rl = readline.createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q) => {
    process.stdout.write(q);
    const r = await lines.next();
    if (!process.stdin.isTTY) process.stdout.write("\n");
    return r.done ? "" : r.value;
  };
  try {
    const r = await review(cwd, a, ask, { signed: person, print: (x) => console.log(x) });
    console.log(r.asked ? `\nHandled ${r.acted} of ${r.asked}. Run agentbridge again any time; agentbridge board shows everything.` : "Nothing needs you. agentbridge board shows who is doing what.");
  } finally {
    rl.close();
  }
}
const fresh = () => {
  const w = agents.freshened(cwd).warning;
  if (w) process.stderr.write(`AgentBridge: ${w}\n`);
};
const human = process.stdout.isTTY && !args.includes("--json");
const pr = (value) =>
  console.log(
    typeof value === "string" ? value : (human && summarize(value)) || JSON.stringify(value, null, 2),
  );
const help = `AgentBridge ${version} — shared work across people and agents
For people, two commands; your agents handle the rest:
  agentbridge onboard        set up this repository (once)
  agentbridge                asks about each thing that needs you (offers, decisions, finished work,
                             merged or duplicate tasks, stalled agents), one key per answer
When you want more:
  digest [--since 7d|DATE]   what happened since you last looked, and what waits on you
  board                      who is doing what
  assign "New work" --to codex|claude|TEAMMATE    give work to an agent or offer it to a teammate
  resume TASK                where a task stands and its next step
  done [TASK]                close tasks whose PR merged (--reason "why" to drop one)
  release TASK --reason "Why"   free the files of someone's stale claim
  policy ownership warn|block   warn (default) or refuse edits to files others are working on
  demo                       a Claude-to-Codex handoff in a throwaway repository
Agents use: inbox, check, task add|scope|status|note, handoff offer|receive (the skill teaches them).
Run agentbridge help all for every command, including review, test, verify and signed approvals.
In a terminal, records print as a short summary; add --json for the full record.`;
const helpAll = `AgentBridge ${version}: every command. Older forms still work and are marked.

Coordination (people and agents)
  inbox --actor NAME [--since ISO|last] [--format json|text]   (an agent's start-of-session view)
  check PATH... --actor NAME   (exit 1 when another owner's active scope covers a path)
  task add "Title" --criteria "Check one; Check two" --actor alice [--scope src,tests] [--ref ISSUE-KEY|URL] [--to bob]
  task scope ID src/a,src/b-* | task status ID STATUS | task note ID "Branch, PR, what is left"
  task list | task show ID | task claim ID
  handoff offer ID --to bob --next "Review and test" | handoff receive ID
  handoff decline ID [--reason "Why"] | handoff withdraw ID
  done [TASK] [--reason "Why"]  (closes merged tasks; with --reason, cancels)
  release ID --reason "Why"    (person only: free a stale claim's files; the owner sees why)
  digest | board | resume [TASK] | log [--since 7d] [--actor NAME] | stats
  decision propose "..." --why "..." [--supersedes ID] | decision accept ID | decision add ID "..." --why "..." | decision list
  finding add ID "..." --by NAME | finding resolve ID FINDING-ID --why "..."
  Older forms: task close ID [--pr N] and task cancel ID --reason (use done); task reassign and
    task add --to (use assign); context ID and handoff ID (use resume)

Setup and records
  onboard [--solo] [--dry-run] [--json] | init | where | migrate | doctor | setup | whoami | demo | --version
  sync [--init] [--remote origin] [--accept-rewrite] | resolve-merge ID FIELD ours|theirs
  policy ownership warn|block | policy signed-approvals required|optional
  hook pre-edit|prompt --actor NAME | hook install-git | hook pre-commit | mcp --actor NAME

Optional: verification and approvals (CI and PR reviews cover most teams)
  workspace create ID | workspace attach ID /abs/path
  implement ID --provider claude|codex | implement record ID --tool NAME --summary "..."
  review ID --provider claude|codex
  test configure ID NAME --argv '["node","--test"]' --criteria c1,c2 | test run ID
  evidence add ID "command" pass|fail|skipped | verify ID | accept ID
  approvals [--verify] | pr summary ID | pr publish ID --pr N
  recover ID | recover-lock write|execution
  Execution commands launch real processes and may use provider quota; run them only in trusted
  projects. AgentBridge never commits, pushes or merges your code.`;
try {
  for (const i of [0, 1]) if (args[i] && !args[i].startsWith("--") && args[i - 1]?.startsWith("--") !== true) args[i] = resolveTaskId(cwd, args[i]);
  switch (command) {
    case undefined:
    case "help":
    case "--help":
      if (command === undefined && process.stdin.isTTY && process.stdout.isTTY && !identity.agentSession() && c.where(cwd).initialized) {
        await guided();
        break;
      }
      pr(args[0] === "all" ? helpAll : help);
      break;
    case "todo":
      await guided();
      break;
    case "demo":
      demo({ keep: args.includes("--keep") });
      break;
    case "stats": {
      const r = stats(cwd, { since: flag("--since") });
      if (flag("--format") === "text" || (human && flag("--format") !== "json")) console.log(statsText(r));
      else console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "version":
    case "--version":
      pr(version);
      break;
    case "init":
      pr(c.init(cwd, { recordsDir: flag("--records-dir") }));
      break;
    case "where":
      pr({ ...c.where(cwd), ...(sync.isSynced(cwd) ? { syncBranch: sync.branch, sync: sync.status(cwd) } : {}) });
      break;
    case "sync": {
      const remote = flag("--remote") || "origin";
      let r;
      for (let i = 0; ; i++) {
        try {
          r = args.includes("--init") ? sync.setupSync(cwd, { remote }) : sync.sync(cwd, { remote, acceptRewrite: args.includes("--accept-rewrite") });
          break;
        } catch (e) {
          if (!/lock exists/.test(e.message) || i >= 20) throw e;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        }
      }
      if (!args.includes("--quiet"))
        console.log(
          human
            ? r.already
              ? `Records already sync through ${sync.branch}.`
              : [
                  `Records synced with ${remote}/${sync.branch}: ${r.committed ? "local changes pushed" : "nothing new to push"}, ${r.pulled} file${r.pulled === 1 ? "" : "s"} pulled${r.conflicts ? `, ${r.conflicts} conflict${r.conflicts === 1 ? "" : "s"} frozen for a person (agentbridge board)` : ""}.`,
                  ...(r.folded
                    ? [`Joined the shared records; this checkout's old copy: ${r.folded.stale} already shared, ${r.folded.added} added, ${r.folded.merged} merged${r.folded.conflicts ? ` (${r.folded.conflicts} conflict${r.folded.conflicts === 1 ? "" : "s"} frozen for a person)` : ""}.`]
                    : []),
                  ...(r.removedFromCode ? ["Moved records out of the code branch. Commit the removal and get it onto your main branch: git commit -m \"Move AgentBridge records to the agentbridge-records branch\""] : []),
                ].join("\n")
            : JSON.stringify(r),
        );
      break;
    }
    case "onboard": {
      const r = onboard(cwd, bin, { solo: args.includes("--solo"), dryRun: args.includes("--dry-run") });
      console.log(args.includes("--json") ? JSON.stringify(r) : onboardText(r));
      if (r.steps.some((s) => s.state === "needs-you")) process.exitCode = 1;
      break;
    }
    case "setup":
      pr(identity.setup(cwd, bin));
      break;
    case "whoami":
      pr({ login: identity.login(cwd), actor: identity.resolveActor(cwd, flag("--actor")) || null });
      break;
    case "merge-driver": {
      const [base, ours, theirs] = args.slice(0, 3);
      const load = (p) => (p && fs.existsSync(p) && fs.statSync(p).size ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
      const merged = mergeRecords(load(base), load(ours) ?? {}, load(theirs) ?? {});
      fs.writeFileSync(ours, JSON.stringify(merged.record, null, 2) + "\n");
      if (merged.conflicts) {
        console.error(`AgentBridge: ${merged.conflicts} conflicting field(s) in ${args[3] || ours}; kept ours and recorded both. Resolve with agentbridge resolve-merge.`);
        process.exitCode = 1;
      }
      break;
    }
    case "resolve-merge":
      pr(c.resolveMerge(cwd, args[0], args[1], args[2], person()));
      break;
    case "migrate":
      pr(c.migrate(cwd));
      break;
    case "doctor":
      pr(doctor());
      break;
    case "task":
      switch (args[0]) {
        case "add":
          if (flag("--to")) {
            pr(
              team.assign(cwd, args[1], flag("--criteria"), actor(), other("--to"), {
                scope: flag("--scope").split(",").filter(Boolean),
                ref: flag("--ref"),
                next: flag("--next"),
              }),
            );
            break;
          }
          if (flag("--scope")) fresh();
          pr(
            c.addTask(
              cwd,
              args[1],
              flag("--criteria"),
              actor(),
              flag("--scope").split(",").filter(Boolean),
              flag("--ref"),
              { exclusive: true },
            ),
          );
          break;
        case "list":
          pr(
            c
              .tasks(cwd)
              .map((t) => ({
                id: t.id,
                title: t.title,
                owner: t.owner,
                status: c.status(cwd, t.id).effectiveStatus,
              })),
          );
          break;
        case "show":
          pr(c.status(cwd, args[1]));
          break;
        case "claim":
          pr(c.claim(cwd, args[1], actor()));
          break;
        case "status":
          pr(c.setStatus(cwd, args[1], args[2], actor()));
          break;
        case "note":
          pr(c.note(cwd, args[1], actor(), args[2]));
          break;
        case "cancel": {
          const a = actor();
          pr(c.cancel(cwd, args[1], a, flag("--reason"), { principal: identity.principalOf(cwd, a, c.task(cwd, args[1]).owner) }));
          break;
        }
        case "reassign": {
          const a = actor(), to = other("--to");
          identity.requireReassign(cwd, a, c.task(cwd, args[1]).owner, to);
          pr(c.reassign(cwd, args[1], a, to, flag("--reason")));
          break;
        }
        case "close": {
          const a = actor();
          pr(team.closeMerged(cwd, args[1], a, { pr: flag("--pr"), principal: identity.principalOf(cwd, a, c.task(cwd, args[1]).owner) }));
          break;
        }
        case "scope":
          fresh();
          pr(c.setScope(cwd, args[1], actor(), (args[2] || "").split(",").filter(Boolean)));
          break;
        default:
          throw Error("Unknown task command");
      }
      break;
    case "assign": {
      const a = actor(), to = other("--to");
      identity.requirePersonHere(cwd, a, "assigns work");
      if (!to) throw Error("Who to? --to claude, --to codex, or --to a teammate's GitHub login");
      const why = flag("--reason") || flag("--next");
      const scope = flag("--scope").split(",").filter(Boolean);
      const mine = identity.ownedBy(cwd, a, to);
      if (flag("--scope")) fresh();
      if (!/^task-/.test(args[0] || "")) {
        if (!args[0]?.trim() || args[0].startsWith("--")) throw Error('Say what: agentbridge assign "Fix the login redirect" --to codex');
        const criteria = flag("--criteria") || args[0];
        if (!mine) {
          pr(team.assign(cwd, args[0], criteria, a, to, { scope, ref: flag("--ref"), next: why }));
          break;
        }
        const t = c.addTask(cwd, args[0], criteria, a, scope, flag("--ref"), { exclusive: true });
        pr(to === a ? t : c.reassign(cwd, t.id, a, to, why || `Assigned by ${a}`));
        break;
      }
      const t = c.task(cwd, args[0]);
      if (mine && identity.ownedBy(cwd, a, t.owner)) {
        identity.requireReassign(cwd, a, t.owner, to);
        pr(c.reassign(cwd, t.id, a, to, why || `Assigned by ${a}`));
      } else pr(c.offer(cwd, t.id, a, to, why || "Take this task; the criteria are the done bar", { principal: identity.principalOf(cwd, a, t.owner) }));
      break;
    }
    case "done": {
      const a = actor();
      identity.requirePersonHere(cwd, a, "closes work with done (agents use task close)");
      if (!args[0] || args[0].startsWith("--")) {
        const found = team.mergedOpen(cwd);
        if (!found) throw Error("Could not list merged pull requests (needs a GitHub origin and a logged-in gh). Close one task with: agentbridge done TASK --pr N");
        const mine = found.filter((x) => identity.ownedBy(cwd, a, x.owner));
        const theirs = found.length - mine.length;
        const tail = theirs ? `\n${theirs} more belong to teammates; they close their own.` : "";
        if (!mine.length) {
          console.log(`Nothing to close: none of your tasks has a merged pull request.${tail}`);
          break;
        }
        console.log(`${mine.length} of your tasks have a merged pull request:`);
        for (const x of mine) console.log(`  ${x.id.slice(5, 13)}  ${x.title}  (${x.owner}, PR #${x.pr} merged)${x.note ? `\n            last note: ${x.note.slice(0, 120)}` : ""}`);
        console.log("Closing releases their files. If a note says work remains, answer n and close the others one by one: agentbridge done TASK");
        let yes = args.includes("--yes");
        if (!yes) {
          if (!process.stdin.isTTY) throw Error("Add --yes to close them without asking");
          process.stdout.write(`Close all ${mine.length}? [y/N] `);
          const answer = await new Promise((done) => process.stdin.once("data", (d) => done(String(d))));
          process.stdin.pause();
          yes = /^y(es)?$/i.test(answer.trim());
        }
        if (!yes) {
          console.log("Nothing closed.");
          break;
        }
        let closed = 0;
        for (const x of mine) {
          try {
            team.closeMerged(cwd, x.id, a, { pr: x.pr, principal: identity.principalOf(cwd, a, x.owner) });
            closed++;
          } catch (e) {
            console.log(`  ${x.id.slice(5, 13)} not closed: ${e.message}`);
          }
        }
        console.log(`Closed ${closed} of ${mine.length}; their files are free.${tail}`);
        break;
      }
      const t = c.task(cwd, args[0]);
      const principal = identity.principalOf(cwd, a, t.owner);
      if (flag("--reason")) pr(c.cancel(cwd, t.id, a, flag("--reason"), { principal }));
      else if (c.effectiveStatus(cwd, t).startsWith("verified")) pr(c.setStatus(cwd, t.id, "done", person()));
      else {
        try {
          pr(team.closeMerged(cwd, t.id, a, { pr: flag("--pr"), principal }));
        } catch (e) {
          if (/No merged pull request|Could not list merged/.test(e.message))
            throw Error(`${e.message}. To close it without a merged pull request (not needed, done elsewhere): agentbridge done ${t.id.slice(5, 13)} --reason "why"`);
          throw e;
        }
      }
      break;
    }
    case "decision":
      if (args[0] === "add") {
        if (!actor()) throw Error("Value required for --actor");
        pr(c.addDecision(cwd, args[1], args[2], flag("--why"), actor()));
      } else if (args[0] === "propose")
        pr(
          c.proposeProjectDecision(
            cwd,
            args[1],
            flag("--why"),
            actor(),
            flag("--supersedes"),
          ),
        );
      else if (args[0] === "list") pr(c.projectDecisions(cwd));
      else if (args[0] === "accept")
        pr(c.acceptDecision(cwd, args[1], person()));
      else throw Error("Unknown decision command");
      break;
    case "finding":
      if (args[0] === "add")
        pr(c.reportFinding(cwd, args[1], args[2], identity.guardSession(identity.resolveActor(cwd, flag("--by") || flag("--actor") || identity.agentSession()?.agent || ""))));
      else if (args[0] === "resolve")
        pr(c.resolveFinding(cwd, args[1], args[2], actor(), flag("--why")));
      else throw Error("Unknown finding command");
      break;
    case "evidence":
      if (args[0] !== "add") throw Error("Unknown evidence command");
      pr(
        c.recordEvidence(cwd, args[1], args[2], args[3], null, flag("--notes")),
      );
      break;
    case "inbox": {
      const r = co.inbox(cwd, actor(), { since: flag("--since") });
      const format = flag("--format") || (human ? "text" : "json");
      if (!["json", "text"].includes(format))
        throw Error("--format must be json or text");
      console.log(format === "text" ? co.inboxText(r) : JSON.stringify(r));
      break;
    }
    case "check": {
      const paths = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith("--")) i++;
        else paths.push(args[i]);
      }
      const r = co.checkPaths(cwd, actor(), paths);
      console.log(JSON.stringify(r));
      if (!r.allowed) process.exitCode = 1;
      break;
    }
    case "hook": {
      if (args[0] === "pre-commit") {
        const r = agents.preCommit(cwd);
        if (r.message) console.error(r.message);
        process.exitCode = r.exit;
        break;
      }
      if (args[0] === "install-git") {
        pr(agents.installGitHook(cwd, bin));
        break;
      }
      if (!["pre-edit", "prompt"].includes(args[0])) throw Error("Unknown hook; use pre-edit, prompt, pre-commit or install-git");
      let raw = "";
      for await (const chunk of process.stdin) raw += chunk;
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        throw Error("Hook input must be JSON on stdin");
      }
      const hookActor = identity.resolveActor(cwd, flag("--actor") || identity.agentSession()?.agent || "");
      if (args[0] === "prompt") {
        sync.autoSync(cwd, bin, { minIntervalMs: 60000 });
        const text = agents.promptUpdate(input, hookActor);
        if (text) console.log(text);
        break;
      }
      const r = agents.preEdit(input, hookActor);
      if (r.changed) sync.autoSync(cwd, bin, { onlyIfChanged: true });
      if (r.message) console.error(r.message);
      if (r.context) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: r.context } }));
      process.exitCode = r.exit;
      break;
    }
    case "mcp":
      await agents.serve(actor());
      break;
    case "approvals": {
      const r = team.approvals(cwd, { verify: args.includes("--verify") });
      console.log(args.includes("--json") ? JSON.stringify(r) : team.approvalsText(r));
      if (r.verified && r.approvals.some((a) => a.state === "invalid" || (r.required && a.state !== "verified"))) process.exitCode = 1;
      break;
    }
    case "policy": {
      if (args[0] === "ownership" && c.ownershipModes.includes(args[1])) {
        pr(team.setPolicy(cwd, "ownership", args[1], person()));
        break;
      }
      if (args[0] !== "signed-approvals" || !["required", "optional"].includes(args[1]))
        throw Error("Use: policy ownership warn|block, or policy signed-approvals required|optional");
      pr(team.setApprovalPolicy(cwd, args[1], person()));
      break;
    }
    case "release": {
      pr(c.release(cwd, args[0], person(), flag("--reason")));
      break;
    }
    case "board": {
      const format = flag("--format") || "text";
      if (!["json", "text"].includes(format)) throw Error("--format must be json or text");
      const b = team.board(cwd);
      const st = sync.status(cwd);
      const syncLine = !st ? "" : st.pending || st.ahead ? `\nRecords: ${st.pending + (st.ahead || 0)} change(s) not yet shared; run agentbridge sync` : `\nRecords synced ${st.lastSync ? `at ${st.lastSync.slice(0, 16).replace("T", " ")}` : ""} via ${sync.branch}`;
      console.log(format === "text" ? team.boardText(b) + syncLine : JSON.stringify(b));
      break;
    }
    case "log": {
      const format = flag("--format") || "text";
      if (!["json", "text"].includes(format)) throw Error("--format must be json or text");
      const r = team.log(cwd, { since: flag("--since"), actor: other("--actor"), limit: flag("--limit") || 100 });
      console.log(format === "text" ? team.logText(r) : JSON.stringify(r));
      break;
    }
    case "pr":
      if (args[0] === "summary") console.log(team.prSummary(cwd, args[1]).markdown);
      else if (args[0] === "publish") pr(team.prPublish(cwd, args[1], flag("--pr")));
      else throw Error("Unknown pr command; use summary or publish");
      break;
    case "context":
      pr(c.context(cwd, args[0]));
      break;
    case "digest": {
      const r = digest(cwd, actor(), { since: flag("--since"), advance: !args.includes("--peek") });
      if (flag("--format") === "text" || (human && flag("--format") !== "json")) console.log(digestText(r));
      else console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "resume": {
      const r = team.resumeFor(cwd, actor(), args[0] && !args[0].startsWith("--") ? args[0] : "");
      if (flag("--format") === "text" || (human && flag("--format") !== "json")) console.log(team.resumeText(r));
      else console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "handoff":
      if (args[0] === "offer")
        pr(c.offer(cwd, args[1], actor(), other("--to"), flag("--next")));
      else if (args[0] === "receive") {
        fresh();
        const t = c.receive(cwd, args[1], actor());
        if (human) console.log(`${summarize(t)}\n\n${team.resumeText(team.resume(cwd, t.id))}`);
        else pr(t);
      }
      else if (args[0] === "decline") pr(c.decline(cwd, args[1], actor(), flag("--reason")));
      else if (args[0] === "withdraw") {
        const a = actor();
        pr(c.withdraw(cwd, args[1], a, { principal: identity.principalOf(cwd, a, c.task(cwd, args[1]).owner) }));
      }
      else pr(c.handoff(cwd, args[0]));
      break;
    case "workspace":
      if (args[0] === "create") pr(c.createWorkspace(cwd, args[1], actor()));
      else if (args[0] === "attach")
        pr(c.attachWorkspace(cwd, args[1], actor(), args[2]));
      else throw Error("Unknown workspace command");
      break;
    case "implement":
      if (args[0] === "record")
        pr(
          w.recordImplementation(
            cwd,
            args[1],
            actor(),
            flag("--tool"),
            flag("--summary"),
          ),
        );
      else
        pr(
          await w.implement(cwd, args[0], actor(), flag("--provider"), {
            timeoutMs: flag("--timeout") || undefined,
          }),
        );
      break;
    case "review":
      pr(
        await w.review(cwd, args[0], actor(), flag("--provider"), {
          timeoutMs: flag("--timeout") || undefined,
        }),
      );
      break;
    case "test":
      if (args[0] === "configure")
        pr(
          c.configureTest(
            cwd,
            args[1],
            actor(),
            args[2],
            JSON.parse(flag("--argv")),
            flag("--criteria").split(","),
            Number(flag("--timeout") || 120000),
          ),
        );
      else if (args[0] === "run") {
        const run = await w.runTests(cwd, args[1], actor());
        pr(run);
        if (run.state !== "succeeded") process.exitCode = 1;
      } else throw Error("Unknown test command");
      break;
    case "verify":
      pr(c.setStatus(cwd, args[0], "verified", actor()));
      break;
    case "accept":
      pr(c.setStatus(cwd, args[0], "done", person()));
      break;
    case "recover":
      pr(w.recover(cwd, args[0], actor()));
      break;
    case "recover-lock":
      pr(recoverLock(cwd, args[0]));
      break;
    default:
      throw Error(`Unknown command: ${command}. Run --help.`);
  }
  if (!["sync", "hook", "mcp", "merge-driver", "onboard", "where"].includes(command) && !process.exitCode)
    sync.autoSync(cwd, bin, { onlyIfChanged: true });
} catch (e) {
  const editHook = command === "hook" && args[0] === "pre-edit";
  console.error(editHook ? `AgentBridge blocked this edit because the ownership check failed: ${e.message}` : `Error: ${e.message}`);
  process.exitCode = editHook ? 2 : 1;
}
