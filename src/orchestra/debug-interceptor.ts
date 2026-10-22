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
//  - the 5-try gate: at most `maxPerKey` debug attempts (default 5, AGENT_AUTO_DEBUG_ATTEMPTS) on the same command. When
//    the last attempt fails too, the interceptor stops trying (no further attempt) and hands the executor a
//    "Project Failure & Triage Report" (see triage.ts) through takeHalt(); the executor ends the run with it,
//  - `maxPerRun` debug runs in total,
//  - noisy failures (tests, build, TypeScript) wait until they repeat `escalateAfter` times,
//  - single-flight: if two parallel agents hit the same failure, one debug run serves both,
//  - never throws: any problem inside returns a note, the primary agent carries on as it would have without us.

import { classifyFailure, type Failure } from "./error-classifier";
import { boundedInt } from "./env-int";
import { buildTriageReport, type AttemptRecord, type ProjectFacts } from "./triage";

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
  /**
   * Whether the failed command may be re-run WITHOUT asking: false for risky commands and commands that leave the
   * workspace (the executor would have asked the user the first time, so the interceptor must not run them again
   * on its own). Optional: without it every command may be re-run.
   */
  canRerun?(command: string): boolean;
  /** Stack and folders for the triage report. Optional: the report then says "not detected". */
  describeProject?(): ProjectFacts;
  /** Progress lines for the terminal / event log. */
  log?(line: string): void;
}

export interface InterceptorConfig {
  enabled: boolean;
  /** Debug runs in total for one session. */
  maxPerRun: number;
  /** Debug attempts on the same failure / the same command before the run stops with a triage report. */
  maxPerKey: number;
  escalateAfter: number;
}

export function interceptorConfigFromEnv(env: NodeJS.ProcessEnv = process.env): InterceptorConfig {
  const on = /^(1|true|yes|on)$/i.test(env.AGENT_AUTO_DEBUG ?? "");
  return {
    enabled: on,
    maxPerRun: boundedInt(env.AGENT_AUTO_DEBUG_MAX, 10, 1, 30),
    maxPerKey: boundedInt(env.AGENT_AUTO_DEBUG_ATTEMPTS, 5, 1, 10),
    escalateAfter: 2,
  };
}

/** Appears in the note only when the failed command was re-run and now succeeds. The executor hook uses it to set `verified`. */
export const VERIFIED_MARKER = "FIXED and verified";

const MAX_OUTPUT = 4000;

function tail(text: string, max = MAX_OUTPUT): string {
  return text.length <= max ? text : "[...earlier output cut...]\n" + text.slice(-max);
}

const normalizeCommand = (c: string) => c.trim().replace(/\s+/g, " ");

export class DebugInterceptor {
  private seen = new Map<string, number>();
  private runsPerKey = new Map<string, number>();
  private attemptsByCommand = new Map<string, AttemptRecord[]>();
  private inflight = new Map<string, Promise<string>>();
  private notedUnfixable = new Set<string>();
  private total = 0;
  private haltReport: string | undefined;
  // Reports by command, kept for the whole session: a second agent that runs the same exhausted command is stopped too.
  private haltByCommand = new Map<string, string>();

  constructor(
    private readonly deps: InterceptorDeps,
    readonly config: InterceptorConfig,
  ) {}

  get debugRuns(): number {
    return this.total;
  }

  /** The triage report when the attempts for a command are used up. Returned once; the executor ends the run with it. */
  takeHalt(): string | undefined {
    const r = this.haltReport;
    this.haltReport = undefined;
    return r;
  }

