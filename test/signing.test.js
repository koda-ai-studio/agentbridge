import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as c from "../lib/core.js";
import { git } from "../lib/git.js";
import { prState } from "../lib/team.js";

const bin = path.resolve("bin/agentbridge.js");
function world(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-sign-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  git(cwd, ["config", "user.name", "Test"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  git(cwd, ["commit", "-q", "--allow-empty", "-m", "init"]);
  c.init(cwd);
  const key = (name) => {
    const f = path.join(root, name);
    assert.equal(spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", f]).status, 0);
    return f;
  };
  const alice = key("alice"), other = key("other");
  const gh = path.join(root, "gh");
  fs.writeFileSync(gh, `#!${process.execPath}
const a = process.argv.slice(2).join(" ");
if (a === "api user/1001 --jq .login") console.log("alice-gh");
else if (a === "api users/alice-gh/ssh_signing_keys --jq .[].key") console.log(require("fs").readFileSync(process.env.FAKE_KEYS, "utf8").trim().split(" ").slice(0, 2).join(" "));
else process.exit(1);
`, { mode: 0o755 });
  fs.renameSync(gh, `${gh}.cjs`);
  fs.writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${gh}.cjs" "$@"\n`, { mode: 0o755 });
  git(cwd, ["config", "agentbridge.githubId", "1001"]);
  git(cwd, ["config", "gpg.format", "ssh"]);
  git(cwd, ["config", "user.signingkey", alice]);
  const run = (env, ...args) =>
    spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", timeout: 30000, env: { ...process.env, AGENTBRIDGE_GH_BIN: gh, FAKE_KEYS: `${alice}.pub`, ...env } });
  return { cwd, alice, other, run };
}
const ok = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : r.stdout;
};
const decisionFile = (cwd, id) => path.join(cwd, ".agentbridge/project-decisions", `${id}.json`);

test("approvals are signed with the person's Git SSH key and verified against their GitHub signing keys", (t) => {
  const { cwd, other, run } = world(t);
  const d = ok(run({}, "decision", "propose", "Mobile first", "--why", "Phones", "--actor", "alice"));
  const accepted = run({}, "decision", "accept", d.id, "--actor", "alice");
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.doesNotMatch(accepted.stderr, /unsigned/);
  const e = JSON.parse(accepted.stdout).history.at(-1);
  assert.match(e.sig.key, /^SHA256:/);
  assert.equal(e.sig.type, "ED25519");
  assert.match(e.sig.signature, /BEGIN SSH SIGNATURE/);
  assert.equal(JSON.parse(accepted.stdout).history[0].sig, undefined, "only approvals are signed");
  const checked = ok(run({}, "approvals", "--verify", "--json"));
  assert.deepEqual(
    checked.approvals.map(({ event, state, login, presence }) => ({ event, state, login, presence })),
    [{ event: "decision_accepted", state: "verified", login: "alice-gh", presence: false }],
  );
  const notOnGithub = run({ FAKE_KEYS: `${other}.pub` }, "approvals", "--verify", "--json");
  assert.equal(notOnGithub.status, 1, "a key the person never registered on GitHub does not verify");
  assert.equal(JSON.parse(notOnGithub.stdout).approvals[0].state, "invalid");
  const record = JSON.parse(fs.readFileSync(decisionFile(cwd, d.id), "utf8"));
  record.history.at(-1).actor = "mallory";
  fs.writeFileSync(decisionFile(cwd, d.id), JSON.stringify(record));
  const tampered = run({}, "approvals", "--verify");
  assert.equal(tampered.status, 1, "editing a signed approval breaks it");
  assert.match(tampered.stdout, /✗ .*invalid/);
});

test("a project can require signed approvals; without a key nothing is approved", (t) => {
  const { cwd, run } = world(t);
  const policy = ok(run({}, "policy", "signed-approvals", "required", "--actor", "alice"));
  assert.deepEqual([policy.signedApprovals, policy.signed], ["required", true], "the policy change is itself a signed approval");
  git(cwd, ["config", "--unset", "user.signingkey"]);
  const d = ok(run({}, "decision", "propose", "Dark mode", "--why", "Night", "--actor", "alice"));
  const refused = run({}, "decision", "accept", d.id, "--actor", "alice");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires signed approvals/);
  assert.equal(c.projectDecisions(cwd).find((x) => x.id === d.id).status, "proposed");
  git(cwd, ["config", "user.signingkey", "/nonexistent/key"]);
  const broken = run({}, "decision", "accept", d.id, "--actor", "alice");
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /Signing failed, approval not recorded/);
  assert.equal(c.projectDecisions(cwd).find((x) => x.id === d.id).status, "proposed", "a failed signature records nothing");
  assert.match(ok(run({}, "approvals")), /signatures required[\s\S]*policy_changed/);
});

test("without a signing key and no policy, approvals still work and are marked unsigned", (t) => {
  const { cwd, run } = world(t);
  git(cwd, ["config", "--unset", "gpg.format"]);
  const d = ok(run({}, "decision", "propose", "Tabs", "--why", "Style", "--actor", "alice"));
  const r = run({}, "decision", "accept", d.id, "--actor", "alice");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /approval recorded unsigned/);
  assert.match(ok(run({}, "approvals")), /– .*unsigned .*alice .*decision_accepted .*Tabs/);
});

test("onboard reports whether the signing key is registered on GitHub and whether it needs a touch", (t) => {
  const { cwd, other, run } = world(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-sign-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const signingStep = (env) => JSON.parse(run({ HOME: home, ...env }, "onboard", "--solo", "--dry-run", "--json").stdout).steps.find((x) => x.step === "approval signing");
  const good = signingStep({});
  assert.equal(good.state, "already");
  assert.match(good.detail, /^SHA256:\S+ \(ED25519\), registered on GitHub; no touch required/);
  const bad = signingStep({ FAKE_KEYS: `${other}.pub` });
  assert.equal(bad.state, "needs-you");
  assert.match(bad.detail, /not one of your GitHub SSH signing keys/);
  git(cwd, ["config", "--unset", "gpg.format"]);
  assert.equal(signingStep({}).state, "skipped");
});

test("PR status fails a required acceptance unless its signature verifies", () => {
  const done = { task: { effectiveStatus: "done", acceptance: { actor: "alice" } }, verified: { revision: "a".repeat(40) }, open: [] };
  const head = "a".repeat(40);
  assert.deepEqual(prState(done, head, { required: true, state: "verified", login: "alice-gh" }), ["success", "Verified and accepted by alice (signed by alice-gh)"]);
  assert.deepEqual(prState(done, head, { required: true, state: "unsigned" }), ["failure", "Acceptance signature unsigned"]);
  assert.deepEqual(prState(done, head, { required: true, state: "invalid", reason: "bad sig" }), ["failure", "Acceptance signature invalid: bad sig"]);
  assert.deepEqual(prState(done, head, { required: false, state: "unsigned" }), ["success", "Verified and accepted by alice"]);
});
