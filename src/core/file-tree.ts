// Project tree for the dashboard's "Project" panel. Names and sizes only, never file contents.
// Pure Node (fs/path), no imports from the agent, so the server can call it without pulling in agent logic.
//
// What it leaves out, on purpose:
//  - secret env files (.env, .env.*, except *.example): the agent itself cannot read them either
//  - heavy or generated folders (node_modules, .git, dist, caches, ...)
//  - symbolic links: they are never followed, so the listing cannot leave the project folder

import * as fs from "fs";
import * as path from "path";
import type { FileEntry } from "./event-types";

export interface FileListing {
  root: string;
  entries: FileEntry[];
  // true when the entry limit cut the listing short
  truncated: boolean;
}

export interface ListOptions {
  // How many folder levels to show (1 = only the top level). Default 3.
  maxDepth?: number;
  // Hard cap on the number of entries. Default 500.
  maxEntries?: number;
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".agent_cache",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
  "DerivedData",
  "Pods",
  ".gradle",
  ".idea",
]);

const SKIP_FILES = new Set([".DS_Store", "Thumbs.db"]);

export function isHiddenName(name: string, isDir: boolean): boolean {
  if (isDir) return SKIP_DIRS.has(name);
  if (SKIP_FILES.has(name)) return true;
  return /^\.env(\..+)?$/.test(name) && !name.endsWith(".example");
}

// Pre-order listing: a folder entry is followed by its children, folders before files, A to Z.
// Paths are relative to `root` and always use "/".
export function listWorkspace(root: string, options: ListOptions = {}): FileListing {
  const maxDepth = Math.max(1, options.maxDepth ?? 3);
  const maxEntries = Math.max(1, options.maxEntries ?? 500);
  const entries: FileEntry[] = [];
  let truncated = false;

  const walk = (dir: string, rel: string, depth: number): void => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const item of items) {
      if (item.isSymbolicLink()) continue;
      const isDir = item.isDirectory();
      if (!isDir && !item.isFile()) continue;
      if (isHiddenName(item.name, isDir)) continue;
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }

      const relPath = rel ? `${rel}/${item.name}` : item.name;
      if (isDir) {
        entries.push({ path: relPath, type: "dir" });
        if (depth < maxDepth) walk(path.join(dir, item.name), relPath, depth + 1);
      } else {
        let size: number | undefined;
        try {
          size = fs.statSync(path.join(dir, item.name)).size;
        } catch {
          size = undefined;
        }
        entries.push({ path: relPath, type: "file", size });
      }
    }
  };

  walk(root, "", 1);
  return { root, entries, truncated };
}
