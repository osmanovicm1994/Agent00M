import { useState } from "react";
import { ago, elapsed, tokens } from "../format";
import type { RunRecord } from "../storage";

const BADGE: Record<string, string> = {
  done: "bg-emerald-400/15 text-emerald-300",
  failed: "bg-rose-400/15 text-rose-300",
  running: "bg-teal-300/15 text-teal-300",
};
const LABEL: Record<string, string> = { done: "Completed", failed: "Failed", running: "Running" };

interface Props {
  runs: RunRecord[];
  names: Map<string, string>;
  onClear: () => void;
}

// Finished runs, newest first. Kept on this device (up to 40), so it survives restarts of the agent.
export function HistoryPanel({ runs, names, onClear }: Props) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section aria-label="History" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">History</h2>
        {runs.length > 0 && (
          <button type="button" onClick={onClear} className="min-h-11 px-2 text-xs text-slate-400 hover:text-rose-300">
            Clear
          </button>
        )}
      </div>

      {runs.length === 0 && (
        <p className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">
          No runs yet. Every task you run is listed here with its result and token use.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {runs.map((r) => {
          const isOpen = open === r.runId + r.startedAt;
          return (
            <li key={r.runId + r.startedAt} className="rounded-2xl border border-slate-800 bg-slate-900/60">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : r.runId + r.startedAt)}
                className="flex min-h-16 w-full flex-col gap-1 px-4 py-3 text-left"
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="line-clamp-2 text-sm font-medium">{r.task}</span>
                  <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${BADGE[r.status]}`}>{LABEL[r.status]}</span>
                </span>
                <span className="font-mono text-xs text-slate-400">
                  {r.agent ? (names.get(r.agent) ?? r.agent) : "Agent"} · {ago(r.startedAt)}
                  {r.endedAt ? ` · ${elapsed(r.startedAt, r.endedAt)}` : ""} · {tokens(r.promptTokens + r.completionTokens)} tokens
                </span>
              </button>
              {isOpen && (
                <div className="flex flex-col gap-3 border-t border-slate-800 px-4 py-3 text-sm">
                  {r.summary && <p className="whitespace-pre-wrap text-slate-300">{r.summary}</p>}
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                    <dt className="text-slate-400">Model</dt>
                    <dd className="font-mono">{r.model ?? "unknown"}</dd>
                    <dt className="text-slate-400">Steps</dt>
                    <dd className="font-mono">{r.steps ?? "n/a"}</dd>
                    <dt className="text-slate-400">Tokens</dt>
                    <dd className="font-mono">
                      in {tokens(r.promptTokens)} · out {tokens(r.completionTokens)}
                    </dd>
                    <dt className="text-slate-400">Folder</dt>
                    <dd className="break-all font-mono">{r.workspace}</dd>
                  </dl>
                  {r.filesWritten.length > 0 && (
                    <div>
                      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-slate-400">Files written</div>
                      <ul className="font-mono text-xs text-slate-300">
                        {r.filesWritten.map((f) => (
                          <li key={f} className="break-all">{f}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {r.commandsRun.length > 0 && (
                    <div>
                      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-slate-400">Commands run</div>
                      <ul className="font-mono text-xs text-slate-300">
                        {r.commandsRun.map((c, i) => (
                          <li key={i} className="break-all">{c}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
