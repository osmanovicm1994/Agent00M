import type { DashboardState } from "../state";

type CardStatus = "active" | "done" | "failed" | "idle";

const CARD_STYLES: Record<CardStatus, string> = {
  active: "border-sky-400 bg-sky-500/10 shadow-[0_0_24px_rgba(56,189,248,0.25)]",
  done: "border-emerald-500/50 bg-emerald-500/5",
  failed: "border-rose-500/50 bg-rose-500/5",
  idle: "border-slate-800 bg-slate-900/60",
};

const DOT_STYLES: Record<CardStatus, string> = {
  active: "animate-pulse bg-sky-400",
  done: "bg-emerald-400",
  failed: "bg-rose-400",
  idle: "bg-slate-700",
};

const STATUS_TEXT: Record<CardStatus, string> = {
  active: "has the baton",
  done: "finished",
  failed: "failed",
  idle: "idle",
};

function statusOf(state: DashboardState, id: string): CardStatus {
  const running = state.run?.status === "running";
  if (running && state.activeAgent === id) return "active";
  if (state.run && !running && state.lastAgent === id) return state.run.status === "failed" ? "failed" : "done";
  return "idle";
}

function AgentCard(props: { name: string; description: string; status: CardStatus; badge?: string }) {
  const { name, description, status, badge } = props;
  return (
    <div className={`flex flex-col gap-2 rounded-xl border p-4 transition-all duration-300 ${CARD_STYLES[status]}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{name}</span>
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT_STYLES[status]}`} />
      </div>
      <p className="line-clamp-2 text-xs text-slate-500">{description}</p>
      <div className="mt-auto flex items-center justify-between text-[11px]">
        <span className={status === "idle" ? "text-slate-600" : "text-slate-300"}>{STATUS_TEXT[status]}</span>
        {badge && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-400">{badge}</span>}
      </div>
    </div>
  );
}

export function AgentRail({ state }: { state: DashboardState }) {
  return (
    <section className="grid gap-4 lg:grid-cols-[15rem_1fr]">
      <AgentCard
        name="Orchestrator"
        description="Evaluates the task and routes it to the best specialist."
        status={statusOf(state, "orchestrator")}
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {state.roster.length === 0 && <p className="col-span-full text-sm text-slate-500">Waiting for the agent roster…</p>}
        {state.roster.map((agent) => {
          const status = statusOf(state, agent.id);
          return (
            <AgentCard
              key={agent.id}
              name={agent.name}
              description={agent.description}
              status={status}
              badge={status !== "idle" && state.run?.routeMethod ? state.run.routeMethod : undefined}
            />
          );
        })}
      </div>
    </section>
  );
}
