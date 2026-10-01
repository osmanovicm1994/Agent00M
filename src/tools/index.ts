import { FsTools, fsToolSchemas } from "./fs.tool";
import { SearchTool, searchToolSchemas } from "./search.tool";
import { ShellTool, shellToolSchema } from "./shell.tool";
import type { ToolSchema } from "../llm/types";

/**
 * Combined list of all built-in agent tool schemas (no duplicates:
 * get_directory_tree lives in fsToolSchemas and is workspace-scoped).
 */
export const allToolSchemas: ToolSchema[] = [...fsToolSchemas, ...searchToolSchemas, shellToolSchema];

/**
 * Non-interactive dispatcher for scripts and tests. The interactive agent loop
 * uses core/executor.ts instead, which adds approval prompts and safety gates.
 */
export class ToolDispatcher {
  public readonly fs: FsTools;
  public readonly search: SearchTool;
  public readonly shell: ShellTool;

  constructor(workspaceRoot: string) {
    this.fs = new FsTools(workspaceRoot);
    this.search = new SearchTool(workspaceRoot);
    this.shell = new ShellTool(workspaceRoot);
  }

  /**
   * Dispatches a tool call by name and args, returning stringified output suitable for the LLM.
   */
  async dispatch(name: string, args: Record<string, any>): Promise<string> {
    switch (name) {
      case "read_file":
        return this.fs.readFileSlice(args.path, args.start_line, args.end_line).text;

      case "read_multiple_files":
        return this.fs.readMultipleFiles(args.paths || []);

      case "list_directory": {
        const items = this.fs.listDirectory(args.path || ".");
        return items.map((item) => `${item.isDirectory ? "[DIR]" : "[FILE]"} ${item.name}`).join("\n");
      }

      case "get_directory_tree":
        return this.fs.getDirectoryTree(args.path ?? args.rootDir ?? ".", args.maxDepth || 3);

      case "write_file":
        this.fs.commitWrite(args.path, args.content);
        return `Successfully wrote content to ${args.path}`;

      case "append_file":
        this.fs.appendToFile(args.path, args.content);
        return `Successfully appended content to ${args.path}`;

      case "find_files": {
        const matches = this.search.findFiles(args.query);
        return matches.length > 0 ? matches.join("\n") : `No files found matching query "${args.query}".`;
      }

      case "grep": {
        const matches = this.search.grep(args.pattern);
        if (matches.length === 0) return `No occurrences found for pattern "${args.pattern}".`;
        return matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n");
      }

      case "run_command": {
        const result = this.shell.run(args.command);
        let output = "";
        if (result.stdout) output += `STDOUT:\n${result.stdout}\n`;
        if (result.stderr) output += `STDERR:\n${result.stderr}\n`;
        output += `EXIT CODE: ${result.exitCode}`;
        return output.trim();
      }

      default:
        throw new Error(`Unknown tool execution requested: "${name}"`);
    }
  }
}

export { FsTools, SearchTool, ShellTool };
