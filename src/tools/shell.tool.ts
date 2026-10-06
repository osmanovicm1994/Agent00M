import { execSync, spawn } from "child_process";
import type { ToolSchema } from "../llm/types";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellRunResult {
  // stdout and stderr interleaved in the order they were printed (what a terminal shows).
  output: string;
  exitCode: number;
  // The process was still running when the time limit hit and was stopped.
  // For a dev server or watcher that usually means "it started and kept running".
  timedOut: boolean;
}

const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 180_000;
const DEFAULT_TIMEOUT_MS = 30_000;
// Only the beginning and the end of a long output are kept: the root error is usually
// near the start, the final failure and stack trace near the end.
const HEAD_KEEP = 20_000;
const TAIL_KEEP = 60_000;

export function clampTimeoutMs(seconds: unknown): number {
  const n = typeof seconds === "number" ? seconds : Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(n * 1000, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/** Shortens a long command output to its head and tail for the model. */
export function condenseOutput(output: string, maxChars = 8000): string {
  if (output.length <= maxChars) return output;
  const head = Math.floor(maxChars * 0.25);
  const tail = maxChars - head;
  return `${output.slice(0, head)}\n[... ${output.length - maxChars} characters omitted from the middle ...]\n${output.slice(-tail)}`;
}

export class ShellTool {
  constructor(private readonly workspaceRoot: string) {}

  /**
   * Executes a shell command inside the workspace root directory (blocking).
   * Used by the non-interactive ToolDispatcher; the agent loop uses runAsync.
   */
  run(command: string, timeoutMs = 30000): ShellResult {
    try {
      const stdout = execSync(command, {
        cwd: this.workspaceRoot,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        stdio: ["ignore", "pipe", "pipe"],
      });

      return {
        stdout: stdout || "",
        stderr: "",
        exitCode: 0,
      };
    } catch (err: any) {
      const stdout = err.stdout?.toString() ?? "";
      let stderr = err.stderr?.toString() ?? "";

      if (err.code === "ETIMEDOUT") {
        stderr = `Command timed out after ${timeoutMs / 1000} seconds.\n${stderr}`;
      } else if (!stderr) {
        stderr = err.message || "Command execution failed.";
      }

      return {
        stdout,
        stderr,
        exitCode: typeof err.status === "number" ? err.status : 1,
      };
    }
  }

  /**
   * Runs a command and streams its output through `onChunk` while it runs.
   *
   * - stdout and stderr are interleaved, like in a terminal.
   * - On timeout the WHOLE process group is stopped, not just the shell: `npm run dev`
   *   starts child processes, and killing only the parent would leave a server holding
   *   the port and make the next attempt fail with EADDRINUSE.
   * - stdin is closed, so a command that asks a question fails fast instead of hanging.
   */
  runAsync(command: string, timeoutMs = DEFAULT_TIMEOUT_MS, onChunk?: (text: string) => void): Promise<ShellRunResult> {
    return new Promise((resolve) => {
      const isWindows = process.platform === "win32";
      const child = spawn(command, {
        cwd: this.workspaceRoot,
        shell: true,
        detached: !isWindows,
        stdio: ["ignore", "pipe", "pipe"],
        // Colors only add escape codes to what the model has to read.
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      });

      let head = "";
      let tail = "";
      let total = 0;
      let timedOut = false;
      let settled = false;

      const add = (buf: Buffer) => {
        const text = buf.toString("utf8");
        total += text.length;
        if (head.length < HEAD_KEEP) head += text.slice(0, HEAD_KEEP - head.length);
        tail += text;
        if (tail.length > TAIL_KEEP * 2) tail = tail.slice(-TAIL_KEEP);
        onChunk?.(text);
      };
      child.stdout?.on("data", add);
      child.stderr?.on("data", add);

      const collect = (): string => {
        // `tail` only drops text once it has outgrown 2 * TAIL_KEEP; until then it IS the whole output.
        if (tail.length === total) return tail.trim();
        const keptTail = tail.slice(-TAIL_KEEP);
        const omitted = total - head.length - keptTail.length;
        return `${head}\n[... ${omitted} characters omitted ...]\n${keptTail}`.trim();
      };

      const killGroup = (signal: NodeJS.Signals) => {
        try {
          if (!isWindows && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // already gone
        }
      };

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ output: collect(), exitCode, timedOut });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        // A server that ignores SIGTERM is forced down; 'close' may never fire for it.
        setTimeout(() => killGroup("SIGKILL"), 3_000);
        setTimeout(() => finish(1), 5_000);
      }, timeoutMs);

      child.on("error", (err) => {
        add(Buffer.from(`Failed to start the command: ${err.message}\n`));
        finish(1);
      });
      child.on("close", (code, signal) => finish(typeof code === "number" ? code : signal ? 1 : 0));
    });
  }
}

export const shellToolSchema: ToolSchema = {
  name: "run_command",
  description:
    "Propose running a shell command in the project root (e.g. npm test, tsc --noEmit, git diff, npm run dev). Requires explicit user approval before execution. " +
    "Returns the combined output and exit code. For servers and watchers that never exit, set timeout_seconds (5-180): when it expires the process is stopped and timedOut is true.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The exact shell command to run" },
      reason: { type: "string", description: "Why this command is needed" },
      timeout_seconds: {
        type: "number",
        description: "Max run time in seconds (default 30, max 180). Use 40-90 for dev servers and slow builds.",
      },
    },
    required: ["command"],
  },
};
