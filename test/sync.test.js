import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as c from "../lib/core.js";
import * as s from "../lib/store.js";
import { git } from "../lib/git.js";

const bin = path.resolve("bin/agentbridge.js");
const tmp = (t, p) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
function clone(t, origin, name, { auto = false } = {}) {
  const dir = path.join(tmp(t, `agentbridge-sync-${name}-`), "repo");
  git(path.dirname(dir), ["clone", "-q", origin, dir]);
  for (const [k, v] of [["user.email", `${name}@example.invalid`], ["user.name", name], ["commit.gpgsign", "false"]]) git(dir, ["config", k, v]);
  if (!auto) git(dir, ["config", "agentbridge.autoSync", "false"]);
  return dir;
}
function team(t) {
  const origin = path.join(tmp(t, "agentbridge-sync-origin-"), "o.git");
  git(path.dirname(origin), ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = clone(t, origin, "seed");
  fs.writeFileSync(path.join(seed, "app.js"), "export {};\n");
  c.init(seed);
  const shared = c.addTask(seed, "Checkout", "Pays", "alice", ["app.js"]);
  git(seed, ["add", "."]);
  git(seed, ["commit", "-qm", "init"]);
  git(seed, ["push", "-q", "origin", "main"]);
  return { origin, shared };
}
const ab = (cwd, ...args) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", timeout: 30000 });
const ok = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : r.stdout;
};
const titles = (dir) => {
  s.forgetRoot(dir);
  return c.tasks(dir).map((x) => x.title).sort();
};

test("records move to their own branch; every clone and every code branch sees one board", (t) => {
  const { origin, shared } = team(t);
  const alice = clone(t, origin, "alice"), bob = clone(t, origin, "bob");
  const moved = ok(ab(alice, "sync", "--init"));
  assert.equal(moved.removedFromCode, true);
  assert.ok(!fs.existsSync(path.join(alice, ".agentbridge")), "records left the code checkout");
  assert.match(git(alice, ["status", "--porcelain"]), /^D  \.agentbridge\/project\.json$/m, "the removal is staged for the person to commit");
  git(alice, ["commit", "-qm", "Move AgentBridge records to their own branch"]);
  git(alice, ["push", "-q", "origin", "main"]);
  assert.deepEqual(titles(alice), ["Checkout"]);

  ok(ab(bob, "task", "add", "Wishlist", "--criteria", "Saves", "--actor", "bob", "--scope", "wishlist"));
  ok(ab(bob, "finding", "add", shared.id, "Bob saw this before the move", "--by", "bob"));
  ok(ab(alice, "task", "note", shared.id, "Alice after the move", "--actor", "alice"));
  ok(ab(alice, "sync"));
  const early = ok(ab(bob, "sync", "--init"));
  assert.equal(early.joined, true, "a clone that still has its old in-repo records joins instead of being refused");
  assert.deepEqual(early.folded, { added: 1, merged: 1, stale: 1, conflicts: 0 });
  assert.deepEqual(titles(bob), ["Checkout", "Wishlist"]);
  const joined = c.task(bob, shared.id);
  assert.equal(joined.note.text, "Alice after the move", "the old copy does not roll back newer shared changes");
  assert.equal(joined.findings.length, 1, "bob's unshared finding is kept");
  assert.equal(joined.mergeConflicts, undefined);
  ok(ab(alice, "sync"));
  assert.deepEqual(titles(alice), ["Checkout", "Wishlist"], "bob's unshared work reached everyone");
  git(bob, ["pull", "-q", "--no-rebase", "origin", "main"]);

  ok(ab(alice, "task", "add", "Search", "--criteria", "Finds", "--actor", "alice", "--scope", "search"));
  ok(ab(alice, "task", "note", shared.id, "PR #3 open", "--actor", "alice"));
  ok(ab(bob, "task", "add", "Cart", "--criteria", "Holds", "--actor", "bob", "--scope", "cart"));
  ok(ab(bob, "finding", "add", shared.id, "Rounding is off", "--by", "bob"));
  ok(ab(alice, "sync"));
  const r = ok(ab(bob, "sync"));
  assert.equal(r.pulled > 0, true);
  ok(ab(alice, "sync"));
  for (const dir of [alice, bob]) {
    assert.deepEqual(titles(dir), ["Cart", "Checkout", "Search", "Wishlist"]);
    const t2 = c.task(dir, shared.id);
    assert.equal(t2.note.text, "PR #3 open", "both people's changes to one task are kept");
    assert.equal(t2.findings.length, 2);
  }
  git(bob, ["checkout", "-q", "-b", "feature/x"]);
  assert.deepEqual(titles(bob), ["Cart", "Checkout", "Search", "Wishlist"], "switching code branches does not change the board");
  assert.equal(git(alice, ["status", "--porcelain"]), "", "record changes never show up in the code checkout");
  assert.doesNotMatch(git(alice, ["log", "--format=%s", "main"]), /agentbridge: record/, "record commits stay off code branches");
});

