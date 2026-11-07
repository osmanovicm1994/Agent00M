import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useAgentSocket } from "./useAgentSocket";
import { AgentRail } from "./components/AgentRail";
import { ApprovalBanner } from "./components/ApprovalBanner";
import { FilesPanel } from "./components/FilesPanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { LiveFeed } from "./components/LiveFeed";
import { RunHeader } from "./components/RunHeader";
import { SetupPanel } from "./components/SetupPanel";
import { StackPanel } from "./components/StackPanel";
import { TaskComposer } from "./components/TaskComposer";
import { ThinkingPanel } from "./components/ThinkingPanel";
import { TokenPanel } from "./components/TokenPanel";
import { GuidePanel } from "./components/GuidePanel";
import { SettingsScreen } from "./components/SettingsScreen";
import { useNotifications } from "./notifications";
import { AgentsIcon, HistoryIcon, LiveIcon, MoreIcon, ProjectIcon, PromptIcon } from "./components/icons";
import {
  clearRuns,
  forgetToken,
  loadPinned,
  loadRememberedToken,
  loadRuns,
  loadUsage,
  mergeUsage,
  rememberToken,
  savePinned,
  upsertRun,
  type RunRecord,
} from "./storage";

// Where the socket lives:
//  - Page served over HTTPS (remote access through Tailscale Serve): same origin, wss://<host>/ws.
//    Vite forwards /ws to the agent, so one HTTPS URL carries both the page and the socket.
//  - Plain HTTP (localhost or a phone on the LAN): the same host on port 3001, e.g.
//    http://192.168.x.x:5173 -> ws://192.168.x.x:3001/ws.
// Override with VITE_AGENT_WS if the agent runs on another port (AGENT_UI_PORT).
const WS_HOST = window.location.hostname === "localhost" ? "127.0.0.1" : window.location.hostname;
const WS_DEFAULT = window.location.protocol === "https:" ? `wss://${window.location.host}/ws` : `ws://${WS_HOST}:3001/ws`;
const WS_BASE: string = import.meta.env.VITE_AGENT_WS ?? WS_DEFAULT;
const TOKEN_KEY = "agent-ui-token";

// The control token comes from the URL the agent prints in the terminal (?token=...). It is kept
// for this tab and removed from the address bar so it does not end up in screenshots. On an iPhone
// home-screen app the tab storage is lost on relaunch, so the token can also be remembered on this
// device on request (the "Remember" button in the header).
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
  return token ?? loadRememberedToken();
}

const TOKEN = readToken();
const WS_URL = TOKEN ? `${WS_BASE}?token=${encodeURIComponent(TOKEN)}` : WS_BASE;

// agents / prompt / project make up the Monitor (all three side by side on a wide screen, one at a time on a phone).
// live, history and stack are screens of their own.
// settings (notifications) and guide (the prompting tutorial) are screens of their own too.
type View = "agents" | "live" | "prompt" | "project" | "history" | "stack" | "settings" | "guide";
const MONITOR_VIEWS: View[] = ["agents", "prompt", "project"];

const MOBILE_TABS: { id: View; label: string; icon: () => ReactElement }[] = [
  { id: "agents", label: "Agents", icon: AgentsIcon },
  { id: "live", label: "Live", icon: LiveIcon },
  { id: "prompt", label: "Prompt", icon: PromptIcon },
  { id: "project", label: "Project", icon: ProjectIcon },
  { id: "history", label: "History", icon: HistoryIcon },
  { id: "settings", label: "More", icon: MoreIcon },
];

const DESKTOP_TABS: { id: View; label: string }[] = [
  { id: "agents", label: "Monitor" },
  { id: "live", label: "Live" },
  { id: "history", label: "History" },
  { id: "stack", label: "Stack" },
  { id: "guide", label: "Guide" },
  { id: "settings", label: "Settings" },
];

