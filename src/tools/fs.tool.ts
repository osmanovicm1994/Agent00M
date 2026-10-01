import * as fs from "fs";
import * as path from "path";
import type { ToolSchema } from "../llm/types";

// All filesystem tools are scoped to a single "workspace root" (the target
// project directory the CLI was invoked against) to prevent an agent from
// reading/writing outside the project it's supposed to be working on.

export const DEFAULT_MAX_READ_CHARS = 40_000;
const MAX_TREE_ENTRIES_PER_DIR = 80;
const MAX_TREE_LINES = 500;

const TREE_IGNORES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  ".turbo",
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

export interface ReadResult {
  text: string;
  // true only when `text` is the ENTIRE file. The executor only lets the model
  // overwrite a file it has fully read, so partial/truncated reads are never
  // treated as "read".
  complete: boolean;
  totalLines: number;
}

export interface TreeResult {
  text: string;
  // Every directory (relative to the workspace root) shown in the tree.
  dirs: string[];
}

export class FsTools {
  private readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = path.resolve(workspaceRoot);
  }

  private resolve(relativePath: string): string {
    const full = path.resolve(this.root, relativePath);
    // path.relative avoids the "/proj" vs "/proj-evil" prefix bypass that a
    // plain startsWith() check allows.
    const rel = path.relative(this.root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Refusing to access path outside workspace: ${relativePath}`);
    }
    return full;
  }

  /** Full, untruncated file content. */
  readFile(relativePath: string): string {
    const full = this.resolve(relativePath);
    if (!fs.existsSync(full)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    return fs.readFileSync(full, "utf8");
  }

  /**
   * Size-capped read with optional 1-based inclusive line range. Keeps huge
   * files from flooding the model's context (which is what makes local models
   * slow), and reports whether the result is the whole file.
   */
  readFileSlice(
    relativePath: string,
    startLine?: number,
    endLine?: number,
    maxChars: number = DEFAULT_MAX_READ_CHARS,
  ): ReadResult {
    const content = this.readFile(relativePath);
    const lines = content.split("\n");
    const totalLines = lines.length;

    const hasRange = startLine !== undefined || endLine !== undefined;
    let text = content;
    let complete = true;

    if (hasRange) {
      const from = Math.max(1, Math.floor(startLine ?? 1));
      const to = Math.min(totalLines, Math.floor(endLine ?? totalLines));
      text = lines
        .slice(from - 1, to)
        .map((l, i) => `${from + i}: ${l}`)
        .join("\n");
      complete = from <= 1 && to >= totalLines;
      if (!complete) {
        text += `\n[showing lines ${from}-${to} of ${totalLines}]`;
      }
    }

    if (text.length > maxChars) {
      text =
        text.slice(0, maxChars) +
        `\n[TRUNCATED at ${maxChars} of ${text.length} chars — file has ${totalLines} lines. ` +
        `Call read_file with start_line/end_line to read the rest.]`;
      complete = false;
    }

    return { text, complete, totalLines };
  }

  /**
   * Batch reader: many files in one call to avoid multi-turn latency.
   * Per-file and total size caps keep the response bounded.
   */
  readMultipleDetailed(
    relativePaths: string[],
    perFileChars = 20_000,
    totalChars = 60_000,
  ): { text: string; fullyRead: string[] } {
    const parts: string[] = [];
    const fullyRead: string[] = [];
    let used = 0;

    for (const relPath of relativePaths) {
      if (used >= totalChars) {
        parts.push(`--- FILE: ${relPath} ---\n[Skipped: total size cap reached. Request this file in a separate call.]`);
        continue;
      }
      try {
        const r = this.readFileSlice(relPath, undefined, undefined, Math.min(perFileChars, totalChars - used));
        used += r.text.length;
        if (r.complete) fullyRead.push(relPath);
        parts.push(`--- FILE: ${relPath} ---\n${r.text}`);
      } catch (err: any) {
        parts.push(`--- FILE: ${relPath} ---\n[Error: ${err.message}]`);
      }
    }
    return { text: parts.join("\n\n"), fullyRead };
  }

  readMultipleFiles(relativePaths: string[]): string {
    return this.readMultipleDetailed(relativePaths).text;
  }

  listDirectory(relativeDirPath: string = "."): Array<{ name: string; isDirectory: boolean }> {
    const full = this.resolve(relativeDirPath);
    if (!fs.existsSync(full)) {
      throw new Error(`Directory not found: ${relativeDirPath}`);
    }
    return fs.readdirSync(full, { withFileTypes: true }).map((item) => ({
      name: item.name,
      isDirectory: item.isDirectory(),
    }));
  }

  isDirectory(relativePath: string): boolean {
    try {
      return fs.statSync(this.resolve(relativePath)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * One-shot recursive tree up to maxDepth. Ignores build noise, sorts
   * directories first, caps entries per directory and total lines so a huge
   * vendored folder can't blow the context budget. Also returns the list of
   * directories it actually showed so the executor can mark them "inspected".
   */
  buildDirectoryTree(relativeDirPath: string = ".", maxDepth: number = 3): TreeResult {
    const startFull = this.resolve(relativeDirPath);
    if (!fs.existsSync(startFull) || !fs.statSync(startFull).isDirectory()) {
      throw new Error(`Directory not found: ${relativeDirPath}`);
    }

    const depthLimit = Math.max(1, Math.min(Math.floor(maxDepth) || 3, 8));
    const lines: string[] = [];
    const dirs: string[] = [];
    let truncated = false;

    const walk = (relDir: string, depth: number) => {
      if (depth >= depthLimit) return;
      if (lines.length >= MAX_TREE_LINES) {
        truncated = true;
        return;
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(this.resolve(relDir), { withFileTypes: true });
      } catch {
        return;
      }
      entries = entries
        .filter((e) => !TREE_IGNORES.has(e.name))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

      const indent = "  ".repeat(depth);
      const shown = entries.slice(0, MAX_TREE_ENTRIES_PER_DIR);
      const cut = entries.length - shown.length;
      let allShown = cut === 0;

      for (const entry of shown) {
        if (lines.length >= MAX_TREE_LINES) {
          truncated = true;
          allShown = false;
          break;
        }
        const childRel = path.posix.join(relDir.split(path.sep).join("/"), entry.name);
        if (entry.isDirectory()) {
          lines.push(`${indent}${entry.name}/`);
          walk(childRel, depth + 1);
        } else {
          lines.push(`${indent}${entry.name}`);
        }
      }
      if (cut > 0) lines.push(`${indent}… (${cut} more entries not shown)`);

      // A directory only counts as "listed" if all of its entries were shown.
      if (allShown) dirs.push(relDir === "" ? "." : relDir);
    };

    const startRel = relativeDirPath === "" ? "." : relativeDirPath.split(path.sep).join("/");
    walk(startRel, 0);
    if (truncated) lines.push(`… (tree truncated at ${MAX_TREE_LINES} lines — request a deeper path for details)`);

    return { text: lines.join("\n"), dirs };
  }

  getDirectoryTree(relativeDirPath: string = ".", maxDepth: number = 3): string {
    return this.buildDirectoryTree(relativeDirPath, maxDepth).text;
  }

  fileExists(relativePath: string): boolean {
    return fs.existsSync(this.resolve(relativePath));
  }

  /** Atomic write: temp file + rename, so an interrupted write never leaves a half-written file. */
  commitWrite(relativePath: string, content: string): void {
    const full = this.resolve(relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = `${full}.agent-tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, full);
  }

  appendToFile(relativePath: string, content: string): void {
    const full = this.resolve(relativePath);
    fs.appendFileSync(full, content, "utf8");
  }
}

