import type { DashboardState } from "../state";
import { tokens } from "../format";

type CardStatus = "active" | "done" | "failed" | "idle" | "standby";

const DOT: Record<CardStatus, string> = {
  active: "animate-pulse bg-teal-300",
  done: "bg-emerald-400",
  failed: "bg-rose-400",
  idle: "bg-slate-600",
  standby: "bg-slate-700",
};

const TEXT: Record<CardStatus, string> = {
  active: "Working",
  done: "Finished",
  failed: "Failed",
  idle: "Idle",
  standby: "Standby",
};

function statusOf(state: DashboardState, id: string, pinned: string | null): CardStatus {
  if (pinned && pinned !== id) return "standby";
  const running = state.run?.status === "running";
  if (running && state.activeAgent === id) return "active";
  if (state.run && !running && state.lastAgent === id) return state.run.status === "failed" ? "failed" : "done";
  return "idle";
}

interface Props {
  state: DashboardState;
  // The agent that will receive every prompt ("only active"), or null for automatic routing.
  pinned: string | null;
  onPin: (agentId: string | null) => void;
}

export function AgentRail({ state, pinned, onPin }: Props) {
  const perAgent = new Map<string, number>();
  for (const u of state.usage) perAgent.set(u.agent, (perAgent.get(u.agent) ?? 0) + u.prompt + u.completion);
  const canPin = state.canControl;

  return (
    <section aria-label="Agents" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Who is active</h2>
        <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
          {pinned ? "Solo" : "Auto routing"}
        </span>
      </div>

      <div
        className={`flex items-center gap-3 rounded-2xl border p-3 ${
          pinned ? "border-slate-800 bg-slate-900/50 opacity-70" : "border-teal-400/40 bg-teal-400/5"
        }`}
      >
        <span className={`h-2 w-2 rounded-full ${statusOf(state, "orchestrator", pinned) === "active" ? DOT.active : DOT.idle}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Orchestrator</div>
          <div className="text-xs text-slate-400">
            {pinned ? "Skipped: you chose the agent" : "Reads the task and picks the best specialist"}
          </div>
        </div>
        {pinned && canPin && (
          <button
            type="button"
            onClick={() => onPin(null)}
            className="min-h-11 rounded-xl border border-slate-700 bg-slate-800 px-3 text-xs font-medium hover:bg-slate-700"
          >
            Back to auto
          </button>
        )}
      </div>

      {state.roster.length === 0 && <p className="text-sm text-slate-400">Waiting for the agent roster…</p>}

      <ul className="flex flex-col gap-2">
        {state.roster.map((agent) => {
          const status = statusOf(state, agent.id, pinned);
          const on = pinned === agent.id;
          const used = perAgent.get(agent.id) ?? 0;
          return (
            <li
              key={agent.id}
              className={`flex items-stretch overflow-hidden rounded-2xl border transition ${
                on ? "border-teal-300 bg-teal-300/10" : "border-slate-800 bg-slate-900/60"
              } ${status === "standby" ? "opacity-60" : ""}`}
            >
              <div className="min-w-0 flex-1 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[status]}`} />
                  <span className="truncate text-sm font-semibold">{agent.name}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-slate-400">{agent.description}</p>
                <div className="mt-1 font-mono text-[11px] text-slate-400">
                  {on && status !== "active" ? "Only active" : TEXT[status]}
                  {used > 0 ? ` · ${tokens(used)} tokens` : ""}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`Only ${agent.name} active`}
                disabled={!canPin}
                onClick={() => onPin(on ? null : agent.id)}
                title={canPin ? "Send every prompt to this agent" : "Open the URL with the control token to choose an agent"}
                className="flex min-h-16 w-20 shrink-0 flex-col items-center justify-center gap-1 border-l border-slate-800 disabled:opacity-40"
              >
                <span className={`relative block h-7 w-12 rounded-full transition ${on ? "bg-teal-300" : "bg-slate-700"}`}>
                  <span
                    className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${on ? "left-6" : "left-1"}`}
                  />
                </span>
                <span className="text-[10.5px] text-slate-400">Only me</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
