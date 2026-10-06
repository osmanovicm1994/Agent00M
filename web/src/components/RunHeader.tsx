import { useEffect, useState } from "react";
import { elapsed } from "../format";
import type { DashboardState, RunStatus } from "../state";

// Re-renders twice a second while a run is active so the elapsed timer ticks.
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const STATUS_STYLES: Record<RunStatus, string> = {
  running: "bg-sky-500/15 text-sky-300",
  done: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-rose-500/15 text-rose-300",
};

const STATUS_TEXT: Record<RunStatus, string> = {
  running: "Running",
  done: "Completed",
  failed: "Failed",
};

export function RunHeader({ state }: { state: DashboardState }) {
  const run = state.run;
  const now = useNow(run?.status === "running");

  if (!run) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-sm text-slate-400">
        Waiting for a task. Start one in the terminal with{" "}
        <code className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-200">npm run chat:ui</code>.
      </section>
    );
  }

  const meta = [
    run.model && `${run.model} · ${run.toolProtocol === "native" ? "native tools" : "fenced tools"}`,
    run.autoWrite && "auto mode",
    run.stack.length > 0 && `stack: ${run.stack.join(", ")}`,
    run.steps !== undefined && `${run.steps} step${run.steps === 1 ? "" : "s"}`,
    run.status !== "running" && `${run.filesWritten.length} file(s) written, ${run.commandsRun.length} command(s) run`,
  ].filter(Boolean);

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-start justify-between gap-4">
        <p className="text-base leading-snug">{run.task}</p>
        <div className="flex shrink-0 items-center gap-3 text-xs">
          <span className="font-mono text-slate-400">{elapsed(run.startedAt, run.endedAt ?? now)}</span>
          <span className={`rounded-full px-2.5 py-1 ${STATUS_STYLES[run.status]}`}>{STATUS_TEXT[run.status]}</span>
        </div>
      </div>
      <p className="mt-2 truncate font-mono text-xs text-slate-500">{run.workspace}</p>
      {meta.length > 0 && <p className="mt-1 text-xs text-slate-500">{meta.join("  ·  ")}</p>}
    </section>
  );
}
