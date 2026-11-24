import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as c from "../lib/core.js";
import * as co from "../lib/coordination.js";
import * as s from "../lib/store.js";
import * as w from "../lib/workflow.js";
import { git } from "../lib/git.js";
import { validate, conforms } from "./schema.js";


function repo(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-coord-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(cwd, "ui/lib"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "ui/lib/graph-layout.ts"), "export {};\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "init"]);
  c.init(cwd);
  const canvas = c.addTask(cwd, "Canvas rendering", "Renders", "claude", [
    "ui/lib/graph-*",
    "ui/components/graph-*",
  ]);
  const e2e = c.addTask(cwd, "Non-canvas E2E", "Green", "codex", ["ui/app"]);
  return { cwd, canvas, e2e };
}

test("scope globs are a trailing-prefix only and overlap correctly", (t) => {
  assert.ok(co.pathInScope("ui/lib/graph-*", "ui/lib/graph-layout.ts"));
  assert.ok(!co.pathInScope("ui/lib/graph-*", "ui/lib/grapher.ts"));
  assert.ok(co.pathInScope("ui/app", "ui/app/page.tsx"));
  assert.ok(!co.pathInScope("ui/app", "ui/application.ts"));
  assert.ok(co.scopesOverlap("ui/lib/graph-*", "ui/lib"));
  assert.ok(co.scopesOverlap("ui/lib", "ui/lib/graph-*"));
  assert.ok(co.scopesOverlap("ui/lib/graph-*", "ui/lib/graph-layout.ts"));
  assert.ok(co.scopesOverlap("ui/lib/graph-*", "ui/lib/graph-l*"));
  assert.ok(!co.scopesOverlap("ui/lib/graph-*", "ui/app"));
  assert.ok(!co.scopesOverlap("ui/lib/graph-*", "ui/lib/node-*"));
  assert.deepEqual(c.normalizeScope(["./ui/lib/graph-*"]), ["ui/lib/graph-*"]);
  for (const bad of ["*", "ui/*/graph", "ui/gr*ph", "**"])
    assert.throws(() => c.normalizeScope([bad]), /final character/, bad);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-scope-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  c.init(cwd);
  const a = c.addTask(cwd, "A", "A", "claude", ["ui/lib/graph-*"]);
  const b = c.addTask(cwd, "B", "B", "codex", ["ui/lib"]);
  c.addTask(cwd, "C", "C", "codex", ["ui/lib/node-*"]);
  assert.deepEqual(c.context(cwd, a.id).related.map((x) => x.id), [b.id]);
});

test("check blocks edits inside another owner's active scope and explains why", (t) => {
  const { cwd, canvas, e2e } = repo(t);
  const blocked = co.checkPaths(cwd, "codex", ["ui/lib/graph-layout.ts"]);
  conforms(blocked, "check");
  assert.equal(blocked.allowed, false);
  assert.deepEqual(
    blocked.conflicts.map((x) => [x.path, x.task, x.owner]),
    [["ui/lib/graph-layout.ts", canvas.id, "claude"]],
  );
  const mine = co.checkPaths(cwd, "codex", ["./ui/app/page.tsx", "README.md"]);
  assert.equal(mine.allowed, true);
  assert.deepEqual(mine.owned, [{ path: "ui/app/page.tsx", task: e2e.id }]);
  assert.deepEqual(mine.unclaimed, ["README.md"]);
  assert.throws(() => co.checkPaths(cwd, "", ["x"]), /Actor required/);
  assert.throws(() => co.checkPaths(cwd, "codex", []), /path required/);
  assert.throws(() => co.checkPaths(cwd, "codex", ["../outside"]), /"\.\." segments/);
  c.offer(cwd, canvas.id, "claude", "codex", "Take the canvas");
  assert.match(
    co.checkPaths(cwd, "codex", ["ui/lib/graph-layout.ts"]).conflicts[0].hint,
    /handoff receive/,
  );
  c.receive(cwd, canvas.id, "codex");
  assert.equal(co.checkPaths(cwd, "codex", ["ui/lib/graph-layout.ts"]).allowed, true);
  assert.equal(co.checkPaths(cwd, "claude", ["ui/lib/graph-layout.ts"]).allowed, false);
});

