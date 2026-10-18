// src/orchestra/debug-interceptor.ts
//
// Reactive debugging. The executor calls `handle()` after every shell command. When the command failed in a way the
// Debug Agent can fix, handle() runs the Debug Agent right there, INSIDE the tool call. Because the executor awaits
// the tool call, the primary agent is paused for exactly that long, and when handle() returns, the text it returns is
// appended to the tool result, so the primary agent resumes with "this was fixed, here is what changed" instead of
// brute-forcing. No human is involved.
//
// Guard rails (a debug run is expensive on a local model):
//  - disabled unless enabled (AGENT_AUTO_DEBUG=1),
//  - `maxPerRun` debug runs in total, `maxPerKey` per distinct failure,
//  - noisy failures (tests, build, TypeScript) wait until they repeat `escalateAfter` times,
//  - single-flight: if two parallel agents hit the same failure, one debug run serves both,
//  - never throws: any problem inside returns a note, the primary agent carries on as it would have without us.

import { classifyFailure, type Failure } from "./error-classifier";

export interface InterceptEvent {
  agentId: string;
  command: string;
  output: string;
  exitCode?: number | null;
  /** Working directory the command ran in, relative to the workspace, when known. */
  cwd?: string;
}

export interface DebugRequest {
  agentId: string;
  failure: Failure;
  command: string;
  /** The exact output (tail-capped), so the Debug Agent sees the real stderr, not a paraphrase. */
  output: string;
  cwd?: string;
}

export interface DebugResult {
  /** True when the Debug Agent reports it changed something that should fix the failure. */
  patched: boolean;
  summary: string;
  filesChanged: string[];
}

export interface RerunResult {
  output: string;
  exitCode: number | null;
}

export interface InterceptorDeps {
  /** Runs the Debug Agent with the request. Supplied by the caller (it owns the executor and the provider). */
  debug(req: DebugRequest): Promise<DebugResult>;
  /** Re-runs the failed command to verify the patch. Optional: without it the note says "not re-verified". */
  rerun?(command: string, cwd?: string): Promise<RerunResult>;
  /** Progress lines for the terminal / event log. */
  log?(line: string): void;
}

export interface InterceptorConfig {
  enabled: boolean;
  maxPerRun: number;
  maxPerKey: number;
  escalateAfter: number;
}

export function interceptorConfigFromEnv(env: NodeJS.ProcessEnv = process.env): InterceptorConfig {
  const on = /^(1|true|yes|on)$/i.test(env.AGENT_AUTO_DEBUG ?? "");
  return {
    enabled: on,
    maxPerRun: Number(env.AGENT_AUTO_DEBUG_MAX) || 3,
    maxPerKey: 1,
    escalateAfter: 2,
  };
}

/** Appears in the note only when the failed command was re-run and now succeeds. The executor hook uses it to set `verified`. */
export const VERIFIED_MARKER = "FIXED and verified";

const MAX_OUTPUT = 4000;

function tail(text: string, max = MAX_OUTPUT): string {
  return text.length <= max ? text : "[...earlier output cut...]\n" + text.slice(-max);
}

export class DebugInterceptor {
  private seen = new Map<string, number>();
  private runsPerKey = new Map<string, number>();
  private inflight = new Map<string, Promise<string>>();
  private notedUnfixable = new Set<string>();
  private total = 0;

  constructor(
    private readonly deps: InterceptorDeps,
    readonly config: InterceptorConfig,
  ) {}

  get debugRuns(): number {
    return this.total;
  }

  /** Returns text to append to the tool result, or null when nothing should happen. Never throws. */
  async handle(e: InterceptEvent): Promise<string | null> {
    if (!this.config.enabled) return null;
    try {
      const failure = classifyFailure(e.command, e.output, e.exitCode);
      if (!failure) return null;

      if (!failure.fixable) {
        if (this.notedUnfixable.has(failure.key)) return null;
        this.notedUnfixable.add(failure.key);
        return `AUTO-DEBUG NOTE (${failure.kind}): ${failure.hint}`;
      }

      const count = (this.seen.get(failure.key) ?? 0) + 1;
      this.seen.set(failure.key, count);
      if (!failure.immediate && count < this.config.escalateAfter) return null;

      // Parallel agents hitting the same problem share one debug run.
      const running = this.inflight.get(failure.key);
      if (running) return await running;

      if (this.total >= this.config.maxPerRun || (this.runsPerKey.get(failure.key) ?? 0) >= this.config.maxPerKey) {
        return null; // budget used: the executor's own repeated-failure nudges take over
      }

      this.total++;
      this.runsPerKey.set(failure.key, (this.runsPerKey.get(failure.key) ?? 0) + 1);
      const job = this.runDebug(e, failure).finally(() => this.inflight.delete(failure.key));
      this.inflight.set(failure.key, job);
      return await job;
    } catch (err) {
      return `AUTO-DEBUG NOTE: the automatic debug step crashed (${(err as Error).message}). Continue as normal.`;
    }
  }

  private async runDebug(e: InterceptEvent, failure: Failure): Promise<string> {
    this.deps.log?.(`auto-debug: ${e.agentId} hit ${failure.kind}; pausing it and calling the Debug Agent`);
    let result: DebugResult;
    try {
      result = await this.deps.debug({
        agentId: e.agentId,
        failure,
        command: e.command,
        output: tail(e.output),
        cwd: e.cwd,
      });
    } catch (err) {
      return `AUTO-DEBUG NOTE: the Debug Agent could not run (${(err as Error).message}). ${failure.hint}`;
    }

    if (!result.patched) {
      return `AUTO-DEBUG RESULT (${failure.kind}): the Debug Agent found no safe patch. Its finding: ${result.summary}\nDo not retry the same command unchanged.`;
    }

    const files = result.filesChanged.length ? ` Files changed: ${result.filesChanged.join(", ")}.` : "";
    if (!this.deps.rerun) {
      return `AUTO-DEBUG RESULT (${failure.kind}): patched but not re-verified. ${result.summary}${files}\nRe-run \`${e.command}\` to confirm.`;
    }
    const again = await this.deps.rerun(e.command, e.cwd);
    if (again.exitCode === 0) {
      this.deps.log?.(`auto-debug: fixed (${failure.kind}); resuming ${e.agentId}`);
      return `AUTO-DEBUG RESULT (${failure.kind}): ${VERIFIED_MARKER}. \`${e.command}\` now succeeds. ${result.summary}${files}\nContinue with your task; do not redo this step.`;
    }
    return `AUTO-DEBUG RESULT (${failure.kind}): patched, but \`${e.command}\` still fails.${files}\nNew output:\n${tail(again.output, 1500)}\n${result.summary}`;
  }
}