test("record commits do not run code hooks, and a fresh team gets the records branch from the start", (t) => {
  const origin = path.join(tmp(t, "agentbridge-sync-origin-"), "o.git");
  git(path.dirname(origin), ["init", "-q", "--bare", "-b", "main", origin]);
  const alice = clone(t, origin, "alice");
  git(alice, ["commit", "-q", "--allow-empty", "-m", "init"]);
  git(alice, ["push", "-q", "origin", "main"]);
  fs.writeFileSync(path.join(alice, ".git/hooks/pre-commit"), "#!/bin/sh\necho code hook ran >&2\nexit 1\n", { mode: 0o755 });
  const fresh = ok(ab(alice, "sync", "--init"));
  assert.equal(fresh.removedFromCode, false);
  ok(ab(alice, "task", "add", "Search", "--criteria", "Finds", "--actor", "alice"));
  const r = ab(alice, "sync");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /code hook ran/);
  const bob = clone(t, origin, "bob");
  ok(ab(bob, "sync", "--init"));
  assert.deepEqual(titles(bob), ["Search"]);
  assert.match(ok(ab(bob, "board")), /Records synced at .* via agentbridge-records/);
  ok(ab(bob, "task", "add", "Cart", "--criteria", "Holds", "--actor", "bob"));
  assert.match(ok(ab(bob, "board")), /Records: 1 change\(s\) not yet shared; run agentbridge sync/);
});

test("changes sync on their own unless turned off", async (t) => {
  const origin = path.join(tmp(t, "agentbridge-sync-origin-"), "o.git");
  git(path.dirname(origin), ["init", "-q", "--bare", "-b", "main", origin]);
  const alice = clone(t, origin, "alice", { auto: true });
  git(alice, ["commit", "-q", "--allow-empty", "-m", "init"]);
  git(alice, ["push", "-q", "origin", "main"]);
  ok(ab(alice, "sync", "--init"));
  const task = ok(ab(alice, "task", "add", "Search", "--criteria", "Finds", "--actor", "alice"));
  const onRemote = () => spawnSync("git", ["ls-tree", "-r", "--name-only", "agentbridge-records"], { cwd: origin, encoding: "utf8" }).stdout.includes(`${task.id}.json`);
  for (let i = 0; i < 100 && !onRemote(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(onRemote(), "the new task reached the remote without running sync");
});

test("team onboard creates the records branch for the first person and joins it for the next", (t) => {
  const origin = path.join(tmp(t, "agentbridge-sync-origin-"), "o.git");
  git(path.dirname(origin), ["init", "-q", "--bare", "-b", "main", origin]);
  const alice = clone(t, origin, "alice"), home = tmp(t, "agentbridge-sync-home-");
  git(alice, ["commit", "-q", "--allow-empty", "-m", "init"]);
  git(alice, ["push", "-q", "origin", "main"]);
  const records = (dir) =>
    JSON.parse(spawnSync(process.execPath, [bin, "onboard", "--json"], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: home, AGENTBRIDGE_GH_BIN: "/nonexistent/gh" } }).stdout).steps.find((x) => x.step === "records");
  assert.deepEqual(records(alice), { step: "records", state: "done", detail: "shared through origin/agentbridge-records (new, pushed); syncs on its own" });
  ok(ab(alice, "task", "add", "Search", "--criteria", "Finds", "--actor", "alice"));
  ok(ab(alice, "sync"));
  const bob = clone(t, origin, "bob");
  assert.match(records(bob).detail, /joined existing records/);
  assert.deepEqual(titles(bob), ["Search"]);
  assert.equal(records(bob).state, "already");
  assert.equal(git(bob, ["status", "--porcelain"]), "", "nothing to commit in the code branch");
});