test("check resolves absolute paths from any worktree, including new files", (t) => {
  const { cwd } = repo(t);
  const wt = path.join(s.root(cwd), "local", "agent-wt");
  git(cwd, ["worktree", "add", "--detach", wt]);
  const r = co.checkPaths(cwd, "codex", [
    path.join(wt, "ui/lib/graph-layout.ts"),
    path.join(wt, "ui/lib/graph-new/file.ts"),
  ]);
  assert.deepEqual(
    r.conflicts.map((x) => x.path),
    ["ui/lib/graph-layout.ts", "ui/lib/graph-new/file.ts"],
  );
  assert.throws(
    () => co.checkPaths(cwd, "codex", [path.join(os.tmpdir(), "no-repo-here-xyz", "f")]),
    /Git failed|not inside/,
  );
});

test("stale done work still blocks; accepted work closed elsewhere does not", async (t) => {
  const { cwd, canvas } = repo(t);
  c.configureTest(cwd, canvas.id, "claude", "noop", [process.execPath, "-e", ""], ["c1"]);
  const work = c.createWorkspace(cwd, canvas.id, "claude").workspace;
  fs.writeFileSync(path.join(work, "ui/lib/graph-layout.ts"), "export const v = 2;\n");
  git(work, ["commit", "-am", "Layout v2"]);
  w.recordImplementation(cwd, canvas.id, "claude", "claude", "Layout v2");
  await w.review(cwd, canvas.id, "claude", "codex", {
    invoke: async () => ({ outcome: "pass", summary: "ok", findings: [] }),
  });
  await w.runTests(cwd, canvas.id, "claude");
  c.setStatus(cwd, canvas.id, "verified", "claude");
  c.setStatus(cwd, canvas.id, "done", "claude");
  assert.equal(co.checkPaths(cwd, "codex", ["ui/lib/graph-layout.ts"]).allowed, true);
  fs.appendFileSync(path.join(work, "ui/lib/graph-layout.ts"), "// later\n");
  git(work, ["commit", "-am", "Later change"]);
  assert.equal(c.status(cwd, canvas.id).effectiveStatus, "stale");
  assert.equal(co.checkPaths(cwd, "codex", ["ui/lib/graph-layout.ts"]).allowed, false);
  fs.rmSync(s.file(cwd, "local", canvas.id));
  assert.equal(c.status(cwd, canvas.id).effectiveStatus, "done-unchecked");
  assert.equal(co.checkPaths(cwd, "codex", ["ui/lib/graph-layout.ts"]).allowed, true);
});

test("inbox gives each actor a compact typed view and only new changes with --since last", (t) => {
  const { cwd, canvas, e2e } = repo(t);
  const d = c.proposeProjectDecision(cwd, "Claude owns canvas", "Avoid overlap", "alice");
  c.acceptDecision(cwd, d.id, "alice");
  c.proposeProjectDecision(cwd, "Pause merge-queue tuning", "Focus", "codex");
  c.offer(cwd, canvas.id, "claude", "codex", "Take canvas; patch saved");
  const first = co.inbox(cwd, "codex", { since: "last" });
  conforms(first, "inbox");
  assert.equal(first.since, null);
  assert.deepEqual(first.incoming.map((x) => [x.id, x.from]), [[canvas.id, "claude"]]);
  assert.deepEqual(first.owned.map((x) => x.id), [e2e.id]);
  assert.deepEqual(first.doNotEdit.map((x) => x.task), [canvas.id]);
  assert.deepEqual(first.decisions.accepted.map((x) => x.summary), ["Claude owns canvas"]);
  assert.deepEqual(first.decisions.proposed.map((x) => x.by), ["codex"]);
  assert.ok(first.changes.some((x) => x.event === "handoff_offered" && x.actor === "claude"));
  assert.ok(first.changes.every((x) => x.actor !== "codex"));
  const claudeView = co.inbox(cwd, "claude");
  assert.deepEqual(claudeView.outgoing.map((x) => [x.id, x.to]), [[canvas.id, "codex"]]);
  const again = co.inbox(cwd, "codex", { since: "last" });
  assert.ok(again.since);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.decisions.accepted, []);
  assert.equal(again.incoming.length, 1, "pending work is always listed");
  c.reportFinding(cwd, e2e.id, "Drawer test flakes", "claude");
  const third = co.inbox(cwd, "codex", { since: "last" });
  assert.deepEqual(third.changes.map((x) => x.event), ["finding_opened"]);
  assert.equal(third.owned[0].openFindings, 1);
  assert.throws(() => co.inbox(cwd, "codex", { since: "yesterday" }), /ISO timestamp/);
  assert.throws(() => co.inbox(cwd, ""), /Actor required/);
  const text = co.inboxText(co.inbox(cwd, "codex"));
  assert.match(text, /Handoffs waiting for you\n- Canvas rendering from claude/);
  assert.match(text, /Do not edit \(owned by others\)/);
  assert.match(co.inboxText(co.inbox(cwd, "nobody", { since: new Date(Date.now() + 1e6).toISOString() })), /Do not edit|Nothing for you/);
});

