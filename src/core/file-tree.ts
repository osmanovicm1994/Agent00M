// Project tree for the dashboard's "Project" panel. Names and sizes only, never file contents.
// Pure Node (fs/path), no imports from the agent, so the server can call it without pulling in agent logic.
//
// What it leaves out, on purpose:
//  - secret env files (.env, .env.*, except *.example): the agent itself cannot read them either
//  - heavy or generated folders (node_modules, .git, dist, caches, ...), or the names you pass in `ignore`
//  - OS clutter (.DS_Store)
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
  // Names to leave out, like `tree -I`: exact names or patterns with * and ?, each matched against ONE file or
  // folder name (not a path). When given (and not empty) it REPLACES the built-in folder list, so a folder such
  // as dist can be shown. Secret env files and OS clutter stay hidden either way.
  ignore?: string[];
}

// What the dashboard sends by default: the same idea as `tree -I 'node_modules|.git'`, plus the agent's own
// response cache (tens of thousands of hash files that would fill the whole listing).
export const DEFAULT_TREE_IGNORE = ["node_modules", ".git", ".agent_cache"];

const MAX_IGNORE_PATTERNS = 40;
const MAX_PATTERN_CHARS = 80;

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

function isSecretEnvName(name: string): boolean {
  return /^\.env(\..+)?$/.test(name) && !name.endsWith(".example");
}

export function isHiddenName(name: string, isDir: boolean): boolean {
  if (isDir) return SKIP_DIRS.has(name);
  if (SKIP_FILES.has(name)) return true;
  return isSecretEnvName(name);
}

// Cleans an ignore list that came over the wire: strings only, no paths, no duplicates, bounded.
// Returns undefined when the input is not an array.
export function sanitizeIgnore(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const pattern = item.trim().replace(/\/+$/, "");
    if (!pattern || pattern.length > MAX_PATTERN_CHARS || pattern.includes("/") || pattern.includes("\\")) continue;
    if (!out.includes(pattern)) out.push(pattern);
    if (out.length >= MAX_IGNORE_PATTERNS) break;
  }
  return out;
}

// Turns ignore patterns into a matcher for one name. `*` = any characters, `?` = one character.
export function compileIgnore(patterns: string[]): (name: string) => boolean {
  const exact = new Set<string>();
  const regexes: RegExp[] = [];
  for (const pattern of patterns) {
    if (!/[*?]/.test(pattern)) {
      exact.add(pattern);
      continue;
    }
    const source = pattern
      .split("")
      .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("");
    regexes.push(new RegExp(`^${source}$`));
  }
  return (name) => exact.has(name) || regexes.some((r) => r.test(name));
}

// Pre-order listing: a folder entry is followed by its children, folders before files, A to Z.
// Paths are relative to `root` and always use "/".
export function listWorkspace(root: string, options: ListOptions = {}): FileListing {
  const maxDepth = Math.max(1, options.maxDepth ?? 3);
  const maxEntries = Math.max(1, options.maxEntries ?? 500);
  const custom = options.ignore && options.ignore.length > 0 ? compileIgnore(options.ignore) : undefined;
  const entries: FileEntry[] = [];
  let truncated = false;

  const hidden = (name: string, isDir: boolean): boolean => {
    if (!custom) return isHiddenName(name, isDir);
    if (!isDir && (SKIP_FILES.has(name) || isSecretEnvName(name))) return true;
    return custom(name);
  };

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
      if (hidden(item.name, isDir)) continue;
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
