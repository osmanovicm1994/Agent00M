import { execSync } from "child_process";
import type { ToolSchema } from "../llm/types";

export class ShellTool {
  constructor(private readonly workspaceRoot: string) {}

  // Actually executes the command. Callers (the executor) MUST get user
  // approval before invoking this — this class does not gate anything itself.
  run(command: string): { stdout: string; stderr: string; exitCode: number } {
    try {
      const stdout = execSync(command, {
        cwd: this.workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { stdout, stderr: "", exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? err.message,
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
