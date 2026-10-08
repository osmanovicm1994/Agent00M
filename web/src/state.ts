import type { AgentEvent, AgentInfo } from "./protocol";

const FEED_LIMIT = 400;
const OUTPUT_LIMIT = 20_000;

export type ToolStatus = "running" | "ok" | "error";

interface FeedBase {
  id: number;
  ts: number;
  // Agent that held the baton when this happened.
  agent: string;
}

export type FeedItem =
  | (FeedBase & { kind: "note"; text: string })
  | (FeedBase & { kind: "thinking"; label: string; text: string })
  | (FeedBase & {
      kind: "tool";
      callId: string;
      tool: string;
      args: string;
      status: ToolStatus;
      output: string;
      preview: string;
    })
  | (FeedBase & { kind: "artifact"; path: string; action: string; lines: number })
  | (FeedBase & { kind: "final"; text: string })
  | (FeedBase & { kind: "error"; text: string });

export type RunStatus = "running" | "done" | "failed";

export interface RunInfo {
  runId: string;
  task: string;
  workspace: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  model?: string;
  toolProtocol?: string;
  stack: string[];
  autoWrite: boolean;
  routeMethod?: string;
  steps?: number;
  filesWritten: string[];
  commandsRun: string[];
}

export interface DashboardState {
  connected: boolean;
  roster: AgentInfo[];
  // Who holds the baton right now ("orchestrator", an agent id, or null when idle).
  activeAgent: string | null;
  // The specialist the last run was routed to (kept after the run ends).
  lastAgent: string | null;
  run: RunInfo | null;
  feed: FeedItem[];
  // A y/n answer is needed: via "dashboard" the buttons answer it, via "terminal" it is display-only.
  pendingApproval: { message: string; via: "terminal" | "dashboard" } | null;
  // An LLM request is in flight.
  llmWaiting: boolean;
  // True when this page presented the control token (it may answer questions and approvals).
  canControl: boolean;
  // The session can take tasks from the dashboard (false during chat setup and in one-shot runs).
  acceptsTasks: boolean;
  // An open chat startup question (project path, auto-write, auto-run, triage).
  pendingQuestion: { id: string; kind: "confirm" | "text"; question: string; defaultValue?: string } | null;
  // An agent run is in progress (started from the terminal or the dashboard).
  busy: boolean;
  notice: { level: "info" | "error"; text: string } | null;
}

export const initialState: DashboardState = {
  connected: false,
  roster: [],
  activeAgent: null,
  lastAgent: null,
  run: null,
  feed: [],
  pendingApproval: null,
  llmWaiting: false,
  canControl: false,
  acceptsTasks: false,
  pendingQuestion: null,
  busy: false,
  notice: null,
};

export type Action =
  | { type: "connection"; connected: boolean }
  | { type: "hello"; roster: AgentInfo[]; history: AgentEvent[]; canControl: boolean; acceptsTasks: boolean; busy: boolean }
  | { type: "session"; acceptsTasks: boolean }
  | { type: "event"; event: AgentEvent }
  | { type: "busy"; busy: boolean }
  | { type: "notice"; level: "info" | "error"; text: string }
  | { type: "dismiss_notice" };

function patchRun(state: DashboardState, patch: Partial<RunInfo>): RunInfo | null {
  return state.run ? { ...state.run, ...patch } : null;
}

