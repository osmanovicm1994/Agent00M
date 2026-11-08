// Pure helpers for the project tree panel (no React, unit-tested in treeText.test.ts).

import type { FileEntry } from "./protocol";

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children: TreeNode[];
}

// The server sends a flat pre-order list ("src", "src/a.ts", ...). This nests it.
export function buildTree(entries: FileEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();
  for (const e of entries) {
    const slash = e.path.lastIndexOf("/");
    const node: TreeNode = { name: slash < 0 ? e.path : e.path.slice(slash + 1), path: e.path, type: e.type, size: e.size, children: [] };
    byPath.set(e.path, node);
    const parent = slash < 0 ? undefined : byPath.get(e.path.slice(0, slash));
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

export function countEntries(entries: FileEntry[]): { dirs: number; files: number } {
  let dirs = 0;
  for (const e of entries) if (e.type === "dir") dirs++;
  return { dirs, files: entries.length - dirs };
}

// Output in the style of `tree`:
//   .
//   ├── src
//   │   └── a.ts
//   └── README.md
//
//   1 directory, 2 files
export function renderTreeText(entries: FileEntry[], rootLabel = "."): string {
  const lines: string[] = [rootLabel];
  const walk = (nodes: TreeNode[], prefix: string): void => {
    nodes.forEach((n, i) => {
      const last = i === nodes.length - 1;
      lines.push(prefix + (last ? "└── " : "├── ") + n.name);
      if (n.type === "dir") walk(n.children, prefix + (last ? "    " : "│   "));
    });
  };
  walk(buildTree(entries), "");
  const { dirs, files } = countEntries(entries);
  lines.push("", `${dirs} ${dirs === 1 ? "directory" : "directories"}, ${files} ${files === 1 ? "file" : "files"}`);
  return lines.join("\n");
}

// Paths that match the filter text (by name) plus every folder above them.
export function pathsMatching(entries: FileEntry[], query: string): Set<string> {
  const q = query.trim().toLowerCase();
  const out = new Set<string>();
  if (!q) return out;
  for (const e of entries) {
    const name = e.path.slice(e.path.lastIndexOf("/") + 1).toLowerCase();
    if (!name.includes(q)) continue;
    const parts = e.path.split("/");
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return out;
}

export interface Row {
  node: TreeNode;
  depth: number;
}

// The rows to draw: folders that are open show their children. With a filter, only matches and their folders show, all open.
export function visibleRows(roots: TreeNode[], expanded: ReadonlySet<string>, matching?: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (nodes: TreeNode[], depth: number): void => {
    for (const node of nodes) {
      if (matching && !matching.has(node.path)) continue;
      rows.push({ node, depth });
      if (node.type === "dir" && (matching || expanded.has(node.path))) walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return rows;
}

// Every folder path (for "Expand all").
export function allDirPaths(entries: FileEntry[]): string[] {
  return entries.filter((e) => e.type === "dir").map((e) => e.path);
}

// Folders above the given files, so changed files are visible without opening folders by hand.
export function ancestorsOf(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const parts = p.replace(/^\.\//, "").split("/");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return [...out];
}
