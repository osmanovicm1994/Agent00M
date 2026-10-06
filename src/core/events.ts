// In-process event bus. The router and executor only ever call bus.emit(); they never import a
// web server, so the same core runs from the CLI, the dashboard, or a test with no changes.
// Nothing listening = emit is a cheap no-op (plus a bounded history buffer).

import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import type { AgentEvent, AgentEventType, EventPayloads } from "./event-types";

export type { AgentEvent, AgentEventType, EventPayloads } from "./event-types";

type Listener = (event: AgentEvent) => void;

// Per-run context carried through every await, so emit() knows which run and which agent it
// belongs to without threading extra parameters through router/executor.
interface RunScope {
  runId: string;
  agent: string;
}

// Late-joining dashboards replay this buffer. Keep it small: events carry text previews.
const HISTORY_LIMIT = Number(process.env.AGENT_UI_HISTORY) || 400;

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (+${text.length - max} chars)` : text;
}

class EventBus {
  private readonly listeners = new Set<Listener>();
  private readonly scope = new AsyncLocalStorage<RunScope>();
  private readonly history: AgentEvent[] = [];
  private seq = 0;

  emit<T extends AgentEventType>(type: T, payload: EventPayloads[T]): void {
    const ctx = this.scope.getStore();
    const event = {
      seq: ++this.seq,
      ts: Date.now(),
      runId: ctx?.runId ?? "adhoc",
      agent: ctx?.agent ?? "orchestrator",
      type,
      payload,
    } as AgentEvent;

    this.history.push(event);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);

    // A broken subscriber must never break the agent.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Recent events, oldest first.
  snapshot(): AgentEvent[] {
    return [...this.history];
  }

  // Marks which agent holds the baton for the rest of the current run.
  setAgent(agentId: string): void {
    const ctx = this.scope.getStore();
    if (ctx) ctx.agent = agentId;
  }

  // Opens one observable run: emits run_started, and run_failed if fn throws.
  // (run_completed is emitted by Executor.run, which knows the result.)
  async withRun<T>(info: { task: string; workspace: string }, fn: () => Promise<T>): Promise<T> {
    return this.scope.run({ runId: randomUUID(), agent: "orchestrator" }, async () => {
      this.emit("run_started", { task: truncate(info.task, 2000), workspace: info.workspace });
      try {
        return await fn();
      } catch (err: any) {
        this.emit("run_failed", { error: truncate(String(err?.message ?? err), 2000) });
        throw err;
      }
    });
  }
}

export const bus = new EventBus();
