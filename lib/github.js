import { spawnSync } from "node:child_process";
import path from "node:path";

export function gh(cwd, args, input) {
  const bin = process.env.AGENTBRIDGE_GH_BIN || "gh";
  if (process.env.AGENTBRIDGE_GH_BIN && !path.isAbsolute(bin)) throw Error("AGENTBRIDGE_GH_BIN must be an absolute path");
  const r = spawnSync(bin, args, { cwd, input, encoding: "utf8", timeout: 60000 });
  if (r.error) throw Error(`GitHub CLI unavailable: ${r.error.message}`);
  if (r.status !== 0) throw Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}
