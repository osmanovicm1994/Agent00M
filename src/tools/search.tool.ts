import * as fs from "fs";
import * as path from "path";
import type { ToolSchema } from "../llm/types";

const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".agent_cache",
  ".DS_Store",
  "__pycache__",
  ".venv",
  "venv",
  "coverage",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".7z",
  ".mp3", ".mp4", ".wav", ".avi",
  ".ttf", ".woff", ".woff2", ".eot",
  ".db", ".sqlite", ".bin", ".exe", ".dll", ".so", ".dylib",
  ".coverage", ".lock",
]);

// Files bigger than this are skipped by grep (data dumps, bundles, catalogs).
const MAX_GREP_FILE_BYTES = 1_000_000;
const MAX_LINE_CHARS = 2000;

export class SearchTool {
  constructor(private readonly workspaceRoot: string) {}

  /**
   * Recursive filename substring search starting from project root.
   */
  findFiles(query: string, maxResults = 30): string[] {
    const results: string[] = [];
    const lowerQuery = query.toLowerCase();

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
        } else if (query && entry.name.toLowerCase().includes(lowerQuery)) {
          results.push(path.relative(this.workspaceRoot, fullPath));
        }
      }
    };

    walk(this.workspaceRoot);
    return results;
  }

  /**
   * Content search. Safely handles invalid regexes (falls back to a literal,
   * case-insensitive match) and skips binary files and oversized files.
   */
  grep(pattern: string, maxResults = 50): Array<{ file: string; line: number; text: string }> {
    const results: Array<{ file: string; line: number; text: string }> = [];

    let matcher: (text: string) => boolean;
    try {
      const regex = new RegExp(pattern, "i");
      matcher = (text: string) => regex.test(text);
    } catch {
      const lowerPattern = pattern.toLowerCase();
      matcher = (text: string) => text.toLowerCase().includes(lowerPattern);
    }

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
          continue;
        }

        if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

        let content: string;
        try {
          if (fs.statSync(fullPath).size > MAX_GREP_FILE_BYTES) continue;
          content = fs.readFileSync(fullPath, "utf8");
        } catch {
          continue;
        }

        const lines = content.split("\n");
        for (let idx = 0; idx < lines.length; idx++) {
          if (results.length >= maxResults) return;

          const line = lines[idx];
          // Skip minified bundles / source maps.
          if (line.length > MAX_LINE_CHARS) continue;

          if (matcher(line)) {
            results.push({
              file: path.relative(this.workspaceRoot, fullPath),
              line: idx + 1,
              text: line.trim().slice(0, 240),
            });
          }
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
    description: "Search file contents for a regex pattern or literal substring, recursively from the project root.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern or plain string to search for inside file contents" },
      },
      required: ["pattern"],
    },
  },
];
