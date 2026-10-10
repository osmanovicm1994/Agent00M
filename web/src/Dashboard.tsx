import { useAgentSocket } from "./useAgentSocket";
import { AgentRail } from "./components/AgentRail";
import { LiveFeed } from "./components/LiveFeed";
import { RunHeader } from "./components/RunHeader";
import { TaskComposer } from "./components/TaskComposer";
import { SetupPanel } from "./components/SetupPanel";

// The socket lives on the same host that served this page, so it also works from a phone on the
// LAN (http://192.168.x.x:5173 -> ws://192.168.x.x:3001). Override with VITE_AGENT_WS if the agent
// runs on another port (AGENT_UI_PORT).
const WS_HOST = window.location.hostname === "localhost" ? "127.0.0.1" : window.location.hostname;
const WS_BASE: string = import.meta.env.VITE_AGENT_WS ?? `ws://${WS_HOST}:3001/ws`;
const TOKEN_KEY = "agent-ui-token";

// The control token comes from the URL the agent prints in the terminal (?token=...). It is kept
// for this tab only and removed from the address bar so it does not end up in screenshots.
function readToken(): string | undefined {
  let token: string | undefined;
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("token");
    if (fromUrl) {
      token = fromUrl;
      try {
        sessionStorage.setItem(TOKEN_KEY, fromUrl);
      } catch {
        // storage can be blocked; the token then lasts until reload
      }
      url.searchParams.delete("token");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    } else {
      token = sessionStorage.getItem(TOKEN_KEY) ?? undefined;
    }
  } catch {
    // ignore: the dashboard simply stays read-only
  }
  return token;
}

const TOKEN = readToken();
const WS_URL = TOKEN ? `${WS_BASE}?token=${encodeURIComponent(TOKEN)}` : WS_BASE;

export default function Dashboard() {
  const { state, send, dismissNotice } = useAgentSocket(WS_URL);
  const approval = state.pendingApproval;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight">Agent Monitor</h1>
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-3 py-1 text-xs ${
                state.canControl ? "bg-sky-500/10 text-sky-300" : "bg-slate-800 text-slate-400"
              }`}
              title={
                state.canControl
                  ? "You can send tasks and answer approvals from here"
                  : "Open the URL printed by `npm run chat:ui` to get control"
              }
            >
              {state.canControl ? "Control" : "Read-only"}
            </span>
            <span
              className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs ${
                state.connected ? "bg-emerald-500/10 text-emerald-300" : "bg-rose-500/10 text-rose-300"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${state.connected ? "bg-emerald-400" : "animate-pulse bg-rose-400"}`} />
              {state.connected ? "Connected" : "Waiting for the agent…"}
            </span>
          </div>
        </header>

        <SetupPanel state={state} send={send} />

        {state.canControl && state.acceptsTasks && <TaskComposer state={state} send={send} dismissNotice={dismissNotice} />}

        <RunHeader state={state} />
        <AgentRail state={state} />

        {approval && approval.via === "dashboard" && state.canControl && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
            <div className="flex items-start gap-3">
              <span className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />
              <div className="flex-1">
                <div className="font-medium">Approval needed</div>
                <div className="text-amber-200/80">{approval.message}</div>
                <div className="mt-1 text-xs text-amber-200/60">
                  Check the command or file in the feed below before you approve. Nothing runs until you answer.
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => send({ kind: "answer_approval", approved: false })}
                  className="rounded-lg border border-rose-500/50 px-3 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/10"
                >
                  Reject
                </button>
                <button
                  type="button"
                  onClick={() => send({ kind: "answer_approval", approved: true })}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
                >
                  Approve
                </button>
              </div>
            </div>
          </div>
        )}

        {approval && !(approval.via === "dashboard" && state.canControl) && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
            <span className="mt-0.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />
            <div>
              <div className="font-medium">
                {approval.via === "dashboard"
                  ? "Waiting for approval from the controlling dashboard"
                  : "Waiting for your answer in the terminal"}
              </div>
              <div className="text-amber-200/80">{approval.message}</div>
            </div>
          </div>
        )}

        <LiveFeed state={state} />
      </div>
    </div>
  );
}
