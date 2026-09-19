import * as fs from "fs";
import * as path from "path";
import type { ToolSchema } from "../llm/types";

const DEFAULT_IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo"]);

export class SearchTool {
  constructor(private readonly workspaceRoot: string) {}

  // Simple recursive filename glob-ish search (substring match) plus a naive
  // grep. Not meant to replace ripgrep — just enough for an agent to locate
  // relevant files without shelling out (which would need approval).
  findFiles(query: string, maxResults = 30): string[] {
    const results: string[] = [];
    const walk = (dir: string) => {
      if (results.length >= maxResults) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (DEFAULT_IGNORE.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (query && entry.name.toLowerCase().includes(query.toLowerCase())) {
          results.push(path.relative(this.workspaceRoot, fullPath));
        }
      }
    };
    walk(this.workspaceRoot);
    return results;
  }

  grep(pattern: string, maxResults = 50): Array<{ file: string; line: number; text: string }> {
    const regex = new RegExp(pattern, "i");
    const results: Array<{ file: string; line: number; text: string }> = [];
    const walk = (dir: string) => {
      if (results.length >= maxResults) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (DEFAULT_IGNORE.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          let content: string;
          try {
            content = fs.readFileSync(fullPath, "utf8");
          } catch {
            continue;
          }
          const lines = content.split("\n");
          lines.forEach((line, idx) => {
            if (results.length >= maxResults) return;
            if (regex.test(line)) {
              results.push({
                file: path.relative(this.workspaceRoot, fullPath),
                line: idx + 1,
                text: line.trim(),
              });
            }
          });
        }
      }
    };
    walk(this.workspaceRoot);
    return results;
  }
}

export const searchToolSchemas: ToolSchema[] = [
  {
    name: "find_files",
    description: "Find files whose name contains a given substring, searched recursively from the project root.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match against file names" },
      },
      required: ["query"],
    },
  },
  {
    name: "grep",
    description: "Search file contents for a regex pattern, recursively from the project root.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
      },
      required: ["pattern"],
    },
  },
];
