import { execSync } from "child_process";
import type { ToolSchema } from "../llm/types";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class ShellTool {
  constructor(private readonly workspaceRoot: string) {}

  /**
   * Executes a shell command inside the workspace root directory.
   * Execution options include safeguards against infinite loops and buffer overflows.
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
}

export const shellToolSchema: ToolSchema = {
  name: "run_command",
  description:
    "Propose running a shell command in the project root (e.g. npm test, tsc --noEmit, git diff). Requires explicit user approval before execution.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The exact shell command to run" },
      reason: { type: "string", description: "Why this command is needed" },
    },
    required: ["command"],
  },
};