test("a rewritten records history is refused until a person accepts it, and nothing is lost", (t) => {
  const origin = path.join(tmp(t, "agentbridge-sync-origin-"), "o.git");
  git(path.dirname(origin), ["init", "-q", "--bare", "-b", "main", origin]);
  const alice = clone(t, origin, "alice");
  git(alice, ["commit", "-q", "--allow-empty", "-m", "init"]);
  git(alice, ["push", "-q", "origin", "main"]);
  ok(ab(alice, "sync", "--init"));
  ok(ab(alice, "task", "add", "Search", "--criteria", "Finds", "--actor", "alice"));
  ok(ab(alice, "sync"));
  const bob = clone(t, origin, "bob");
  ok(ab(bob, "sync", "--init"));
  ok(ab(bob, "task", "add", "Cart", "--criteria", "Holds", "--actor", "bob"));
  ok(ab(bob, "sync"));
  const attacker = clone(t, origin, "mallory");
  git(attacker, ["fetch", "-q", "origin", "agentbridge-records"]);
  const root = git(attacker, ["rev-list", "--max-parents=0", "FETCH_HEAD"]).trim();
  git(attacker, ["push", "-q", "-f", "origin", `${root}:refs/heads/agentbridge-records`]);
  s.forgetRoot(bob);
  ok(ab(bob, "task", "note", c.tasks(bob).find((x) => x.title === "Cart").id, "still here", "--actor", "bob"));
  const refused = ab(bob, "sync");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /history was rewritten/);
  assert.match(refused.stderr, /Nothing was merged/);
  assert.deepEqual(titles(bob), ["Cart", "Search"], "local records are untouched");
  ok(ab(bob, "sync", "--accept-rewrite"));
  ok(ab(alice, "sync", "--accept-rewrite"));
  assert.deepEqual(titles(alice), ["Cart", "Search"], "records the rewrite dropped are pushed back");
  ok(ab(alice, "sync"));
});

function fakeGh(t, { admin = true, latest = "9.0.0" } = {}) {
  const d = tmp(t, "agentbridge-fakegh-"), gh = path.join(d, "gh"), log = path.join(d, "log"), state = path.join(d, "rulesets");
  fs.writeFileSync(`${gh}.cjs`, `const fs = require("fs"), a = process.argv.slice(2), j = a.join(" ");
fs.appendFileSync(${JSON.stringify(log)}, j + "\\n");
if (j.includes("contents/package.json")) process.stdout.write(JSON.stringify({ version: ${JSON.stringify(latest)} }));
else if (j.includes("rulesets --jq")) process.stdout.write(fs.existsSync(${JSON.stringify(state)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8")).name + "\\n" : "");
else if (j.includes("-X POST")) fs.writeFileSync(${JSON.stringify(state)}, fs.readFileSync(0, "utf8"));
else if (j.includes(".permissions.admin")) process.stdout.write(${JSON.stringify(String(admin))} + "\\n");
else if (j.startsWith("api user")) process.stdout.write("alice 1001\\n");
else process.exit(1);`);
  fs.writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${gh}.cjs" "$@"\n`, { mode: 0o755 });
  return { gh, log, state };
}