export default function Dashboard() {
  const { state, send, dismissNotice, requestFiles, stop } = useAgentSocket(WS_URL);
  useNotifications(state);
  const [view, setView] = useState<View>("agents");
  const [pinned, setPinned] = useState<string | null>(() => loadPinned());
  const [context, setContext] = useState<string[]>([]);
  const [picker, setPicker] = useState(false);
  const [runs, setRuns] = useState<RunRecord[]>(() => loadRuns());
  const [usage, setUsage] = useState(() => loadUsage());
  const [remembered, setRemembered] = useState(() => Boolean(loadRememberedToken()));

  const monitorOn = MONITOR_VIEWS.includes(view);
  // Phone: one screen at a time. Wide screen: the whole Monitor is visible, so a panel also shows there.
  const vis = (name: View): string => (view === name ? "" : monitorOn ? "hidden lg:block" : "hidden");

  // A pinned agent that no longer exists (renamed roster) falls back to auto routing.
  useEffect(() => {
    if (pinned && state.roster.length > 0 && !state.roster.some((a) => a.id === pinned)) {
      setPinned(null);
      savePinned(null);
    }
  }, [pinned, state.roster]);

  const pin = useCallback((id: string | null) => {
    setPinned(id);
    savePinned(id);
  }, []);

  const toggleTeam = useCallback(
    (on: boolean) => {
      send({ kind: "set_team", on });
    },
    [send],
  );

  // Escape closes the file picker.
  useEffect(() => {
    if (!picker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicker(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picker]);

  // Keep the project tree fresh: after every written file and when a run ends.
  const artifactCount = useMemo(() => state.feed.filter((i) => i.kind === "artifact").length, [state.feed]);
  const runStatus = state.run?.status;
  useEffect(() => {
    if (state.canControl && state.connected && state.files) requestFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactCount, runStatus]);

  // Keep token usage on this device; merging by key means a replayed history is never counted twice.
  useEffect(() => {
    if (state.usage.length > 0) setUsage(mergeUsage(state.usage));
  }, [state.usage]);

  // Save the current run into the history whenever it changes.
  const run = state.run;
  const lastText = useMemo(() => {
    for (let i = state.feed.length - 1; i >= 0; i--) {
      const item = state.feed[i];
      if (item.kind === "final" || item.kind === "error") return item.text.slice(0, 1500);
    }
    return undefined;
  }, [state.feed]);

  useEffect(() => {
    if (!run) return;
    const mine = state.usage.filter((u) => u.runId === run.runId);
    setRuns(
      upsertRun({
        runId: run.runId,
        task: run.task,
        agent: state.lastAgent,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        model: run.model,
        steps: run.steps,
        filesWritten: run.filesWritten,
        commandsRun: run.commandsRun,
        workspace: run.workspace,
        promptTokens: mine.reduce((a, u) => a + u.prompt, 0),
        completionTokens: mine.reduce((a, u) => a + u.completion, 0),
        summary: lastText,
      }),
    );
  }, [run, state.lastAgent, state.usage, lastText]);

  const sessionKeys = useMemo(() => new Set(state.usage.map((u) => u.key)), [state.usage]);
  const names = useMemo(() => new Map(state.roster.map((a) => [a.id, a.name])), [state.roster]);

  const toggleRemember = () => {
    if (!TOKEN) return;
    if (remembered) forgetToken();
    else rememberToken(TOKEN);
    setRemembered(!remembered);
  };

  const composer = state.canControl && state.acceptsTasks && (
    <TaskComposer
      state={state}
      send={send}
      dismissNotice={dismissNotice}
      pinned={pinned}
      context={context}
      onContextChange={setContext}
      onAddFiles={() => {
        setPicker(true);
        if (state.canControl) requestFiles();
      }}
      onToggleTeam={toggleTeam}
    />
  );

  const filesPanel = (modal: boolean) => (
    <FilesPanel
      tree={state.files}
      connected={state.connected}
      canControl={state.canControl}
      touched={state.run?.filesWritten ?? []}
      context={context}
      onContextChange={setContext}
      onRefresh={requestFiles}
      onUse={() => {
        if (modal) setPicker(false);
        else setView("prompt");
      }}
      modal={modal}
    />
  );

  return (
    <div className="flex h-dvh flex-col bg-slate-950 text-slate-100">
      <header className="shrink-0 border-b border-slate-800 bg-slate-950 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="mx-auto flex max-w-[110rem] items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Agent Mustafa</h1>

          <nav aria-label="Screens" className="ml-4 hidden gap-1 lg:flex">
            {DESKTOP_TABS.map(({ id, label }) => {
              const on = id === "agents" ? monitorOn : view === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-current={on ? "page" : undefined}
                  onClick={() => setView(id === "agents" && monitorOn ? view : id)}
                  className={`min-h-10 rounded-lg px-4 text-sm font-medium ${on ? "bg-slate-800 text-teal-300" : "text-slate-300 hover:bg-slate-900"}`}
                >
                  {label}
                </button>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2 text-xs">
            {state.team && <span className="rounded-full bg-sky-300/10 px-3 py-1 text-sky-300">Team</span>}
            {state.canControl && TOKEN && (
              <button
                type="button"
                onClick={toggleRemember}
                aria-pressed={remembered}
                title="Keep the control token on this device so the home-screen app stays signed in"
                className="hidden min-h-10 rounded-full border border-slate-700 px-3 text-slate-300 hover:bg-slate-900 sm:block"
              >
                {remembered ? "Forget token" : "Remember on this device"}
              </button>
            )}
            <span
              className={`rounded-full px-3 py-1 ${state.canControl ? "bg-teal-300/10 text-teal-300" : "bg-slate-800 text-slate-300"}`}
              title={state.canControl ? "You can send tasks and answer approvals from here" : "Open the URL printed by `npm run chat:ui` to get control"}
            >
              {state.canControl ? "Control" : "Read-only"}
            </span>
            <span
              className={`flex items-center gap-2 rounded-full px-3 py-1 ${state.connected ? "bg-emerald-400/10 text-emerald-300" : "bg-rose-400/10 text-rose-300"}`}
            >
              <span className={`h-2 w-2 rounded-full ${state.connected ? "bg-emerald-400" : "animate-pulse bg-rose-400"}`} />
              {state.connected ? "Connected" : "Reconnecting…"}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-[110rem] flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 lg:overflow-hidden">
        <SetupPanel state={state} send={send} />
        <ApprovalBanner state={state} send={send} />

        {/* Monitor: Agents | status + prompt | tokens + project. Each column scrolls on its own on a wide screen. */}
        <div className={monitorOn ? "flex flex-col gap-4 lg:grid lg:min-h-0 lg:flex-1 lg:grid-cols-[21rem_minmax(0,1fr)_22rem]" : "hidden"}>
          <div className="flex flex-col gap-4 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            <div className={vis("agents")}>
              <AgentRail state={state} pinned={pinned} onPin={pin} />
            </div>
          </div>

          <div className="flex flex-col gap-4 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            <div className="hidden lg:block">
              <RunHeader state={state} />
            </div>
            <div className="hidden lg:block">
              <ThinkingPanel state={state} stop={stop} />
            </div>
            <div className={vis("prompt")}>
              {composer || (
                <p className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">
                  {state.canControl
                    ? "The agent is not ready for prompts yet. Answer the startup questions first."
                    : "Prompts need the control token: open the full URL printed in the terminal."}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-4 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            <div className={vis("agents")}>
              <TokenPanel usage={usage} sessionKeys={sessionKeys} roster={state.roster} />
            </div>
            <div className={vis("project")}>
              {filesPanel(false)}
              <button
                type="button"
                onClick={() => setView("stack")}
                className="mt-3 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 text-sm font-medium hover:bg-slate-800 lg:hidden"
              >
                Stack details
              </button>
            </div>
          </div>
        </div>

        {/* Live: what the agent is doing on the left, the full detailed feed filling the rest. */}
        <div className={view === "live" ? "flex flex-col gap-4 lg:min-h-0 lg:flex-1 lg:flex-row" : "hidden"}>
          <div className="flex flex-col gap-4 lg:w-[24rem] lg:shrink-0 lg:overflow-y-auto lg:pr-1">
            <RunHeader state={state} />
            <ThinkingPanel state={state} stop={stop} />
          </div>
          <div className="h-[70vh] lg:h-auto lg:min-h-0 lg:flex-1">
            <LiveFeed state={state} fill />
          </div>
        </div>

        <div className={view === "history" ? "lg:min-h-0 lg:flex-1 lg:overflow-y-auto" : "hidden"}>
          <HistoryPanel
            runs={runs}
            names={names}
            onClear={() => {
              clearRuns();
              setRuns([]);
            }}
          />
        </div>

        <div className={view === "stack" ? "lg:min-h-0 lg:flex-1 lg:overflow-y-auto" : "hidden"}>
          <StackPanel state={state} wsUrl={WS_URL} />
        </div>

        <div className={view === "settings" ? "lg:min-h-0 lg:flex-1 lg:overflow-y-auto" : "hidden"}>
          <SettingsScreen onOpenGuide={() => setView("guide")} />
        </div>

        <div className={view === "guide" ? "lg:min-h-0 lg:flex-1 lg:overflow-y-auto" : "hidden"}>
          <GuidePanel onBack={() => setView("settings")} />
        </div>
      </main>

      <nav
        aria-label="Tabs"
        className="flex shrink-0 border-t border-slate-800 bg-slate-900 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 lg:hidden"
      >
        {MOBILE_TABS.map(({ id, label, icon: Icon }) => {
          const on = view === id || (id === "project" && view === "stack") || (id === "settings" && view === "guide");
          return (
            <button
              key={id}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => setView(id)}
              className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${on ? "text-teal-300" : "text-slate-400"}`}
            >
              <Icon />
              {label}
            </button>
          );
        })}
      </nav>

      {picker && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
          onClick={() => setPicker(false)}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Add files to the prompt"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-t-3xl border border-slate-700 bg-slate-900 p-4 sm:rounded-3xl"
          >
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-base font-semibold">Add files to the prompt</h2>
              <button
                type="button"
                onClick={() => setPicker(false)}
                aria-label="Close"
                className="min-h-11 min-w-11 rounded-xl text-slate-300 hover:bg-slate-800"
              >
                ✕
              </button>
            </div>
            {filesPanel(true)}
          </div>
        </div>
      )}
    </div>
  );
}
