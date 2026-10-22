// src/team/tree.ts
//
// What the Project Manager sees of the target project before planning: a real directory tree (three levels, names
// only), not just the top-level names. With it the PM can say which files already exist and which are new, instead of
// planning from guesses. No file contents are read; secrets files (.env*) and heavy or generated folders are left out.

import * as fs from "fs";
import * as path from "path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".agent_cache",
  ".venv",
  "venv",
  "__pycache__",
  "Pods",
  "DerivedData",
  ".gradle",
  "target",
  "vendor",
]);

export interface TreeOptions {
  /** Levels shown, the top level being 1. Default 3. */
  maxDepth?: number;
  /** Lines shown in total. Default 150. */
  maxEntries?: number;
}

function visible(e: fs.Dirent): boolean {
  if (e.name.startsWith(".env")) return false; // secrets: not even the names
  if (e.isSymbolicLink()) return false;
  if (e.isDirectory()) {
    if (SKIP_DIRS.has(e.name)) return false;
    if (e.name.startsWith(".") && e.name !== ".github") return false;
    return true;
  }
  return e.isFile();
}

/** Indented tree of the project folder: directories first, each level sorted by name. Never throws. */
export function projectTree(root: string, opts: TreeOptions = {}): string {
  const maxDepth = Math.max(1, opts.maxDepth ?? 3);
  const maxEntries = Math.max(1, opts.maxEntries ?? 150);
  const lines: string[] = [];
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).filter(visible);
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (lines.length >= maxEntries) {
        truncated = true;
        return;
      }
      const indent = "  ".repeat(depth);
      if (e.isDirectory()) {
        lines.push(`${indent}${e.name}/`);
        if (depth + 1 < maxDepth) walk(path.join(dir, e.name), depth + 1);
      } else {
        lines.push(`${indent}${e.name}`);
      }
    }
  };

  try {
    fs.readdirSync(root);
  } catch {
    return "(unreadable)";
  }
  walk(root, 0);
  if (lines.length === 0) return "(empty folder: this is a new project)";
  return lines.join("\n") + (truncated ? "\n... (more entries not shown)" : "");
}
