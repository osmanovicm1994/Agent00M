// Watches the project folder and reports which files changed, so the dashboard can keep its project tree
// and design preview live. No dependencies: it uses fs.watch with { recursive: true } (macOS, Windows and
// Node 20+ on Linux). Where that is not available the watcher reports supported:false and the dashboard
// falls back to refreshing after each written file.
//
// Only relative paths ("/" separators) are reported, never file contents. Secret env files, OS clutter,
// the built-in heavy folders (node_modules, .git, dist, ...) and the ignore list are never reported.

import * as fs from "fs";
import * as path from "path";
import { compileIgnore, DEFAULT_TREE_IGNORE, isHiddenName } from "./file-tree";

export interface WatchOptions {
  // Extra names or patterns to ignore (default: node_modules, .git, .agent_cache).
  ignore?: string[];
  // Changes are collected for this long before one report is sent. Default 250 ms.
  debounceMs?: number;
  // At most this many paths per report. Default 200.
  maxBatch?: number;
}

export interface WorkspaceWatcher {
  root: string;
  // false when the platform cannot watch recursively
  supported: boolean;
  close(): void;
}

// Pure: should a change at this relative path be reported?
export function shouldReport(rel: string, ignored: (name: string) => boolean): boolean {
  const parts = rel.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  for (let i = 0; i < parts.length - 1; i++) {
    if (isHiddenName(parts[i], true) || ignored(parts[i])) return false;
  }
  const last = parts[parts.length - 1];
  return !(isHiddenName(last, false) || isHiddenName(last, true) || ignored(last));
}

export function watchWorkspace(root: string, onChange: (paths: string[]) => void, options: WatchOptions = {}): WorkspaceWatcher {
  const ignored = compileIgnore(options.ignore ?? DEFAULT_TREE_IGNORE);
  const debounceMs = options.debounceMs ?? 250;
  const maxBatch = options.maxBatch ?? 200;
  const rootName = path.basename(root);
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let watcher: fs.FSWatcher | undefined;

  const flush = (): void => {
    timer = undefined;
    if (closed || pending.size === 0) return;
    const paths = [...pending].slice(0, maxBatch);
    pending.clear();
    try {
      onChange(paths);
    } catch {
      // a broken listener must not break the watcher
    }
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending.clear();
    try {
      watcher?.close();
    } catch {
      // already closed
    }
  };

  try {
    watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      if (closed || !filename) return;
      const rel = String(filename).split(path.sep).join("/");
      // macOS also reports changes of the watched folder itself under its own name. Not a file of the project.
      if (rel === rootName && !fs.existsSync(path.join(root, rel))) return;
      if (!shouldReport(rel, ignored)) return;
      pending.add(rel);
      if (!timer) timer = setTimeout(flush, debounceMs);
    });
    watcher.on("error", close);
  } catch {
    watcher = undefined;
  }

  return { root, supported: watcher !== undefined, close };
}