export const fsToolSchemas: ToolSchema[] = [
  {
    name: "read_file",
    description:
      "Read a single file relative to the project root. Large files are truncated; use start_line/end_line to read a specific range.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root" },
        start_line: { type: "number", description: "Optional 1-based first line to return" },
        end_line: { type: "number", description: "Optional 1-based last line to return (inclusive)" },
      },
      required: ["path"],
    },
  },
  {
    name: "read_multiple_files",
    description:
      "Read several files in a single call. Always prefer this over multiple read_file calls when you need more than one file.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Array of file paths relative to the project root.",
        },
      },
      required: ["paths"],
    },
  },
  {
    name: "list_directory",
    description: "List files and subdirectories at a given path relative to the project root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root. Defaults to root." },
      },
    },
  },
  {
    name: "get_directory_tree",
    description:
      "Recursive tree of files and directories up to a given depth in ONE call. Ignores node_modules, .git, build output and lockfiles. Use this instead of repeated list_directory calls.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to project root. Defaults to root ('.')." },
        maxDepth: { type: "number", description: "Maximum recursion depth (1-8). Defaults to 3." },
      },
    },
  },
  {
    name: "write_file",
    description:
      "Propose creating/overwriting a file with its full content. The user reviews a diff and must approve. For files longer than ~150 lines write only the first chunk here, then continue with append_file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root" },
        content: { type: "string", description: "The full content of the file (or of its first chunk)" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "append_file",
    description:
      "Append the next chunk to a file you already created with write_file in this session. Use it to write long files in pieces of ~150 lines so nothing gets cut off.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file being written in chunks" },
        content: { type: "string", description: "The next chunk of content, continuing exactly where the file currently ends" },
      },
      required: ["path", "content"],
    },
  },
];
