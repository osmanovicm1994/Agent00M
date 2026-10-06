import { useAgentSocket } from "./useAgentSocket";
import { AgentRail } from "./components/AgentRail";
import { LiveFeed } from "./components/LiveFeed";
import { RunHeader } from "./components/RunHeader";

// Override with VITE_AGENT_WS if the agent runs on another port (AGENT_UI_PORT).
const WS_URL: string = import.meta.env.VITE_AGENT_WS ?? "ws://127.0.0.1:3001/ws";

export default function Dashboard() {
  const state = useAgentSocket(WS_URL);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight">Agent Monitor</h1>
          <span
            className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs ${
              state.connected ? "bg-emerald-500/10 text-emerald-300" : "bg-rose-500/10 text-rose-300"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${state.connected ? "bg-emerald-400" : "animate-pulse bg-rose-400"}`} />
            {state.connected ? "Connected" : "Waiting for the agent…"}
          </span>
        </header>

        <RunHeader state={state} />
        <AgentRail state={state} />

        {state.pendingApproval && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
            <span className="mt-0.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />
            <div>
              <div className="font-medium">Waiting for your answer in the terminal</div>
              <div className="text-amber-200/80">{state.pendingApproval}</div>
            </div>
          </div>
        )}

        <LiveFeed state={state} />
      </div>
    </div>
  );
}
