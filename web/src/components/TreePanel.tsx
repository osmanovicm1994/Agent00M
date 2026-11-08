import { useEffect, useMemo, useRef, useState } from "react";
import type { FileTree } from "../state";
import { isHtmlPath } from "../preview/helpers";
import { allDirPaths, ancestorsOf, buildTree, countEntries, pathsMatching, renderTreeText, visibleRows } from "../treeText";

interface Props {
  tree: FileTree | null;
  connected: boolean;
  canControl: boolean;
  // Paths the current run wrote (from the agent's events).
  touched: string[];
  // Paths the file watcher reported as changed (path -> time).
  changed: Record<string, number>;
  // Counts every watcher push; the tree opens the folders of changed files when it grows.
  changeTick: number;
  context: string[];
  onContextChange: (paths: string[]) => void;
  onRefresh: () => void;
  // What the tree leaves out, shown at the bottom ("node_modules|.git|...").
  ignoreText: string;
  onOpenSettings: () => void;
  // Show this HTML file in the Design preview.
  onPreviewFile: (path: string) => void;
}

const ROW_H = 28;
const RECENT_MS = 30_000;

function size(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// The project folder as a tree: every file (except the ignored names), live updates while the agent works.
// Click a file to add it to the next prompt; HTML files can be opened in the Design preview.
export function TreePanel({ tree, connected, canControl, touched, changed, changeTick, context, onContextChange, onRefresh, ignoreText, onOpenSettings, onPreviewFile }: Props) {
  const [view, setView] = useState<"tree" | "text">("tree");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const seeded = useRef(false);

  // Load once when the panel first shows with a live connection.
  useEffect(() => {
    if (connected && canControl && !tree) onRefresh();
  }, [connected, canControl, tree, onRefresh]);

  // First time a tree arrives: open the top-level folders.
  useEffect(() => {
    if (!tree || seeded.current) return;
    seeded.current = true;
    setExpanded(new Set(tree.entries.filter((e) => e.type === "dir" && !e.path.includes("/")).map((e) => e.path)));
  }, [tree]);

  // Open the folders of files that just changed, so the agent's work is visible without clicking.
  useEffect(() => {
    if (!follow || changeTick === 0) return;
    const now = Date.now();
    const recent = Object.entries(changed)
      .filter(([, t]) => now - t < RECENT_MS)
      .map(([p]) => p);
    if (recent.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const dir of ancestorsOf(recent)) next.add(dir);
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeTick, follow]);

  const roots = useMemo(() => (tree ? buildTree(tree.entries) : []), [tree]);
  const matching = useMemo(() => (tree && filter.trim() ? pathsMatching(tree.entries, filter) : undefined), [tree, filter]);
  const rows = useMemo(() => visibleRows(roots, expanded, matching), [roots, expanded, matching]);
  const counts = useMemo(() => (tree ? countEntries(tree.entries) : { dirs: 0, files: 0 }), [tree]);
  const text = useMemo(() => (view === "text" && tree ? renderTreeText(tree.entries) : ""), [view, tree]);

  // Only the rows in view are drawn (fixed row height), so a tree with thousands of files stays smooth.
  const boxRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  const hasBox = tree !== null && view === "tree";
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    setViewH(el.clientHeight);
    const observer = new ResizeObserver(() => setViewH(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasBox]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + 8);
  const slice = rows.slice(start, end);

  const toggleDir = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const toggleContext = (path: string) => onContextChange(context.includes(path) ? context.filter((p) => p !== path) : [...context, path]);

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const touchedSet = useMemo(() => new Set(touched.map((p) => p.replace(/^\.\//, ""))), [touched]);
  const now = Date.now();

  const btn = "min-h-9 rounded-lg border border-slate-700 px-3 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40";

  return (
    <section aria-label="Project tree" className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs text-slate-400" title={tree?.root}>
            {tree?.root ?? "No folder yet"}
          </p>
          {tree && (
            <p className="text-xs text-slate-500">
              {counts.dirs} {counts.dirs === 1 ? "directory" : "directories"}, {counts.files} {counts.files === 1 ? "file" : "files"}
            </p>
          )}
        </div>
        <button type="button" onClick={onRefresh} disabled={!connected || !canControl} className={btn}>
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="View" className="flex overflow-hidden rounded-lg border border-slate-700">
          {(["tree", "text"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`min-h-9 px-3 text-xs font-medium ${view === v ? "bg-slate-800 text-teal-300" : "text-slate-300 hover:bg-slate-800/60"}`}
            >
              {v === "tree" ? "Tree" : "Text"}
            </button>
          ))}
        </div>
        {view === "tree" ? (
          <>
            <button type="button" className={btn} disabled={!tree} onClick={() => tree && setExpanded(new Set(allDirPaths(tree.entries)))}>
              Expand all
            </button>
            <button type="button" className={btn} disabled={!tree} onClick={() => setExpanded(new Set())}>
              Collapse all
            </button>
            <button
              type="button"
              aria-pressed={follow}
              onClick={() => setFollow(!follow)}
              title="Open the folders of files the agent changes"
              className={`${btn} ${follow ? "bg-slate-800 text-teal-300" : ""}`}
            >
              Follow changes
            </button>
          </>
        ) : (
          <button type="button" className={btn} disabled={!tree} onClick={copyText}>
            {copied ? "Copied" : "Copy text"}
          </button>
        )}
      </div>

      {view === "tree" && (
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files…"
          aria-label="Filter files"
          className="min-h-9 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm placeholder:text-slate-500"
        />
      )}

      {!canControl && <p className="text-xs text-slate-400">The project tree needs the control token (open the full URL).</p>}
      {canControl && !tree && <p className="text-xs text-slate-400">Loading, or the chat startup questions are still open in the terminal.</p>}

      {tree && view === "tree" && (
        <div
          ref={boxRef}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          role="tree"
          aria-label="Files"
          className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-800 bg-slate-950/40"
        >
          {rows.length === 0 && <p className="p-3 text-xs text-slate-400">{filter ? "No file matches." : "The folder is empty."}</p>}
          <div style={{ paddingTop: start * ROW_H, paddingBottom: Math.max(0, rows.length - end) * ROW_H }}>
            {slice.map(({ node, depth }) => {
              const isDir = node.type === "dir";
              const open = isDir && (matching ? true : expanded.has(node.path));
              const inCtx = context.includes(node.path);
              const stamp = changed[node.path];
              const recent = stamp !== undefined && now - stamp < RECENT_MS;
              const wrote = touchedSet.has(node.path);
              return (
                <div
                  key={node.path}
                  role="treeitem"
                  aria-expanded={isDir ? open : undefined}
                  style={{ height: ROW_H, paddingLeft: 6 + depth * 14 }}
                  className={`flex items-center gap-1 pr-2 font-mono text-[13px] ${inCtx ? "bg-teal-300/10" : "hover:bg-slate-800/50"}`}
                >
                  <button
                    type="button"
                    onClick={() => (isDir ? toggleDir(node.path) : toggleContext(node.path))}
                    title={isDir ? node.path : `${node.path} — click to ${inCtx ? "remove from" : "add to"} the prompt`}
                    className="flex h-full min-w-0 flex-1 items-center gap-1 text-left"
                  >
                    <span className="w-4 shrink-0 text-center text-slate-500">{isDir ? (open ? "▾" : "▸") : ""}</span>
                    <span className={`truncate ${isDir ? "text-slate-300" : recent || wrote ? "text-amber-200" : "text-slate-100"}`}>
                      {node.name}
                      {isDir ? "/" : ""}
                    </span>
                  </button>
                  {isHtmlPath(node.path) && (
                    <button
                      type="button"
                      onClick={() => onPreviewFile(node.path)}
                      aria-label={`Preview ${node.path}`}
                      className="shrink-0 rounded px-1.5 text-[11px] text-sky-300 hover:bg-slate-800"
                    >
                      preview
                    </button>
                  )}
                  {recent && <span className="shrink-0 text-[11px] text-amber-300">changed</span>}
                  {!recent && wrote && <span className="shrink-0 text-[11px] text-amber-300/70">written</span>}
                  {inCtx && <span className="shrink-0 text-[11px] text-teal-300">in prompt</span>}
                  {!isDir && !inCtx && !recent && !wrote && <span className="shrink-0 text-[11px] text-slate-500">{size(node.size)}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tree && view === "text" && (
        <pre className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-800 bg-slate-950/40 p-3 font-mono text-xs leading-5 text-slate-200">{text}</pre>
      )}

      {tree?.truncated && <p className="text-xs text-amber-300">The list was cut off at {tree.entries.length} entries. Add big folders to the ignore list in Settings.</p>}
      <p className="text-[11px] text-slate-500">
        Ignoring <span className="font-mono">{ignoreText}</span> ·{" "}
        <button type="button" onClick={onOpenSettings} className="text-teal-300 hover:underline">
          change
        </button>
        {context.length > 0 && <span> · {context.length} file{context.length === 1 ? "" : "s"} in the prompt</span>}
      </p>
    </section>
  );
}