test("stored task and project decision records match the published schema", (t) => {
  const { cwd, canvas } = repo(t);
  c.offer(cwd, canvas.id, "claude", "codex", "Next");
  c.reportFinding(cwd, canvas.id, "Issue", "codex");
  c.addDecision(cwd, canvas.id, "Use layout v2", "Faster", "claude");
  conforms(c.task(cwd, canvas.id), "task");
  const a = c.proposeProjectDecision(cwd, "A", "why", "alice");
  c.acceptDecision(cwd, a.id, "bob");
  const b = c.proposeProjectDecision(cwd, "B", "why", "bob", a.id);
  c.acceptDecision(cwd, b.id, "alice");
  for (const d of c.projectDecisions(cwd)) conforms(d, "projectDecision");
  assert.notDeepEqual(validate({ v: 1 }, { $ref: "#/$defs/inbox" }), []);
});

test("CLI inbox and check speak compact JSON and check exits nonzero on conflict", (t) => {
  const { cwd, canvas } = repo(t);
  const bin = path.resolve("bin/agentbridge.js");
  const run = (...args) =>
    spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", timeout: 15000 });
  const blocked = run("check", "ui/lib/graph-layout.ts", "--actor", "codex");
  assert.equal(blocked.status, 1);
  assert.equal(blocked.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(blocked.stdout).conflicts[0].task, canvas.id);
  const ok = run("check", "--actor", "codex", "ui/app/x.tsx");
  assert.equal(ok.status, 0, ok.stderr);
  const inbox = run("inbox", "--actor", "codex", "--since", "last");
  assert.equal(inbox.status, 0, inbox.stderr);
  conforms(JSON.parse(inbox.stdout), "inbox");
  const text = run("inbox", "--actor", "codex", "--format", "text");
  assert.match(text.stdout, /^Inbox for codex/);
  assert.notEqual(run("inbox", "--actor", "codex", "--format", "xml").status, 0);
  assert.equal(run("check", "x").status, 0, "a person in a terminal needs no --actor");
});

