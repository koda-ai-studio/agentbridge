import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gh } from "./github.js";
import * as s from "./store.js";

export const namespace = "agentbridge-approval";
export const approvalEvents = new Set(["decision_accepted", "human_accepted", "merge_resolved", "policy_changed"]);

const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
};

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function message(record, e) {
  const { sig, ...event } = e;
  return `${namespace} v1\n${canonical({ record, event })}\n`;
}

export function signingKey(cwd) {
  const own = git(cwd, ["config", "--get", "agentbridge.signingKey"]);
  if (own) return own;
  if (git(cwd, ["config", "--get", "gpg.format"]) === "ssh") return git(cwd, ["config", "--get", "user.signingkey"]) || null;
  return null;
}

export const required = (cwd) => s.read(path.join(s.root(cwd), "project.json")).signedApprovals === "required";

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-sig-"));
}

function keyFile(key, dir) {
  const literal = key.startsWith("key::") ? key.slice(5) : /^(ssh-|sk-|ecdsa-)/.test(key) ? key : null;
  if (!literal) return key.replace(/^~(?=\/)/, os.homedir());
  const f = path.join(dir, "key.pub");
  fs.writeFileSync(f, `${literal}\n`);
  return f;
}

function ssh(args, input) {
  const r = spawnSync("ssh-keygen", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 120000 });
  if (r.error) throw Error(`ssh-keygen unavailable: ${r.error.message}`);
  return r;
}

export function fingerprint(key) {
  const dir = scratch();
  try {
    const r = ssh(["-l", "-f", keyFile(key, dir)]);
    if (r.status !== 0) throw Error(`Cannot read signing key ${key}: ${(r.stderr || r.stdout).trim()}`);
    const [, fp, ...rest] = r.stdout.trim().split(" ");
    const type = rest.at(-1).replace(/[()]/g, "");
    return { key: fp, type, presence: /-SK$/.test(type) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function sign(cwd, text) {
  const key = signingKey(cwd);
  if (!key) throw Error("No signing key: set git config gpg.format ssh and user.signingkey, or agentbridge.signingKey");
  const dir = scratch();
  try {
    const r = ssh(["-Y", "sign", "-f", keyFile(key, dir), "-n", namespace], text);
    if (r.status !== 0 || !r.stdout.includes("BEGIN SSH SIGNATURE"))
      throw Error(`Signing failed, approval not recorded: ${(r.stderr || r.stdout).trim()}`);
    const { key: fp, type } = fingerprint(key);
    return { key: fp, type, signature: r.stdout.trim() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function signer(cwd) {
  return (record, e) => (approvalEvents.has(e.event) ? sign(cwd, message(record, e)) : null);
}

export function githubSigners(cwd, githubId, cache = new Map()) {
  if (!cache.has(githubId)) {
    const login = gh(cwd, ["api", `user/${githubId}`, "--jq", ".login"]).trim();
    const keys = gh(cwd, ["api", `users/${login}/ssh_signing_keys`, "--jq", ".[].key"]).split("\n").map((k) => k.trim()).filter(Boolean);
    cache.set(githubId, { login, keys });
  }
  return cache.get(githubId);
}

export function verifyEvent(cwd, record, e, cache = new Map()) {
  if (!e.sig) return { state: "unsigned" };
  if (!e.by?.github) return { state: "invalid", reason: "signed without a GitHub id" };
  let found;
  try {
    found = githubSigners(cwd, e.by.github, cache);
  } catch (err) {
    return { state: "unchecked", reason: err.message };
  }
  if (!found.keys.length) return { state: "invalid", login: found.login, reason: `${found.login} has no SSH signing keys on GitHub` };
  const dir = scratch();
  try {
    const allowed = path.join(dir, "allowed"), sig = path.join(dir, "sig");
    fs.writeFileSync(allowed, found.keys.map((k) => `${found.login} namespaces="${namespace}" ${k}`).join("\n") + "\n");
    fs.writeFileSync(sig, `${e.sig.signature}\n`);
    const r = ssh(["-Y", "verify", "-f", allowed, "-I", found.login, "-n", namespace, "-s", sig], message(record, e));
    return r.status === 0
      ? { state: "verified", login: found.login, presence: /-SK$/i.test(e.sig.type || "") }
      : { state: "invalid", login: found.login, reason: (r.stderr || r.stdout).trim().split("\n")[0] };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
