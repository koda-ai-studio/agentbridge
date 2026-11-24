import path from "node:path";
import fs from "node:fs";
import { atomic } from "./store.js";
import { spawnSync } from "node:child_process";
import { runProcess } from "./process.js";
export const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary", "findings"],
  properties: {
    outcome: {
      type: "string",
      enum: ["pass", "needs_work"],
      description:
        "Use pass only with an empty findings array. If any actionable finding remains, use needs_work. Review is separate from test verification.",
    },
    summary: { type: "string" },
    findings: {
      type: "array",
      description:
        "Actionable defects or unmet implementation requirements only. Must be empty for pass and nonempty for needs_work. Put optional suggestions and pending test-execution caveats in summary, not findings.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "severity"],
        properties: {
          description: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
  },
};
export function validateReview(value) {
  if (
    !value ||
    !["pass", "needs_work"].includes(value.outcome) ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.findings) ||
    value.findings.some(
      (f) =>
        !f ||
        typeof f.description !== "string" ||
        !f.description.trim() ||
        !["low", "medium", "high"].includes(f.severity),
    )
  )
    throw Error("Malformed structured review");
  if (value.outcome === "pass" && value.findings.length)
    throw Error("Passing review cannot contain unresolved findings");
  if (value.outcome === "needs_work" && !value.findings.length)
    throw Error("Needs-work review requires actionable findings");
  return value;
}
export const defaultTimeouts = { implement: 1800000, review: 600000 };
export const maxProviderTimeout = 7200000;
export function providerTimeout(kind, value) {
  if (value === undefined || value === null || value === "")
    return defaultTimeouts[kind];
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 1000 || ms > maxProviderTimeout)
    throw Error(`Timeout must be 1000..${maxProviderTimeout} ms`);
  return ms;
}
const bundled = {
  codex: ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"],
  claude: [],
};
const executable = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
export function resolveBinary(provider, env = process.env) {
  const override = env[`AGENTBRIDGE_${provider.toUpperCase()}_BIN`];
  if (override) {
    if (!path.isAbsolute(override) || !executable(override))
      throw Error(
        `AGENTBRIDGE_${provider.toUpperCase()}_BIN must be an absolute path to an executable`,
      );
    return override;
  }
  for (const dir of (env.PATH || "").split(path.delimiter).filter(Boolean))
    if (executable(path.join(dir, provider))) return provider;
  return bundled[provider].find(executable) || provider;
}
export function providerCommand(provider, kind, dir, env = process.env) {
  if (!["claude", "codex"].includes(provider))
    throw Error("Provider must be claude or codex");
  const bin = resolveBinary(provider, env);
  if (provider === "codex") {
    const args = [
      "exec",
      "--sandbox",
      kind === "review" ? "read-only" : "workspace-write",
      "--ephemeral",
      "--color",
      "never",
      "--output-last-message",
      path.join(dir, "final.txt"),
    ];
    if (kind === "review") {
      atomic(path.join(dir, "schema.json"), reviewSchema);
      args.push("--output-schema", path.join(dir, "schema.json"));
    }
    args.push("-");
    return { command: bin, args };
  }
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--tools",
    kind === "review" ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write",
    "--allowedTools",
    kind === "review" ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write",
  ];
  if (kind === "review")
    args.push("--json-schema", JSON.stringify(reviewSchema));
  return { command: bin, args };
}
export async function invokeProvider(
  { provider, kind, cwd, prompt, artifactDir, timeoutMs },
  execute = runProcess,
) {
  const { command, args } = providerCommand(provider, kind, artifactDir);
  const processResult = await execute(command, args, {
    cwd,
    input: prompt,
    timeoutMs: providerTimeout(kind, timeoutMs),
  });
  atomic(path.join(artifactDir, "process.json"), processResult);
  if (processResult.reason || processResult.exitCode !== 0)
    throw Error(
      `Provider failed (${processResult.reason || processResult.exitCode}); inspect private process log`,
    );
  let result;
  if (provider === "claude") {
    const envelope = JSON.parse(processResult.stdout);
    if (
      envelope.is_error ||
      (envelope.subtype && envelope.subtype !== "success")
    )
      throw Error("Claude returned an unsuccessful result");
    if (envelope.permission_denials?.length)
      throw Error(
        "Claude reported denied permissions; implementation is incomplete",
      );
    result = kind === "review" ? envelope.structured_output : envelope.result;
  } else {
    const final = fs.readFileSync(path.join(artifactDir, "final.txt"), "utf8");
    result = kind === "review" ? JSON.parse(final) : final;
  }
  if (kind === "review") return validateReview(result);
  if (typeof result !== "string" || !result.trim())
    throw Error("Provider returned no implementation summary");
  return { summary: result };
}
export function doctor(env = process.env) {
  const version = (command) => {
    const r = spawnSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 10000,
      env,
    });
    return r.status === 0 ? r.stdout.trim() : "unavailable";
  };
  const out = { git: version("git") };
  for (const provider of ["claude", "codex"]) {
    let bin;
    try {
      bin = resolveBinary(provider, env);
    } catch (e) {
      out[provider] = `unavailable: ${e.message}`;
      continue;
    }
    const v = version(bin);
    out[provider] = v === "unavailable" || bin === provider ? v : `${v} (${bin})`;
  }
  out.note =
    "Version checks only; they do not establish authentication or live integration success.";
  return out;
}
