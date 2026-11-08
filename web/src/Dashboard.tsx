import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { useAgentSocket } from "./useAgentSocket";
import { AgentRail } from "./components/AgentRail";
import { ApprovalBanner } from "./components/ApprovalBanner";
import { FilesPanel } from "./components/FilesPanel";
import { GuidePanel } from "./components/GuidePanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { LiveFeed } from "./components/LiveFeed";
import { PreviewPanel, type PreviewTarget } from "./components/PreviewPanel";
import { RunHeader } from "./components/RunHeader";
import { SettingsHub } from "./components/SettingsHub";
import { SetupPanel } from "./components/SetupPanel";
import { StackPanel } from "./components/StackPanel";
import { TaskComposer } from "./components/TaskComposer";
import { ThinkingPanel } from "./components/ThinkingPanel";
import { TokenPanel } from "./components/TokenPanel";
import { TreePanel } from "./components/TreePanel";
import { AgentsIcon, LiveIcon, MoreIcon, ProjectIcon, PromptIcon } from "./components/icons";
import { Workspace } from "./layout/Workspace";
import { useLayout } from "./layout/useLayout";
import { FILL_PANELS, hasPanel, PANEL_IDS, PANEL_TITLES, PRESETS, type PanelId } from "./layout/model";
import { useNotifications } from "./notifications";
import { loadIgnoreText, parseIgnoreText, saveIgnoreText } from "./prefs";
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

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

// Phone: one panel at a time, chosen with the bottom bar. "More" holds the rest.
const MORE_PANELS: PanelId[] = ["status", "tokens", "history", "settings", "stack", "guide"];

const PreviewIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

const MOBILE_TABS: { id: PanelId; label: string; icon: () => ReactElement }[] = [
  { id: "live", label: "Live", icon: LiveIcon },
  { id: "prompt", label: "Prompt", icon: PromptIcon },
  { id: "tree", label: "Project", icon: ProjectIcon },
  { id: "preview", label: "Preview", icon: PreviewIcon },
  { id: "agents", label: "Agents", icon: AgentsIcon },
  { id: "settings", label: "More", icon: MoreIcon },
];

