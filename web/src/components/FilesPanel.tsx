import { useEffect } from "react";
import type { FileTree } from "../state";

interface Props {
  tree: FileTree | null;
  connected: boolean;
  canControl: boolean;
  // Paths the current run changed, highlighted in the tree.
  touched: string[];
  context: string[];
  onContextChange: (paths: string[]) => void;
  onRefresh: () => void;
  onUse: () => void;
  // Shown in the file picker over the page: the list is taller and the button always shows ("Done").
  modal?: boolean;
}

function size(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// The project folder the agent works in. Tap a file to add it to the next prompt.
export function FilesPanel({ tree, connected, canControl, touched, context, onContextChange, onRefresh, onUse, modal = false }: Props) {
  // Load once when the panel first shows with a live connection.
  useEffect(() => {
    if (connected && canControl && !tree) onRefresh();
  }, [connected, canControl, tree, onRefresh]);

  const toggle = (path: string) =>
    onContextChange(context.includes(path) ? context.filter((p) => p !== path) : [...context, path]);

  const touchedSet = new Set(touched.map((p) => p.replace(/^\.\//, "")));

  return (
    <section aria-label="Project files" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Project</h2>
          <p className="truncate font-mono text-xs text-slate-400">{tree?.root ?? "No folder yet"}</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={!connected || !canControl}
          className="min-h-11 rounded-xl border border-slate-700 bg-slate-800 px-3 text-xs font-medium hover:bg-slate-700 disabled:opacity-40"
        >
          Refresh
        </button>
      </div>

      {!canControl && <p className="text-xs text-slate-400">The project tree needs the control token (open the full URL).</p>}
      {canControl && !tree && <p className="text-xs text-slate-400">Loading, or the chat startup questions are still open in the terminal.</p>}

      {tree && (
        <>
          <p className="text-xs text-slate-400">Tap a file to add it to your next prompt. {context.length} selected.</p>
          <ul className={`overflow-auto rounded-2xl border border-slate-800 bg-slate-900/60 p-1.5 ${modal ? "max-h-[55vh]" : "max-h-[28rem]"}`}>
            {tree.entries.map((e) => {
              const depth = e.path.split("/").length - 1;
              const name = e.path.split("/").pop() ?? e.path;
              const isFile = e.type === "file";
              const inCtx = context.includes(e.path);
              const changed = touchedSet.has(e.path);
              return (
                <li key={e.path}>
                  <button
                    type="button"
                    disabled={!isFile}
                    aria-pressed={isFile ? inCtx : undefined}
                    onClick={() => toggle(e.path)}
                    style={{ paddingLeft: 10 + depth * 16 }}
                    className={`flex min-h-10 w-full items-center gap-2 rounded-lg pr-3 text-left font-mono text-[13px] ${
                      inCtx ? "bg-teal-300/10" : isFile ? "hover:bg-slate-800/60" : ""
                    }`}
                  >
                    <span className={isFile ? "text-slate-100" : "text-slate-400"}>{isFile ? name : `${name}/`}</span>
                    <span className="flex-1" />
                    {changed && <span className="text-[11px] text-amber-300">changed</span>}
                    {inCtx && <span className="text-[11px] text-teal-300">in prompt</span>}
                    {isFile && !inCtx && !changed && <span className="text-[11px] text-slate-500">{size(e.size)}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {tree.truncated && <p className="text-xs text-amber-300">The list was cut off. Very large folders only show the first entries.</p>}
          <button
            type="button"
            onClick={onUse}
            className={`min-h-12 rounded-xl bg-teal-300 font-semibold text-slate-950 hover:bg-teal-200 ${modal ? "" : "lg:hidden"}`}
          >
            {modal ? `Done${context.length ? ` (${context.length} selected)` : ""}` : "Use in prompt"}
          </button>
        </>
      )}
    </section>
  );
}
