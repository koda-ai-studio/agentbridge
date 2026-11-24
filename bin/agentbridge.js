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
Run from the project root. In a terminal, records print as a short summary; add --json for the full record. Pipes and agents get JSON.
For people, two commands; your agents handle the rest:
  agentbridge onboard        set up this repository (once)
  agentbridge                asks about each thing that needs you (offers, decisions, finished work,
                             merged or duplicate tasks, stalled agents), one key per answer
When you want more: agentbridge digest (what happened since you last looked: merged, handoffs,
  decisions, findings, open work with PRs, what waits on you; --since 7d|DATE), board (overview),
  assign "New work" --to codex|claude|TEAMMATE, done TASK [--reason "why"], resume TASK.
New here? agentbridge demo shows a Claude-to-Codex handoff in a throwaway repository (nothing of
  yours changes). agentbridge stats [--since DATE] prints usage counts for pilot feedback.
Everything below is for agents and scripts.

  onboard [--solo] [--dry-run] [--json]   (one-step setup: records, identity, commit check, skill, Claude and Codex hooks, Codex MCP)
  init [--records-dir /abs/dir] | where | migrate | doctor
  sync [--init] [--remote origin] [--accept-rewrite] (team records on their own branch, agentbridge-records: --init moves
      committed .agentbridge/ there; sync commits, merges and pushes; runs on its own after changes)
  setup                        (team clone: GitHub login as identity via gh, and the record merge driver)
  whoami [--actor codex]       (shows the login and how an actor name resolves)
  resolve-merge ID FIELD ours|theirs --actor NAME   (person only; settles a record merge conflict)
  task add "Title" --criteria "Check one; Check two" --actor alice [--scope src,tests] [--ref ISSUE-KEY|URL]
      [--to bob [--next "First step"]]   (assign: creates and offers; bob accepts with handoff receive)
  task list | task show ID | task claim ID --actor NAME
  task status ID in_progress|implemented|needs_work|ready_for_review --actor NAME
  task note ID "Branch, PR, what is left" --actor NAME   (owner only, max 200 chars)
  task scope ID src/a,src/b-* --actor NAME             (owner only; refuses paths others are working on)
  task close ID [--pr N]          (owner or their person: its pull request merged on GitHub; releases its paths)
  task cancel ID --reason "Why"   (owner or their person: stop without finishing; releases its paths)
  task reassign ID --to claude --reason "Why" --actor YOU   (person only, own terminal: move a task and its paths
      between you and your own agents, e.g. when one agent stopped mid-task; another person gets a handoff offer)
  decision add ID "Decision" --why "Rationale" --actor NAME
  decision propose "Project-wide decision" --why "Rationale" --actor NAME [--supersedes DECISION-ID]
  decision accept DECISION-ID --actor NAME | decision list
  finding add ID "Finding" --by NAME
  finding resolve ID FINDING-ID --actor NAME --why "Resolution"
  evidence add ID "command" pass|fail|skipped [--notes TEXT] (manual only)
  inbox --actor NAME [--since ISO|last] [--format json|text]   (text in a terminal, JSON otherwise)
  digest [--since last|7d|ISO] [--peek] [--format json|text]   (catch-up from records and linked PRs; default since your
      last digest, else 7 days; --peek keeps your place)
  check PATH... --actor NAME   (exit 1 when another owner's active scope covers a path)
  board [--format text|json]                       (team view: owners, offers, waiting for people, attention)
  approvals [--verify] [--json]  (every approval; --verify checks signatures against the signer's GitHub signing keys)
  policy signed-approvals required|optional --actor NAME   (person only; required refuses unsigned approvals)
  log [--since 7d|ISO] [--actor NAME] [--limit N] [--format text|json]   (team audit trail, newest first)
  pr summary ID | pr publish ID --pr N   (publish posts a PR comment and an "agentbridge" commit status via gh)
  context ID | handoff ID
  hook pre-edit --actor NAME   (Claude Code / Codex PreToolUse hook; blocks edits to paths others own)
  hook prompt --actor NAME     (Claude Code / Codex UserPromptSubmit hook; adds new handoffs and changes to the prompt)
  hook install-git             (Git pre-commit check, chained before any existing hook)
  hook pre-commit              (blocks commits touching paths others own; actor from AGENTBRIDGE_ACTOR or an <actor>/ branch)
  mcp --actor NAME             (MCP server over stdio: inbox, check, start_task, note, handoffs)
  handoff offer ID --actor alice --to bob --next "Review and test"
  handoff receive ID --actor bob
  handoff decline ID [--reason "Why"]   (the recipient) | handoff withdraw ID (who offered it, or the owner)
  workspace create ID --actor NAME
  workspace attach ID /absolute/worktree/path --actor NAME
  implement ID --actor NAME --provider claude|codex [--timeout MS]
  implement record ID --actor NAME --tool claude|codex|human|other --summary "What changed"
  review ID --actor NAME --provider claude|codex [--timeout MS]
  test configure ID NAME --actor NAME --argv '["node","--test"]' --criteria c1,c2 [--timeout 120000]
  test run ID --actor NAME
  verify ID --actor NAME
  accept ID --actor NAME
  recover ID --actor NAME | recover-lock write|execution

Execution commands launch real processes and may use provider quota. Inspect and commit
code in the task workspace between implementation and review/test. No automatic commits,
pushes, merges or hidden retry loops. Commands must be run only in trusted projects.`;
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
      pr(help);
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
      if (r.message) console.error(r.message);
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
      if (args[0] !== "signed-approvals" || !["required", "optional"].includes(args[1]))
        throw Error("Use: policy signed-approvals required|optional --actor NAME");
      pr(team.setApprovalPolicy(cwd, args[1], person()));
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
