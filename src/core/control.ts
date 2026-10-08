// Control channel: lets the dashboard drive the agent (send tasks, answer approvals, answer the
// chat startup questions). Like the event bus it is UI-agnostic: the server only calls
// submitTask()/answerApproval()/answerQuestion(); the CLI registers what a task does, and the
// executor asks requestApproval() for runs that were started from the browser. With nothing
// registered, everything here is inert.

import { randomUUID } from "crypto";
import { bus } from "./events";

export const MAX_TASK_CHARS = 8000;
export const MAX_ANSWER_CHARS = 1000;

// Plain shape (not a union) so it type-checks the same with or without strict mode.
export interface SubmitResult {
  ok: boolean;
  reason?: string;
}

export interface QuestionSpec {
  kind: "confirm" | "text";
  question: string;
  defaultValue?: string;
}

export interface QuestionAnswer {
  answer: string;
  via: "terminal" | "dashboard";
}

type TaskHandler = (task: string, agentId?: string) => Promise<void>;
type BusyListener = (busy: boolean) => void;
type SessionListener = (acceptsTasks: boolean) => void;

class ControlHub {
  private busy = false;
  private handler: TaskHandler | undefined;
  private pending: ((approved: boolean) => void) | undefined;
  private question: { id: string; kind: QuestionSpec["kind"]; answer: (value: string) => void } | undefined;
  private readonly busyListeners = new Set<BusyListener>();
  private readonly sessionListeners = new Set<SessionListener>();

  // --- one run at a time (shared by terminal input and dashboard tasks) ---

  isBusy(): boolean {
    return this.busy;
  }

  // Returns false if another run is in progress. Pair every true with release().
  tryAcquire(): boolean {
    if (this.busy) return false;
    this.busy = true;
    this.notifyBusy();
    return true;
  }

  release(): void {
    if (!this.busy) return;
    this.busy = false;
    this.notifyBusy();
  }

  onBusyChange(listener: BusyListener): () => void {
    this.busyListeners.add(listener);
    return () => {
      this.busyListeners.delete(listener);
    };
  }

  private notifyBusy(): void {
    for (const l of this.busyListeners) {
      try {
        l(this.busy);
      } catch {
        // a broken listener must not break the agent
      }
    }
  }

  // --- tasks from the dashboard ---

  // The CLI registers this once the chat setup is done. One-shot `run --serve` never does, so the
  // dashboard stays watch-only there.
  setTaskHandler(handler: TaskHandler | undefined): void {
    this.handler = handler;
    for (const l of this.sessionListeners) {
      try {
        l(this.acceptsTasks());
      } catch {
        // ignore
      }
    }
  }

  acceptsTasks(): boolean {
    return this.handler !== undefined;
  }

  onSessionChange(listener: SessionListener): () => void {
    this.sessionListeners.add(listener);
    return () => {
      this.sessionListeners.delete(listener);
    };
  }

  submitTask(rawTask: string, agentId?: string): SubmitResult {
    const task = String(rawTask ?? "").trim();
    if (!this.handler) return { ok: false, reason: "The agent is not ready for tasks yet (answer the startup questions first, or this is a watch-only session)." };
    if (!task) return { ok: false, reason: "The task is empty." };
    if (task.length > MAX_TASK_CHARS) return { ok: false, reason: `The task is too long (max ${MAX_TASK_CHARS} characters).` };
    if (!this.tryAcquire()) return { ok: false, reason: "The agent is busy with another task." };

    // The handler owns its own error reporting; release in all cases.
    void this.handler(task, agentId)
      .catch(() => undefined)
      .finally(() => this.release());
    return { ok: true };
  }

  // --- approvals for runs started from the dashboard ---

  requestApproval(): Promise<boolean> {
    this.pending?.(false); // never leave an older question hanging
    return new Promise<boolean>((resolve) => {
      this.pending = resolve;
    });
  }

  hasPendingApproval(): boolean {
    return this.pending !== undefined;
  }

  answerApproval(approved: boolean): boolean {
    const resolve = this.pending;
    if (!resolve) return false;
    this.pending = undefined;
    resolve(approved);
    return true;
  }

  // --- startup questions: terminal and dashboard race, first answer wins ---

  // `terminal` asks in the terminal and must stop (reject or never resolve) when its signal aborts.
  // Rejections are ignored; an aborted terminal prompt is simply dropped.
  ask(spec: QuestionSpec, terminal: (signal: AbortSignal) => Promise<string>): Promise<QuestionAnswer> {
    const id = randomUUID();
    const abort = new AbortController();
    bus.emit("setup_question", { id, kind: spec.kind, question: spec.question, defaultValue: spec.defaultValue });

    return new Promise<QuestionAnswer>((resolve) => {
      let done = false;
      const finish = (answer: string, via: QuestionAnswer["via"]) => {
        if (done) return;
        done = true;
        if (this.question?.id === id) this.question = undefined;
        abort.abort();
        bus.emit("setup_answered", { id, answer, via });
        resolve({ answer, via });
      };
      this.question = { id, kind: spec.kind, answer: (value) => finish(value, "dashboard") };
      terminal(abort.signal).then((value) => finish(value, "terminal"), () => undefined);
    });
  }

  hasPendingQuestion(): boolean {
    return this.question !== undefined;
  }

  // Returns false if `id` is not the open question (stale or duplicate answer).
  answerQuestion(id: string, rawAnswer: string): boolean {
    const q = this.question;
    if (!q || q.id !== id) return false;
    const answer = String(rawAnswer ?? "").trim().slice(0, MAX_ANSWER_CHARS);
    q.answer(answer);
    return true;
  }

  // Safe default when nobody can answer any more (browser closed): reject.
  cancelPendingApproval(): void {
    this.answerApproval(false);
  }
}

export const control = new ControlHub();
