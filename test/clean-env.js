import fs from "node:fs";
import os from "node:os";
import path from "node:path";

for (const k of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SANDBOX", "AI_AGENT"]) delete process.env[k];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbridge-gitconfig-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const config = path.join(dir, "config");
fs.writeFileSync(config, "[init]\n\tdefaultBranch = main\n");
process.env.GIT_CONFIG_GLOBAL = config;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.AGENTBRIDGE_GH_BIN ??= "/nonexistent/agentbridge-test-gh";