  /** The triage report of a command whose attempts are used up (kept, unlike takeHalt), or undefined. */
  haltFor(command: string): string | undefined {
    return this.haltByCommand.get(normalizeCommand(command));
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

      const cmdKey = normalizeCommand(e.command);
      const usedOnCommand = this.attemptsByCommand.get(cmdKey)?.length ?? 0;
      if (
        this.total >= this.config.maxPerRun ||
        (this.runsPerKey.get(failure.key) ?? 0) >= this.config.maxPerKey ||
        usedOnCommand >= this.config.maxPerKey
      ) {
        return null; // budget used: the executor's own repeated-failure nudges take over
      }

      this.total++;
      this.runsPerKey.set(failure.key, (this.runsPerKey.get(failure.key) ?? 0) + 1);
      const job = this.runDebug(e, failure, cmdKey).finally(() => this.inflight.delete(failure.key));
      this.inflight.set(failure.key, job);
      return await job;
    } catch (err) {
      return `AUTO-DEBUG NOTE: the automatic debug step crashed (${(err as Error).message}). Continue as normal.`;
    }
  }

  private recordAttempt(cmdKey: string, summary: string, filesChanged: string[], outcome: AttemptRecord["outcome"]): AttemptRecord[] {
    const list = this.attemptsByCommand.get(cmdKey) ?? [];
    list.push({ n: list.length + 1, summary: summary.slice(0, 300), filesChanged, outcome });
    this.attemptsByCommand.set(cmdKey, list);
    return list;
  }

  // The attempts are used up and the command still fails: stop, and prepare the report. No further attempt happens.
  private exhausted(e: InterceptEvent, failure: Failure, attempts: AttemptRecord[], output: string): string {
    const limit = this.config.maxPerKey;
    this.haltReport = buildTriageReport({
      project: this.deps.describeProject?.() ?? { stack: "not detected", dirs: ["."] },
      command: e.command,
      output,
      failure,
      attempts,
      limit,
    });
    this.haltByCommand.set(normalizeCommand(e.command), this.haltReport);
    this.deps.log?.(`auto-debug: ${attempts.length}/${limit} attempts used on \`${e.command}\`; stopping with a triage report`);
    return `AUTO-DEBUG STOP (${failure.kind}): ${attempts.length} of ${limit} debug attempts are used and \`${e.command}\` still fails. Do not run it again. The run ends here with a triage report for the user.`;
  }

  private async runDebug(e: InterceptEvent, failure: Failure, cmdKey: string): Promise<string> {
    const limit = this.config.maxPerKey;
    const attemptNo = (this.attemptsByCommand.get(cmdKey)?.length ?? 0) + 1;
    this.deps.log?.(`auto-debug: ${e.agentId} hit ${failure.kind}; pausing it and calling the Debug Agent (attempt ${attemptNo}/${limit})`);
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
      const attempts = this.recordAttempt(cmdKey, `the Debug Agent could not run (${(err as Error).message})`, [], "no-patch");
      const base = `AUTO-DEBUG NOTE: the Debug Agent could not run (${(err as Error).message}). ${failure.hint}`;
      return attempts.length >= limit ? `${base}\n${this.exhausted(e, failure, attempts, e.output)}` : base;
    }

    if (!result.patched) {
      const attempts = this.recordAttempt(cmdKey, result.summary, result.filesChanged, "no-patch");
      const base = `AUTO-DEBUG RESULT (${failure.kind}): the Debug Agent found no safe patch (attempt ${attempts.length}/${limit}). Its finding: ${result.summary}\nDo not retry the same command unchanged.`;
      return attempts.length >= limit ? `${base}\n${this.exhausted(e, failure, attempts, e.output)}` : base;
    }

    const files = result.filesChanged.length ? ` Files changed: ${result.filesChanged.join(", ")}.` : "";
    if (!this.deps.rerun) {
      this.recordAttempt(cmdKey, result.summary, result.filesChanged, "unverified");
      return `AUTO-DEBUG RESULT (${failure.kind}): patched but not re-verified. ${result.summary}${files}\nRe-run \`${e.command}\` to confirm.`;
    }
    if (this.deps.canRerun && !this.deps.canRerun(e.command)) {
      this.recordAttempt(cmdKey, result.summary, result.filesChanged, "unverified");
      return `AUTO-DEBUG RESULT (${failure.kind}): patched but NOT re-run automatically, because \`${e.command}\` is a risky command or touches files outside the project and needs your approval. ${result.summary}${files}\nRe-run it yourself (the normal approval prompt applies) to confirm.`;
    }
    const again = await this.deps.rerun(e.command, e.cwd);
    if (again.exitCode === 0) {
      this.attemptsByCommand.delete(cmdKey); // fixed: the next failure of this command starts a fresh count
      this.deps.log?.(`auto-debug: fixed (${failure.kind}); resuming ${e.agentId}`);
      return `AUTO-DEBUG RESULT (${failure.kind}): ${VERIFIED_MARKER}. \`${e.command}\` now succeeds. ${result.summary}${files}\nContinue with your task; do not redo this step.`;
    }
    const attempts = this.recordAttempt(cmdKey, result.summary, result.filesChanged, "still-fails");
    const base = `AUTO-DEBUG RESULT (${failure.kind}): patched (attempt ${attempts.length}/${limit}), but \`${e.command}\` still fails.${files}\nNew output:\n${tail(again.output, 1500)}\n${result.summary}`;
    return attempts.length >= limit ? `${base}\n${this.exhausted(e, failure, attempts, again.output)}` : base;
  }
}
