import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as c from "./core.js";
import * as team from "./team.js";
import { preEdit } from "./agents.js";
import { git } from "./git.js";
import { setProvenance } from "./store.js";

export function demo({ print = console.log, keep = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-demo-")));
  const as = (agent, branch) => setProvenance({ via: "agent", agent, branch });
  const step = (n, text) => print(`\n${n}. ${text}`);
  const show = (text) => print(text.split("\n").map((l) => `     ${l}`).join("\n"));
  try {
    git(dir, ["init", "-q", "-b", "main"]);
    for (const [k, v] of [["user.name", "Demo"], ["user.email", "demo@example.invalid"], ["commit.gpgsign", "false"]]) git(dir, ["config", k, v]);
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src/cart.js"), "export const total = (items) => items.reduce((s, i) => s + i.price, 0);\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "Shop app"]);
    c.init(dir);
    print("AgentBridge demo in a throwaway repository: Claude starts a fix, Codex is told whose file it is, then picks it up without anyone re-explaining it.");

    as("claude", "feat/cart");
    git(dir, ["checkout", "-q", "-b", "feat/cart"]);
    const t = c.addTask(dir, "Fix cart totals", "Totals include tax once; Tests pass", "claude", ["src/cart.js"], "", { exclusive: true });
    c.setStatus(dir, t.id, "in_progress", "claude");
    step(1, 'Claude starts "Fix cart totals" and claims src/cart.js (its skill does this before editing).');

    const blocked = preEdit({ cwd: dir, tool_name: "Edit", tool_input: { file_path: path.join(dir, "src/cart.js") } }, "codex");
    step(2, `Codex tries to edit src/cart.js in parallel. Its pre-edit hook ${blocked.exit === 2 ? "refuses" : "tells it, before the edit"}:`);
    show(blocked.message || blocked.context);

    fs.writeFileSync(path.join(dir, "src/cart.js"), "export const total = (items, tax = 0.1) => items.reduce((s, i) => s + i.price * (1 + tax) * (1 + tax), 0);\n");
    git(dir, ["commit", "-qam", "Apply tax to totals"]);
    c.note(dir, t.id, "claude", "Tax applied, but twice; PR not opened yet");
    c.reportFinding(dir, t.id, "Tax is applied twice in total()", "claude");
    step(3, "Claude commits on feat/cart, notes where it stopped and records the bug it found. Its session ends.");

    as("claude", "main");
    git(dir, ["checkout", "-q", "main"]);
    c.offer(dir, t.id, "claude", "codex", "Apply tax once in total(), then run the tests");
    step(4, "You ask Claude to hand the task to Codex. It offers it with the next step.");

    as("codex", "main");
    c.receive(dir, t.id, "codex");
    step(5, "Codex accepts. Instead of a chat transcript it gets this:");
    show(team.resumeText(team.resume(dir, t.id, { merged: null })));

    const now = preEdit({ cwd: dir, tool_name: "Edit", tool_input: { file_path: path.join(dir, "src/cart.js") } }, "codex");
    step(6, `Codex edits src/cart.js: ${now.exit === 0 && !now.context ? "no warning, the task is its now" : "still flagged (unexpected)"}.`);

    print(`\nThat was ${dir}${keep ? " (kept; explore it with agentbridge board there)" : " (deleted)"}. Nothing in your own repositories changed.`);
    print("Set up a real repository: cd your-repo && agentbridge onboard (alone with your agents: agentbridge onboard --solo)");
    return { dir, warned: Boolean(blocked.context || blocked.exit === 2), allowedAfter: now.exit === 0 && !now.context, task: t.id };
  } finally {
    setProvenance(null);
    if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  }
}