export function applyEvent(state: DashboardState, e: AgentEvent): DashboardState {
  const base = { id: e.seq, ts: e.ts, agent: e.agent };
  const push = (item: FeedItem): FeedItem[] => [...state.feed, item].slice(-FEED_LIMIT);

  switch (e.type) {
    case "run_started":
      return {
        ...state,
        activeAgent: "orchestrator",
        lastAgent: null,
        llmWaiting: false,
        pendingApproval: null,
        run: {
          runId: e.runId,
          task: e.payload.task,
          workspace: e.payload.workspace,
          status: "running",
          startedAt: e.ts,
          stack: [],
          autoWrite: false,
          filesWritten: [],
          commandsRun: [],
        },
        feed: [{ ...base, kind: "note", text: `Task received: ${e.payload.task}` }],
      };

    case "orchestrator_evaluating":
      return {
        ...state,
        activeAgent: "orchestrator",
        feed: push({ ...base, kind: "note", text: "Orchestrator is deciding which specialist should take this task…" }),
      };

    case "agent_routed":
      return {
        ...state,
        activeAgent: e.payload.agentId,
        lastAgent: e.payload.agentId,
        run: patchRun(state, { routeMethod: e.payload.method }),
        feed: push({
          ...base,
          agent: e.payload.agentId,
          kind: "note",
          text: `Baton passed to ${e.payload.agentName} (${e.payload.method === "forced" ? "chosen by you" : `routed by ${e.payload.method}`})`,
        }),
      };

    case "executor_ready":
      return {
        ...state,
        // Safety net: whatever way the agent was chosen, the executor knows who is working now.
        activeAgent: e.payload.agentId,
        lastAgent: e.payload.agentId,
        run: patchRun(state, {
          model: e.payload.model,
          toolProtocol: e.payload.toolProtocol,
          stack: e.payload.stack,
          autoWrite: e.payload.autoWrite,
        }),
        feed: push({
          ...base,
          kind: "note",
          text: `Ready: ${e.payload.model} · ${e.payload.toolProtocol === "native" ? "native tool calls" : "fenced-block tools"}${e.payload.autoWrite ? " · auto mode" : ""}`,
        }),
      };

    case "llm_request":
      return { ...state, llmWaiting: true };

    case "agent_thinking": {
      const speed = e.payload.tokPerSec ? ` · ${e.payload.tokPerSec.toFixed(1)} tok/s` : "";
      const label =
        (e.payload.label ?? (e.payload.source === "plan" ? "plan" : `step ${e.payload.step ?? "?"}`)) + speed;
      return {
        ...state,
        llmWaiting: e.payload.source === "plan" ? state.llmWaiting : false,
        feed: push({ ...base, kind: "thinking", label, text: e.payload.text }),
      };
    }

    case "tool_running":
      return {
        ...state,
        llmWaiting: false,
        feed: push({
          ...base,
          kind: "tool",
          callId: e.payload.callId,
          tool: e.payload.tool,
          args: e.payload.args,
          status: "running",
          output: "",
          preview: "",
        }),
      };

    case "tool_output":
      return {
        ...state,
        feed: state.feed.map((item) =>
          item.kind === "tool" && item.callId === e.payload.callId
            ? { ...item, output: (item.output + e.payload.chunk).slice(-OUTPUT_LIMIT) }
            : item,
        ),
      };

    case "tool_result":
      return {
        ...state,
        feed: state.feed.map((item) =>
          item.kind === "tool" && item.callId === e.payload.callId
            ? { ...item, status: e.payload.ok ? "ok" : "error", preview: e.payload.preview }
            : item,
        ),
      };

    case "setup_question":
      return { ...state, pendingQuestion: { id: e.payload.id, kind: e.payload.kind, question: e.payload.question, defaultValue: e.payload.defaultValue } };

    case "setup_answered":
      return {
        ...state,
        pendingQuestion: state.pendingQuestion?.id === e.payload.id ? null : state.pendingQuestion,
        feed: push({
          ...base,
          kind: "note",
          text: `Setup: ${state.pendingQuestion?.id === e.payload.id ? state.pendingQuestion.question : "question"} → ${e.payload.answer || "(default)"} (${e.payload.via})`,
        }),
      };

    case "approval_requested":
      return { ...state, pendingApproval: { message: e.payload.message, via: e.payload.via } };

    case "approval_resolved":
      return {
        ...state,
        pendingApproval: null,
        feed: push({
          ...base,
          kind: "note",
          text: e.payload.approved ? "You approved the action in the terminal." : "You rejected the action in the terminal.",
        }),
      };

    case "artifact_generated":
      return {
        ...state,
        feed: push({ ...base, kind: "artifact", path: e.payload.path, action: e.payload.action, lines: e.payload.lines }),
      };

    case "run_completed":
      return {
        ...state,
        activeAgent: null,
        llmWaiting: false,
        pendingApproval: null,
        run: patchRun(state, {
          status: "done",
          endedAt: e.ts,
          steps: e.payload.steps,
          filesWritten: e.payload.filesWritten,
          commandsRun: e.payload.commandsRun,
        }),
        feed: push({ ...base, kind: "final", text: e.payload.finalMessage }),
      };

    case "run_failed":
      return {
        ...state,
        activeAgent: null,
        llmWaiting: false,
        pendingApproval: null,
        run: patchRun(state, { status: "failed", endedAt: e.ts }),
        feed: push({ ...base, kind: "error", text: e.payload.error }),
      };
  }
}

export function reducer(state: DashboardState, action: Action): DashboardState {
  switch (action.type) {
    case "connection":
      return { ...state, connected: action.connected };
    case "hello":
      // A (re)connect replays the server's history from scratch, so start from a clean slate.
      return action.history.reduce(applyEvent, {
        ...initialState,
        connected: true,
        roster: action.roster,
        canControl: action.canControl,
        acceptsTasks: action.acceptsTasks,
        busy: action.busy,
      });
    case "session":
      return { ...state, acceptsTasks: action.acceptsTasks };
    case "event":
      return applyEvent(state, action.event);
    case "busy":
      return { ...state, busy: action.busy };
    case "notice":
      return { ...state, notice: { level: action.level, text: action.text } };
    case "dismiss_notice":
      return { ...state, notice: null };
  }
}
