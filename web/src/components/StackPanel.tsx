import type { ReactNode } from "react";
import type { DashboardState } from "../state";

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400">{title}</div>
      <div className="mt-2 text-sm">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-slate-800 py-2 first:border-t-0">
      <span className="text-slate-400">{k}</span>
      <span className="min-w-0 break-all text-right font-mono text-[13px]">{v}</span>
    </div>
  );
}

// Facts the dashboard really knows: how this page reaches the agent, the model and tool mode of
// the latest run, the stack the agent detected in the project, and the agent roster.
export function StackPanel({ state, wsUrl }: { state: DashboardState; wsUrl: string }) {
  const secure = window.location.protocol === "https:";
  const run = state.run;
  const host = window.location.host;
  const models = new Map<string, number>();
  for (const u of state.usage) models.set(u.model, (models.get(u.model) ?? 0) + 1);

  return (
    <section aria-label="Stack" className="grid gap-4 lg:grid-cols-2">
      <Card title="Connection path">
        <Row k="Page" v={host} />
        <Row k="Transport" v={secure ? "HTTPS / WSS (encrypted)" : "HTTP / WS (local network only)"} />
        <Row k="Socket" v={wsUrl.replace(/\?token=.*/, "")} />
        <Row k="Control" v={state.canControl ? "Token accepted" : "Read-only"} />
        <Row k="Status" v={state.connected ? "Connected" : "Reconnecting…"} />
      </Card>

      <Card title="Model">
        <Row k="Latest run" v={run?.model ?? "No run yet"} />
        <Row k="Tool mode" v={run?.toolProtocol ? (run.toolProtocol === "native" ? "Native tool calls" : "Fenced blocks") : "n/a"} />
        <Row k="Auto mode" v={run ? (run.autoWrite ? "On" : "Off") : "n/a"} />
        {[...models.entries()].map(([m, n]) => (
          <Row key={m} k="Seen this session" v={`${m} · ${n} call${n === 1 ? "" : "s"}`} />
        ))}
      </Card>

      <Card title="Detected in the project">
        {run && run.stack.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {run.stack.map((s) => (
              <span key={s} className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 font-mono text-xs">{s}</span>
            ))}
          </div>
        ) : (
          <p className="text-slate-400">Shown after the agent has started a run in a project.</p>
        )}
        {run && <p className="mt-3 break-all font-mono text-xs text-slate-400">{run.workspace}</p>}
      </Card>

      <Card title={`Agents (${state.roster.length})`}>
        {state.roster.length === 0 && <p className="text-slate-400">Waiting for the roster…</p>}
        {state.roster.map((a) => (
          <div key={a.id} className="border-t border-slate-800 py-2 first:border-t-0">
            <div className="font-medium">{a.name}</div>
            <div className="text-xs text-slate-400">{a.description}</div>
          </div>
        ))}
      </Card>
    </section>
  );
}
