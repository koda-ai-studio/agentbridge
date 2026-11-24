import { spawn } from "node:child_process";
// No shell interpolation. Bounded output and process-group cancellation on POSIX.
export function runProcess(
  command,
  args,
  { cwd, input = "", timeoutMs = 120000, maxBytes = 2 * 1024 * 1024 } = {},
) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "",
      stderr = "",
      size = 0,
      reason = null,
      settled = false,
      timer,
      killTimer;
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false,
    });
    const kill = () => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const stop = (r) => {
      if (!reason) reason = r;
      kill();
      killTimer ??= setTimeout(() => finish(null, "SIGKILL"), 1000);
    };
    const signal = () => stop("cancelled");
    function finish(exitCode, signalName) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.removeListener("SIGINT", signal);
      process.removeListener("SIGTERM", signal);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal: signalName,
        reason,
        durationMs: Date.now() - started,
      });
    }
    process.on("SIGINT", signal);
    process.on("SIGTERM", signal);
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    child.on("error", (e) => {
      reason = e.code || "spawn-error";
      finish(null, null);
    });
    for (const [stream, name] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ])
      stream.on("data", (b) => {
        size += b.length;
        if (size > maxBytes) {
          stop("output-limit");
          return;
        }
        if (name === "stdout") stdout += b.toString();
        else stderr += b.toString();
      });
    child.on("close", finish);
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