function Menu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="min-h-10 rounded-lg px-3 text-sm font-medium text-slate-300 hover:bg-slate-900"
      >
        {label} ▾
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close menu" onClick={() => setOpen(false)} className="fixed inset-0 z-30 cursor-default" />
          <div role="menu" className="absolute left-0 top-full z-40 mt-1 w-60 overflow-hidden rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-xl">
            {children(() => setOpen(false))}
          </div>
        </>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [ignoreText, setIgnoreText] = useState(() => loadIgnoreText());
  const ignoreList = useMemo(() => parseIgnoreText(ignoreText), [ignoreText]);
  const { state, send, dismissNotice, requestFiles, stop } = useAgentSocket(WS_URL, ignoreList);
  useNotifications(state);

  const wide = useMediaQuery("(min-width: 1024px)");
  const { layout, actions, applyPreset, replace } = useLayout();
  const [mobilePanel, setMobilePanel] = useState<PanelId>("live");
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);

  const [pinned, setPinned] = useState<string | null>(() => loadPinned());
  const [context, setContext] = useState<string[]>([]);
  const [picker, setPicker] = useState(false);
  const [runs, setRuns] = useState<RunRecord[]>(() => loadRuns());
  const [usage, setUsage] = useState(() => loadUsage());
  const [remembered, setRemembered] = useState(() => Boolean(loadRememberedToken()));

  // Show a panel: on a wide screen in the layout, on a phone as the current screen.
  const openPanel = useCallback(
    (panel: PanelId) => {
      if (wide) actions.open(panel);
      else setMobilePanel(panel);
    },
    [wide, actions],
  );

  const changeIgnore = useCallback((text: string) => {
    setIgnoreText(text);
    saveIgnoreText(text);
  }, []);

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

  // Load the project tree as soon as the agent can take tasks (the project folder is known by then), and again
  // whenever the ignore list changes. After that the file watcher keeps it live.
  useEffect(() => {
    if (state.canControl && state.connected && state.acceptsTasks) requestFiles();
  }, [state.canControl, state.connected, state.acceptsTasks, ignoreList, requestFiles]);

  // Fallback for platforms without a file watcher: refresh after every written file and when a run ends.
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

  const renderPanel = (id: PanelId): ReactNode => {
    switch (id) {
      case "live":
        return <LiveFeed state={state} fill />;
      case "tree":
        return (
          <TreePanel
            tree={state.files}
            connected={state.connected}
            canControl={state.canControl}
            touched={state.run?.filesWritten ?? []}
            changed={state.changed}
            changeTick={state.changeTick}
            context={context}
            onContextChange={setContext}
            onRefresh={requestFiles}
            ignoreText={ignoreText}
            onOpenSettings={() => openPanel("settings")}
            onPreviewFile={(path) => {
              setPreviewTarget({ kind: "file", path });
              openPanel("preview");
            }}
          />
        );
      case "preview":
        return <PreviewPanel state={state} send={send} pinned={pinned} target={previewTarget} onTargetChange={setPreviewTarget} />;
      case "prompt":
        return (
          composer || (
            <p className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">
              {state.canControl
                ? "The agent is not ready for prompts yet. Answer the startup questions first."
                : "Prompts need the control token: open the full URL printed in the terminal."}
            </p>
          )
        );
      case "status":
        return (
          <div className="flex flex-col gap-4">
            <RunHeader state={state} />
            <ThinkingPanel state={state} stop={stop} />
          </div>
        );
      case "agents":
        return <AgentRail state={state} pinned={pinned} onPin={pin} />;
      case "tokens":
        return <TokenPanel usage={usage} sessionKeys={sessionKeys} roster={state.roster} />;
      case "history":
        return (
          <HistoryPanel
            runs={runs}
            names={names}
            onClear={() => {
              clearRuns();
              setRuns([]);
            }}
          />
        );
      case "settings":
        return (
          <SettingsHub
            state={state}
            send={send}
            ignoreText={ignoreText}
            onIgnoreChange={changeIgnore}
            layout={layout}
            onOpenPanel={actions.open}
            onClosePanel={actions.close}
            onPreset={applyPreset}
            onReplaceLayout={replace}
            onOpenGuide={() => openPanel("guide")}
            showLayout={wide}
          />
        );
      case "stack":
        return <StackPanel state={state} wsUrl={WS_URL} />;
      case "guide":
        return <GuidePanel onBack={() => (wide ? actions.close("guide") : setMobilePanel("settings"))} />;
    }
  };

  const filesPicker = (
    <FilesPanel
      tree={state.files}
      connected={state.connected}
      canControl={state.canControl}
      touched={state.run?.filesWritten ?? []}
      context={context}
      onContextChange={setContext}
      onRefresh={requestFiles}
      onUse={() => setPicker(false)}
      modal
    />
  );

  const menuItem = "flex min-h-10 w-full items-center justify-between px-3 text-left text-sm text-slate-200 hover:bg-slate-800";

  return (
    <div className="flex h-dvh flex-col bg-slate-950 text-slate-100">
      <header className="shrink-0 border-b border-slate-800 bg-slate-950 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Agent Mustafa</h1>

          {wide && (
            <nav aria-label="Layout" className="ml-3 flex gap-1">
              <Menu label="Panels">
                {(close) =>
                  PANEL_IDS.map((id) => {
                    const open = hasPanel(layout, id);
                    return (
                      <div key={id} className="flex items-center hover:bg-slate-800">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            actions.open(id);
                            close();
                          }}
                          className="flex min-h-10 flex-1 items-center gap-2 px-3 text-left text-sm text-slate-200"
                        >
                          <span className={`w-3 ${open ? "text-teal-300" : "text-transparent"}`}>✓</span>
                          {PANEL_TITLES[id]}
                        </button>
                        {open && (
                          <button type="button" aria-label={`Close ${PANEL_TITLES[id]}`} onClick={() => actions.close(id)} className="min-h-10 px-3 text-slate-400 hover:text-slate-100">
                            ✕
                          </button>
                        )}
                      </div>
                    );
                  })
                }
              </Menu>
              <Menu label="Layout">
                {(close) => (
                  <>
                    {PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        role="menuitem"
                        title={p.hint}
                        onClick={() => {
                          applyPreset(p.id);
                          close();
                        }}
                        className={menuItem}
                      >
                        {p.label}
                      </button>
                    ))}
                    <div className="my-1 border-t border-slate-800" />
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        applyPreset("coding");
                        close();
                      }}
                      className={menuItem}
                    >
                      Reset layout
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        actions.open("settings");
                        close();
                      }}
                      className={menuItem}
                    >
                      Export / import…
                    </button>
                  </>
                )}
              </Menu>
            </nav>
          )}

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
            <span className={`flex items-center gap-2 rounded-full px-3 py-1 ${state.connected ? "bg-emerald-400/10 text-emerald-300" : "bg-rose-400/10 text-rose-300"}`}>
              <span className={`h-2 w-2 rounded-full ${state.connected ? "bg-emerald-400" : "animate-pulse bg-rose-400"}`} />
              {state.connected ? "Connected" : "Reconnecting…"}
            </span>
          </div>
        </div>
      </header>

      <main className="flex min-h-0 w-full flex-1 flex-col gap-3 px-3 py-3">
        <SetupPanel state={state} send={send} />
        <ApprovalBanner state={state} send={send} />

        <div className="min-h-0 flex-1">
          {wide ? (
            <Workspace layout={layout} actions={actions} renderPanel={renderPanel} />
          ) : (
            <div className="flex h-full min-h-0 flex-col gap-2">
              {MORE_PANELS.includes(mobilePanel) && (
                <div role="tablist" aria-label="More" className="flex shrink-0 gap-1 overflow-x-auto">
                  {MORE_PANELS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={mobilePanel === id}
                      onClick={() => setMobilePanel(id)}
                      className={`min-h-10 shrink-0 rounded-lg px-3 text-xs font-medium ${mobilePanel === id ? "bg-slate-800 text-teal-300" : "text-slate-300"}`}
                    >
                      {PANEL_TITLES[id]}
                    </button>
                  ))}
                </div>
              )}
              <div className={`min-h-0 flex-1 ${FILL_PANELS.has(mobilePanel) ? "overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60" : "overflow-y-auto"}`}>
                {renderPanel(mobilePanel)}
              </div>
            </div>
          )}
        </div>
      </main>

      {!wide && (
        <nav aria-label="Tabs" className="flex shrink-0 border-t border-slate-800 bg-slate-900 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5">
          {MOBILE_TABS.map(({ id, label, icon: Icon }) => {
            const on = mobilePanel === id || (id === "settings" && MORE_PANELS.includes(mobilePanel));
            return (
              <button
                key={id}
                type="button"
                aria-current={on ? "page" : undefined}
                onClick={() => setMobilePanel(id)}
                className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${on ? "text-teal-300" : "text-slate-400"}`}
              >
                <Icon />
                {label}
              </button>
            );
          })}
        </nav>
      )}

      {picker && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onClick={() => setPicker(false)} role="presentation">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Add files to the prompt"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-t-3xl border border-slate-700 bg-slate-900 p-4 sm:rounded-3xl"
          >
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-base font-semibold">Add files to the prompt</h2>
              <button type="button" onClick={() => setPicker(false)} aria-label="Close" className="min-h-11 min-w-11 rounded-xl text-slate-300 hover:bg-slate-800">
                ✕
              </button>
            </div>
            {filesPicker}
          </div>
        </div>
      )}
    </div>
  );
}