test("owners keep a short status note that others see next to the paths they must not edit", (t) => {
  const { cwd, canvas, e2e } = repo(t);
  c.note(cwd, canvas.id, "claude", "  claude/compact-canvas #6382; nav chain half a row low  ");
  assert.equal(c.task(cwd, canvas.id).note.text, "claude/compact-canvas #6382; nav chain half a row low");
  assert.throws(() => c.note(cwd, canvas.id, "codex", "mine now"), /owned by claude/);
  assert.throws(() => c.note(cwd, e2e.id, "codex", "  "), /text required/);
  assert.throws(() => c.note(cwd, e2e.id, "codex", "x".repeat(201)), /at most 200/);
  const mine = co.inbox(cwd, "claude"), theirs = co.inbox(cwd, "codex");
  assert.equal(mine.owned.find((x) => x.id === canvas.id).note, c.task(cwd, canvas.id).note.text);
  assert.equal(theirs.doNotEdit.find((x) => x.task === canvas.id).note, c.task(cwd, canvas.id).note.text);
  assert.ok(!("note" in theirs.owned[0]), "no note field until one is set");
  assert.deepEqual(theirs.changes, [], "notes on others' tasks show in doNotEdit, not as changes");
  conforms(mine, "inbox");
  conforms(theirs, "inbox");
  conforms(c.task(cwd, canvas.id), "task");
  assert.match(co.inboxText(theirs), /graph-\* — claude \(claude\/compact-canvas #6382/);
  assert.equal(c.note(cwd, e2e.id, "codex", "x".repeat(200)).note.text.length, 200);
});

const cli = (cwd, args, input) =>
  spawnSync(process.execPath, [path.resolve("bin/agentbridge.js"), ...args], {
    cwd, input, encoding: "utf8", timeout: 15000,
  });

test("Claude Code pre-edit hook blocks edits to another owner's paths and allows everything else", (t) => {
  const { cwd, canvas } = repo(t);
  const hook = (actor, tool, input, from = cwd) =>
    cli(from, ["hook", "pre-edit", "--actor", actor], JSON.stringify({ hook_event_name: "PreToolUse", cwd: from, tool_name: tool, tool_input: input }));
  const canvasFile = path.join(cwd, "ui/lib/graph-layout.ts");
  const blocked = hook("codex", "Edit", { file_path: canvasFile, old_string: "a", new_string: "b" });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /claude is working on ui\/lib\/graph-layout\.ts/);
  assert.match(blocked.stderr, new RegExp(`task "Canvas rendering", ${canvas.id.slice(5, 13)}, not started`));
  assert.equal(hook("codex", "Write", { file_path: path.join(cwd, "ui/lib/graph-new.ts"), content: "" }).status, 2, "new files inside a scope are covered");
  assert.equal(hook("codex", "NotebookEdit", { notebook_path: path.join(cwd, "ui/lib/graph-n.ipynb") }).status, 2);
  assert.equal(hook("codex", "MultiEdit", { file_path: "ui/lib/graph-layout.ts", edits: [] }).status, 2, "relative paths resolve from the session cwd");
  assert.equal(hook("claude", "Edit", { file_path: canvasFile }).status, 0, "owners may edit");
  assert.equal(hook("codex", "Edit", { file_path: path.join(cwd, "README.md") }).status, 0, "unclaimed paths are allowed");
  assert.equal(hook("codex", "Read", { file_path: canvasFile }).status, 0, "only edit tools are checked");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.equal(hook("codex", "Write", { file_path: path.join(outside, "x.txt") }).status, 0, "files outside any repository are allowed");
  git(outside, ["init", "-q"]);
  assert.equal(hook("codex", "Write", { file_path: path.join(outside, "x.txt") }, outside).status, 0, "repositories without AgentBridge are allowed");
  c.offer(cwd, canvas.id, "claude", "codex", "Take the canvas");
  assert.match(hook("codex", "Edit", { file_path: canvasFile }).stderr, /handoff receive/);
  const garbled = cli(cwd, ["hook", "pre-edit", "--actor", "codex"], "not json");
  assert.equal(garbled.status, 2, "a failing check blocks the edit: agents treat any other exit code as allow");
  assert.match(garbled.stderr, /blocked this edit because the ownership check failed/);
  const inOtherSession = spawnSync(process.execPath, [path.resolve("bin/agentbridge.js"), "hook", "pre-edit", "--actor", "codex"], {
    cwd, encoding: "utf8", env: { ...process.env, AI_AGENT: "claude-code_2_agent" },
    input: JSON.stringify({ cwd, tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: ui/lib/graph-layout.ts\n*** End Patch" } }),
  });
  assert.equal(inOtherSession.status, 2, "hooks act as their configured actor, whatever session markers the environment carries");
  assert.match(inOtherSession.stderr, /claude is working on/);
  const patch = (...files) => ({ command: `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}\n@@\n-a\n+b`).join("\n")}\n*** End Patch\n` });
  const codexEdit = (input) => hook("codex", "apply_patch", input);
  assert.equal(codexEdit(patch("README.md")).status, 0, "Codex patches to unclaimed files pass");
  const mixed = codexEdit(patch("README.md", "ui/lib/graph-layout.ts"));
  assert.equal(mixed.status, 2, "one owned file in a multi-file patch blocks it");
  assert.match(mixed.stderr, /claude is working on ui\/lib\/graph-layout\.ts/);
  assert.equal(codexEdit({ command: "*** Begin Patch\n*** Add File: ui/lib/graph-new.ts\n+x\n*** End Patch" }).status, 2, "new files are covered");
  assert.equal(codexEdit({ command: "*** Begin Patch\n*** Update File: README.md\n*** Move to: ui/lib/graph-moved.ts\n*** End Patch" }).status, 2, "move targets are covered");
  assert.equal(codexEdit({ command: "echo hi" }).status, 0, "non-patch input is ignored");
  assert.equal(hook("codex", "Bash", { command: "ls ui/lib" }).status, 0, "shell commands are not edits");

  assert.equal(cli(cwd, ["hook", "other", "--actor", "codex"], "{}").status, 1);
});

test("a person's own agents may edit that person's files; other people and sibling agents may not", (t) => {
  const { cwd } = repo(t);
  const mine = c.addTask(cwd, "Docs", "Clear", "dana", ["docs"]);
  const agentWork = c.addTask(cwd, "Docs site", "Builds", "dana/codex", ["site"]);
  const allowed = (actor, p) => co.checkPaths(cwd, actor, [p]).allowed;
  assert.equal(allowed("dana/codex", "docs/a.md"), true, "an agent works on its person's task");
  assert.deepEqual(co.checkPaths(cwd, "dana/codex", ["docs/a.md"]).owned, [{ path: "docs/a.md", task: mine.id, for: "dana" }]);
  assert.equal(allowed("dana", "site/index.html"), true, "a person works on their own agent's task");
  assert.equal(allowed("dana/claude", "site/index.html"), false, "two agents of one person still do not collide");
  assert.equal(allowed("alice/codex", "docs/a.md"), false, "another person's agent is refused");
  assert.equal(allowed("alice", "docs/a.md"), false);
  assert.equal(allowed("andr", "docs/a.md"), false, "a name that only shares a prefix is someone else");
  assert.equal(allowed("dana2/codex", "docs/a.md"), false);
  assert.ok(!co.inbox(cwd, "dana/codex").doNotEdit.some((x) => x.task === mine.id), "the person's own task is not do-not-edit for their agent");
  assert.ok(co.inbox(cwd, "dana/claude").doNotEdit.some((x) => x.task === agentWork.id), "a sibling agent's task is do-not-edit");

  for (const title of ["One", "Two", "Three", "Four"]) c.addTask(cwd, title, "Done", "bob/codex", ["src/app.js"]);
  const r = cli(cwd, ["hook", "pre-edit", "--actor", "dana/codex"], JSON.stringify({ cwd, tool_name: "Edit", tool_input: { file_path: path.join(cwd, "src/app.js") } }));
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim().split("\n").length, 1, "one line per file, however many tasks hold it");
  assert.match(r.stderr, /bob\/codex is working on src\/app\.js \(4 open tasks: (?:"\w+" \([0-9a-f]{8}\), ){3}\+1 more\)/);
});

test("--version prints the installed version", () => {
  const r = cli(os.tmpdir(), ["--version"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), JSON.parse(fs.readFileSync("package.json", "utf8")).version);
});

test("MCP server exposes typed inbox, check, start_task, note and handoff tools over stdio", (t) => {
  const { cwd, canvas } = repo(t);
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check", arguments: { paths: ["ui/lib/graph-layout.ts", "README.md"] } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "start_task", arguments: { title: "Docs", criteria: "Builds", scope: ["docs"] } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "note", arguments: { task: canvas.id, text: "taking over" } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "inbox", arguments: { cwd: path.join(cwd, "ui/lib") } } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope", arguments: {} } },
    { jsonrpc: "2.0", id: 8, method: "resources/list" },
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "inbox", arguments: { cwd: "relative" } } },
    { jsonrpc: "2.0", id: 10, method: "ping" },
  ];
  const r = cli(cwd, ["mcp", "--actor", "codex"], messages.map((m) => JSON.stringify(m)).join("\n") + "\nnot json\n");
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  const by = Object.fromEntries(out.filter((m) => m.id !== null).map((m) => [m.id, m]));
  assert.equal(out.length, 11, "one reply per request, none for the notification, one parse error");
  assert.equal(by[1].result.protocolVersion, "2025-06-18");
  assert.deepEqual(by[1].result.capabilities, { tools: {} });
  assert.deepEqual(by[2].result.tools.map((x) => x.name), ["inbox", "board", "check", "start_task", "set_scope", "note", "handoff_offer", "handoff_receive", "handoff_decline", "handoff_withdraw", "digest", "resume_task", "report_finding", "resolve_finding", "close_task", "cancel_task"]);
  const check = by[3].result.structuredContent;
  conforms(check, "check");
  assert.equal(check.allowed, false);
  assert.deepEqual(check.unclaimed, ["README.md"]);
  assert.equal(JSON.parse(by[3].result.content[0].text).allowed, false);
  const started = by[4].result.structuredContent;
  assert.equal(started.owner, "codex");
  assert.equal(started.status, "in_progress");
  assert.deepEqual(c.task(cwd, started.id).history[0].by, { via: "mcp", agent: "codex", branch: "main" }, "tool calls record that they came through MCP");
  assert.equal(co.checkPaths(cwd, "claude", ["docs/x.md"]).allowed, false, "start_task claims the scope");
  assert.equal(by[5].result.isError, true);
  assert.match(by[5].result.content[0].text, /owned by claude/);
  const inbox = by[6].result.structuredContent;
  conforms(inbox, "inbox");
  assert.ok(inbox.owned.some((x) => x.id === started.id));
  assert.equal(by[7].error.code, -32602);
  assert.equal(by[8].error.code, -32601);
  assert.equal(by[9].result.isError, true);
  assert.deepEqual(by[10].result, {});
  assert.equal(out.find((m) => m.id === null).error.code, -32700);
});

test("tasks link to the team's tracker instead of copying it", (t) => {
  const { cwd } = repo(t);
  const linked = c.addTask(cwd, "Checkout flow", "Pays", "bob", ["app/checkout"], "  PROJ-142 ");
  assert.equal(linked.ref, "PROJ-142");
  assert.ok(!("ref" in c.addTask(cwd, "Unlinked", "ok", "bob")), "no ref field unless given");
  for (const bad of ["two words", "x".repeat(301)])
    assert.throws(() => c.addTask(cwd, "Bad", "ok", "bob", [], bad), /--ref/);
  c.offer(cwd, linked.id, "bob", "codex", "Finish the webhook");
  const codex = co.inbox(cwd, "codex"), bob = co.inbox(cwd, "bob"), claude = co.inbox(cwd, "claude");
  assert.equal(codex.incoming[0].ref, "PROJ-142");
  assert.equal(bob.owned.find((x) => x.id === linked.id).ref, "PROJ-142");
  assert.equal(claude.doNotEdit.find((x) => x.task === linked.id).ref, "PROJ-142");
  for (const r of [codex, bob, claude]) conforms(r, "inbox");
  conforms(c.task(cwd, linked.id), "task");
  assert.match(co.inboxText(codex), /Finish the webhook \(PROJ-142, task-/);
  const viaCli = cli(cwd, ["task", "add", "From CLI", "--criteria", "ok", "--actor", "codex", "--ref", "https://github.com/o/r/issues/7"]);
  assert.equal(JSON.parse(viaCli.stdout).ref, "https://github.com/o/r/issues/7");
  const mcp = cli(cwd, ["mcp", "--actor", "codex"], JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "start_task", arguments: { title: "Via MCP", criteria: "ok", scope: ["docs"], ref: "LIN-9" } } }) + "\n");
  assert.equal(JSON.parse(mcp.stdout).result.structuredContent.ref, "LIN-9");
});

test("inbox stays small on big projects: do-not-edit is capped, check still covers everything", (t) => {
  const { cwd } = repo(t);
  const ids = [];
  for (let i = 0; i < 60; i++) ids.push(c.addTask(cwd, `Area ${i}`, "ok", "bob", [`src/area${i}`]).id);
  c.note(cwd, ids[0], "bob", "touched last");
  const r = co.inbox(cwd, "codex");
  conforms(r, "inbox");
  assert.equal(r.doNotEdit.length, co.doNotEditLimit);
  assert.equal(r.doNotEditTotal, 61);
  assert.equal(r.doNotEdit[0].task, ids[0], "most recently updated first");
  assert.match(co.inboxText(r), /50 most recent of 61, check covers all/);
  assert.equal(co.checkPaths(cwd, "codex", ["src/area59/x.js"]).allowed, false);
});

test("two agents claiming the same file: the second claim is refused, so nobody ends up blocked", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-claim-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  c.init(cwd);
  const first = c.addTask(cwd, "Fix pay", "ok", "claude", ["src/pay.js"], "", { exclusive: true });
  c.setStatus(cwd, first.id, "in_progress", "claude");
  assert.throws(() => c.addTask(cwd, "Also pay", "ok", "codex", ["src/pay.js"], "", { exclusive: true }), /Someone else is already working on these files: "Fix pay" \(claude, [0-9a-f]{8}, src\/pay.js\)/);
  assert.equal(c.tasks(cwd).length, 1, "the refused claim leaves no task behind");
  assert.equal(co.checkPaths(cwd, "claude", ["src/pay.js"]).allowed, true, "the first owner can still edit");
  const other = c.addTask(cwd, "Docs", "ok", "codex", ["docs"], "", { exclusive: true });
  assert.throws(() => c.setScope(cwd, other.id, "codex", ["src"]), /Someone else is already working on these files/);
  assert.ok(c.addTask(cwd, "Later pay", "ok", "codex", ["src/pay.js"]), "planning overlapping work without claiming it is still allowed");
});
