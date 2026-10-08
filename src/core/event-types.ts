// Wire protocol of the live dashboard. TYPES ONLY: no runtime imports, so the web app can
// `import type` from this file without pulling any Node code into the browser bundle.

export interface EventPayloads {
  // A top-level task started (opened by bus.withRun in the CLI).
  run_started: { task: string; workspace: string; origin: "terminal" | "dashboard" };
  // The orchestrator (router) is choosing a specialist.
  orchestrator_evaluating: { task: string };
  // The baton moved to a specialist. "forced" = the user picked the agent (-a / /use).
  // method "triage" = Gemini triage recommended the agent.
  agent_routed: { agentId: string; agentName: string; method: "keyword" | "llm" | "default" | "forced" | "triage" };
  // The executor has built its prompt and is about to call the model.
  executor_ready: { agentId: string; model: string; toolProtocol: "native" | "fenced"; stack: string[]; autoWrite: boolean };
  // One LLM round-trip started.
  llm_request: { step: number };
  // Model text for one step ("reply") or a sequentialthinking thought ("plan").
  agent_thinking: {
    source: "reply" | "plan";
    text: string;
    step?: number;
    label?: string;
    ttftMs?: number;
    tokPerSec?: number;
  };
  tool_running: { callId: string; tool: string; args: string };
  // Streamed stdout/stderr of run_command.
  tool_output: { callId: string; chunk: string };
  tool_result: { callId: string; ok: boolean; preview: string };
  // A y/n answer is needed. via="dashboard": answer with the buttons (run started from the browser);
  // via="terminal": the terminal owns the prompt and the dashboard only displays it.
  approval_requested: { message: string; via: "terminal" | "dashboard" };
  approval_resolved: { approved: boolean };
  // Chat startup questions (project path, auto-write, auto-run, triage). Answerable in the terminal
  // or the dashboard, whichever comes first. Emitted outside any run (runId "adhoc").
  setup_question: { id: string; kind: "confirm" | "text"; question: string; defaultValue?: string };
  setup_answered: { id: string; answer: string; via: "terminal" | "dashboard" };
  artifact_generated: { path: string; action: "created" | "overwritten" | "appended"; lines: number };
  run_completed: { steps: number; filesWritten: string[]; commandsRun: string[]; finalMessage: string };
  run_failed: { error: string };
}

export type AgentEventType = keyof EventPayloads;

// Discriminated union: narrowing on `type` gives the matching `payload`.
export type AgentEvent = {
  [K in AgentEventType]: {
    seq: number;
    ts: number;
    runId: string;
    // Who held the baton when the event was emitted ("orchestrator" or an agent id).
    agent: string;
    type: K;
    payload: EventPayloads[K];
  };
}[AgentEventType];

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
}

// Messages the server sends over the WebSocket.
export type ServerMessage =
  // canControl: this connection presented the control token and may send ClientCommands.
  // acceptsTasks: the session can take dashboard tasks (false during chat setup and in one-shot runs).
  | { kind: "hello"; version: 1; roster: AgentInfo[]; history: AgentEvent[]; canControl: boolean; acceptsTasks: boolean; busy: boolean }
  | { kind: "event"; event: AgentEvent }
  | { kind: "busy"; busy: boolean }
  | { kind: "session"; acceptsTasks: boolean }
  // Feedback for a command (rejected task, bad token, ...).
  | { kind: "notice"; level: "info" | "error"; text: string };

// Commands the browser may send. Only accepted from connections that presented the token.
export type ClientCommand =
  | { kind: "submit_task"; task: string; agentId?: string }
  | { kind: "answer_approval"; approved: boolean }
  // Answer to a setup_question: "yes"/"no" for confirm, free text otherwise.
  | { kind: "answer_question"; id: string; answer: string };
