// Control channel: lets the dashboard drive the agent (send tasks, answer approvals, answer the
// chat startup questions). Like the event bus it is UI-agnostic: the server only calls
// submitTask()/answerApproval()/answerQuestion(); the CLI registers what a task does, and the
// executor asks requestApproval() for runs that were started from the browser. With nothing
// registered, everything here is inert.

import { randomUUID } from "crypto";
import { bus } from "./events";
import type { PlannerMode, SettingKey, SettingsState } from "./event-types";

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
// Stops the running shell command(s); returns how many were stopped (same as Ctrl+C in the terminal).
type InterruptHandler = () => number;
type BusyListener = (busy: boolean) => void;
type TeamListener = (team: boolean) => void;
type SettingsListener = (settings: SettingsState) => void;
type SessionListener = (acceptsTasks: boolean) => void;

class ControlHub {
  private busy = false;
  private handler: TaskHandler | undefined;
  private workspace: string | undefined;
  private interruptHandler: InterruptHandler | undefined;
  private pending: ((approved: boolean) => void) | undefined;
  private question: { id: string; kind: QuestionSpec["kind"]; answer: (value: string) => void } | undefined;
  private settings: SettingsState = {
    team: false,
    parallel: false,
    autoWrite: false,
    autoRun: false,
    autoDebug: /^(1|true|yes|on)$/i.test(process.env.AGENT_AUTO_DEBUG ?? ""),
    research: false,
    planner: "auto",
    autoRunLocked: process.env.AGENT_AUTO_RUN === "0",
    researchAvailable: false,
  };
  private readonly settingsListeners = new Set<SettingsListener>();
  private readonly teamListeners = new Set<TeamListener>();
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

  // --- team mode (shared by the terminal's /team and the dashboard switch) ---

  isTeam(): boolean {
    return this.settings.team;
  }

  setTeam(on: boolean): void {
    this.setSetting("team", on);
  }

  onTeamChange(listener: TeamListener): () => void {
    this.teamListeners.add(listener);
    return () => {
      this.teamListeners.delete(listener);
    };
  }

  // --- all switches (terminal commands and dashboard share this state) ---

  getSettings(): SettingsState {
    return { ...this.settings };
  }

  // What this session can do at all (set once by the CLI): the AGENT_AUTO_RUN=0 lock and the Gemini key.
  setCapabilities(caps: { researchAvailable?: boolean; autoRunLocked?: boolean }): void {
    const next = { ...this.settings, ...caps };
    if (next.autoRunLocked) next.autoRun = false;
    if (!next.researchAvailable) next.research = false;
    this.commit(next);
  }

  // Validates and applies one switch. Returns ok:false (with the reason) when the switch is not allowed.
  setSetting(key: SettingKey, value: unknown): SubmitResult {
    const next = { ...this.settings };
    if (key === "planner") {
      if (value !== "auto" && value !== "always" && value !== "off") return { ok: false, reason: "Planner mode must be auto, always or off." };
      next.planner = value as PlannerMode;
    } else if (key === "team" || key === "parallel" || key === "autoWrite" || key === "autoRun" || key === "autoDebug" || key === "research") {
      if (typeof value !== "boolean") return { ok: false, reason: `${key} must be on or off.` };
      if (key === "autoRun" && value && next.autoRunLocked) return { ok: false, reason: "Auto-run is disabled by AGENT_AUTO_RUN=0 in the env file." };
      if (key === "research" && value && !next.researchAvailable) return { ok: false, reason: "GEMINI_API_KEY is not set (put it in .env and restart)." };
      next[key] = value;
      // Same rule as the terminal's /auto-write: auto mode switches files and commands together.
      if (key === "autoWrite") next.autoRun = value && !next.autoRunLocked;
    } else {
      return { ok: false, reason: `Unknown setting '${String(key)}'.` };
    }
    this.commit(next);
    return { ok: true };
  }

  private commit(next: SettingsState): void {
    const prev = this.settings;
    if ((Object.keys(next) as (keyof SettingsState)[]).every((k) => prev[k] === next[k])) return;
    this.settings = next;
    const teamChanged = prev.team !== next.team;
    for (const l of this.settingsListeners) {
      try {
        l({ ...next });
      } catch {
        // a broken listener must not break the agent
      }
    }
    if (teamChanged) {
      for (const l of this.teamListeners) {
        try {
          l(next.team);
        } catch {
          // ignore
        }
      }
    }
  }

  onSettingsChange(listener: SettingsListener): () => void {
    this.settingsListeners.add(listener);
    return () => {
      this.settingsListeners.delete(listener);
    };
  }

  // --- project folder and interrupt (read by the dashboard server) ---

  // The CLI tells us which folder the agent works in, so the dashboard can show the project tree.
  setWorkspace(root: string | undefined): void {
    this.workspace = root;
  }

  getWorkspace(): string | undefined {
    return this.workspace;
  }

  setInterruptHandler(handler: InterruptHandler | undefined): void {
    this.interruptHandler = handler;
  }

  // Stops running shell commands. Returns how many were stopped (0 when nothing was running).
  interrupt(): number {
    return this.interruptHandler ? this.interruptHandler() : 0;
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
