// Wire protocol of the live dashboard. TYPES ONLY: no runtime imports, so the web app can
// `import type` from this file without pulling any Node code into the browser bundle.

export interface EventPayloads {
  // A top-level task started (opened by bus.withRun in the CLI).
  run_started: { task: string; workspace: string };
  // The orchestrator (router) is choosing a specialist.
  orchestrator_evaluating: { task: string };
  // The baton moved to a specialist. "forced" = the user picked the agent (-a / /use).
  agent_routed: { agentId: string; agentName: string; method: "keyword" | "llm" | "default" | "forced" };
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
  // The terminal is waiting for a y/n answer. The dashboard is read-only; answer in the terminal.
  approval_requested: { message: string };
  approval_resolved: { approved: boolean };
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
  | { kind: "hello"; version: 1; roster: AgentInfo[]; history: AgentEvent[] }
  | { kind: "event"; event: AgentEvent };