test("one onboard moves in-repo records, protects the records branch once, and says when an update exists", (t) => {
  const { origin } = team(t);
  const alice = clone(t, origin, "alice"), home = tmp(t, "agentbridge-sync-home-");
  const onboard = (gh) => {
    const r = spawnSync(process.execPath, [bin, "onboard", "--json"], { cwd: alice, encoding: "utf8", env: { ...process.env, HOME: home, AGENTBRIDGE_GH_BIN: gh } });
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(JSON.parse(r.stdout).steps.map((x) => [x.step, x]));
  };
  const first = onboard(fakeGh(t).gh);
  assert.match(first.records.detail, /^moved to origin\/agentbridge-records; syncs on its own\. Commit the removal/);
  assert.ok(!fs.existsSync(path.join(alice, ".agentbridge")));
  assert.match(git(alice, ["status", "--porcelain"]), /^D  \.agentbridge\/project\.json$/m);
  assert.deepEqual(titles(alice), ["Checkout"]);
  assert.equal(first["records branch protection"].state, "skipped", "a local remote is not GitHub");

  git(alice, ["remote", "set-url", "origin", "https://github.com/acme/shop.git"]);
  const viewer = fakeGh(t, { admin: false });
  assert.match(onboard(viewer.gh)["records branch protection"].detail, /ask a repository admin/);
  assert.ok(!fs.existsSync(viewer.state), "nothing is created without admin rights");

  const owner = fakeGh(t, { latest: "9.0.0" });
  const second = onboard(owner.gh);
  assert.equal(second["records branch protection"].state, "done");
  const created = JSON.parse(fs.readFileSync(owner.state, "utf8"));
  assert.deepEqual(created.rules.map((r) => r.type), ["deletion", "non_fast_forward"]);
  assert.deepEqual(created.conditions.ref_name.include, ["refs/heads/agentbridge-records"]);
  assert.equal(created.bypass_actors, undefined, "no one can bypass it");
  assert.match(second.version.detail, /9\.0\.0 is available: npm install -g github:koda-ai-studio\/agentbridge/);
  assert.equal(onboard(owner.gh)["records branch protection"].state, "already");
  assert.equal(fs.readFileSync(owner.log, "utf8").split("\n").filter((l) => l.includes("-X POST")).length, 1, "created once");
  assert.match(onboard(fakeGh(t, { latest: "0.0.1" }).gh).version.detail, /, the latest$/);
});

test("a claim pulls others' claims first when records are over a minute old; offline it warns instead", (t) => {
  const origin = path.join(tmp(t, "agentbridge-sync-origin-"), "o.git");
  git(path.dirname(origin), ["init", "-q", "--bare", "-b", "main", origin]);
  const alice = clone(t, origin, "alice"), bob = clone(t, origin, "bob", { auto: true });
  git(alice, ["commit", "-q", "--allow-empty", "-m", "init"]);
  git(alice, ["push", "-q", "origin", "main"]);
  ok(ab(alice, "sync", "--init"));
  git(bob, ["pull", "-q", "origin", "main"]);
  ok(ab(bob, "sync", "--init"));
  ok(ab(alice, "task", "add", "Pay", "--criteria", "Pays", "--actor", "alice", "--scope", "src/pay.js"));
  ok(ab(alice, "sync"));
  const last = path.join(git(bob, ["rev-parse", "--git-common-dir"]).replace(/^(?!\/)/, `${bob}/`), "agentbridge-records", "local", "last-sync");
  fs.writeFileSync(last, "2026-01-01T00:00:00.000Z");
  const r = ab(bob, "task", "add", "Also pay", "--criteria", "Pays", "--actor", "bob", "--scope", "src");
  assert.equal(r.status, 0, "overlapping claims are not refused by default");
  assert.match(r.stdout, /"event": "overlap"[\s\S]*"owner": "alice"/, "bob's stale clone learned of alice's claim before claiming");

  git(bob, ["remote", "set-url", "origin", path.join(os.tmpdir(), "agentbridge-missing-remote.git")]);
  fs.writeFileSync(last, "2026-01-01T00:00:00.000Z");
  const offline = ab(bob, "task", "add", "Docs", "--criteria", "ok", "--actor", "bob", "--scope", "docs");
  assert.equal(offline.status, 0, offline.stderr);
  assert.match(offline.stderr, /Could not sync records .*last synced 2026-01-01.*Someone elsewhere may already hold these files/);
});
