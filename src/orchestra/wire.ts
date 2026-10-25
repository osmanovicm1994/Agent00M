// src/orchestra/wire.ts
//
// The glue between the orchestra pieces and the real Executor:
//
//  - createExecutor()   builds an Executor; with AGENT_AUTO_DEBUG=1 it also gets the reactive debug interceptor.
//  - makeTaskRunner()   the TaskRunner for OrchestraMaster: one Executor per task, with the scope guard,
//                       team updates from the blackboard, auto-debug and a gated model provider.
//
// Nothing here runs unless auto-debug is switched on or a caller uses makeTaskRunner, so existing flows are unchanged.

import path from "node:path";
import { Executor, type ExecutorOptions } from "../core/executor";
import type { CommandFailure, ExecutorHooks, InterceptResult } from "../core/executor-hooks";
import { bus } from "../core/events";
import type { LLMProvider } from "../llm/types";
import type { McpManager } from "../mcp/client";
import { ShellTool } from "../tools/shell.tool";
import { escapesWorkspace, isDangerousCommand } from "../core/command-safety";
import { describeProject } from "./triage";
import { getAgent } from "../agents/definitions";
import {
  DebugInterceptor,
  VERIFIED_MARKER,
  interceptorConfigFromEnv,
  type DebugRequest,
  type DebugResult,
  type InterceptorConfig,
  type RerunResult,
} from "./debug-interceptor";
import { Semaphore, gateProvider, llmConcurrencyFromEnv } from "./llm-gate";
import { boundedInt } from "./env-int";
import type { OrchTask, TaskContext, TaskOutcome, TaskRunner } from "./orchestra-master";
import { Blackboard } from "./blackboard";
import { WorkspaceLocks } from "./workspace-locks";
import type { ParallelOptions } from "../team/orchestrator";

/**
 * Steps the Debug Agent may use for one automatic debug run. Small on purpose: it fixes one failure, nothing else.
 * 10 (was 25): a failure that is not fixed in about 10 model calls is not fixed by 25 more; the run then ends with a report
 * and the person decides. Known failures never get here (src/core/known-fixes.ts answers them without a model call).
 */
const DEBUG_MAX_STEPS = boundedInt(process.env.AGENT_AUTO_DEBUG_STEPS, 10, 3, 200);
/** Steps one parallel task may use before it is reported as incomplete. */
const TASK_MAX_STEPS = boundedInt(process.env.AGENT_TASK_MAX_STEPS, 60, 3, 500);

export function buildDebugTask(req: DebugRequest): string {
  return [
    `AUTOMATIC DEBUG REQUEST. The "${req.agentId}" agent ran a command that failed. Its work is paused until you are done.`,
    `Command: ${req.command}`,
    req.cwd ? `Folder: ${req.cwd}` : "",
    `Failure type (from a pattern match, may be wrong): ${req.failure.kind}`,
    `Where to look first: ${req.failure.hint}`,
    "",
    "EXACT OUTPUT (tail):",
    req.output,
    "",
    "Rules:",
    "- Find the cause in THIS output and fix it with the smallest change (a package name or version in package.json, a schema line, an import path, a config value). Verify names and versions with a command (for example `npm view <pkg> versions --json`), do not guess.",
    "- Do not rebuild or refactor anything else. Do not delete data, reset a database, or install anything globally.",
    "- When done, run the failing command once to confirm, then end with exactly one line: `PATCHED: <what you changed>` or `NOT PATCHED: <what is missing or unknown>`.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Reads the Debug Agent's last message. A patch counts only if it says so and files were changed or it names a change. */
export function parseDebugOutcome(finalMessage: string, filesWritten: string[]): DebugResult {
  const lines = finalMessage.trim().split("\n");
  const marker = [...lines].reverse().find((l) => /^\W*(NOT )?PATCHED\s*:/i.test(l.trim()));
  const notPatched = marker ? /^\W*NOT PATCHED/i.test(marker.trim()) : false;
  const claimed = marker ? !notPatched : false;
  return {
    patched: claimed && filesWritten.length > 0,
    summary: (marker ?? lines.slice(-3).join(" ")).replace(/^\W*(NOT )?PATCHED\s*:\s*/i, "").trim().slice(0, 400) || "no summary",
    filesChanged: filesWritten,
  };
}

export interface AutoDebugDeps {
  llm: LLMProvider;
  workspaceRoot: string;
  mcp?: McpManager;
  /** Hooks for the nested debug Executor, per requesting agent (e.g. the scope guard of that agent). */
  nestedHooks?: (agentId: string) => ExecutorHooks;
  /** Whether automatic debugging may run right now (it needs auto-write AND auto-run: nobody is there to approve). */
  mayRun: () => boolean;
  config?: InterceptorConfig;
  log?: (line: string) => void;
  /** Re-reads AGENT_AUTO_DEBUG before every failure, so the dashboard/terminal can switch auto-debug on and off mid-session. */
  live?: boolean;
}

/** Builds the interceptor and returns the hook the Executor calls after a failed command. */
export function makeCommandInterceptor(deps: AutoDebugDeps): ExecutorHooks["commandInterceptor"] {
  const base = deps.config ?? interceptorConfigFromEnv();
  const config = deps.live ? { ...base, enabled: true } : base;
  if (!config.enabled) return undefined;
  const log = deps.log ?? ((l: string) => console.log(`\n\u{1F6E0}  ${l}`));
  const shell = new ShellTool(path.resolve(deps.workspaceRoot));

  const interceptor = new DebugInterceptor(
    {
      log,
      async debug(req: DebugRequest): Promise<DebugResult> {
        const debugAgent = getAgent("debug");
        if (!debugAgent) throw new Error("debug agent not found");
        const nested = new Executor(deps.llm, deps.workspaceRoot, deps.mcp, {
          autoWrite: true,
          autoRun: true,
          maxSteps: DEBUG_MAX_STEPS,
          // No interceptor inside the nested run: a debug run never starts another debug run.
          hooks: { ...(deps.nestedHooks?.(req.agentId) ?? {}), commandInterceptor: undefined, teamUpdates: undefined, unattended: true },
        });
        try {
          const res = await nested.run(debugAgent, buildDebugTask(req));
          return parseDebugOutcome(res.finalMessage, res.filesWritten);
        } finally {
          bus.setAgent(req.agentId);
        }
      },
      // Same gate the executor applies before auto-running a command: risky ones were approved by a person once,
      // that approval does not extend to running them again unattended.
      canRerun: (command: string) => !isDangerousCommand(command) && !escapesWorkspace(command, deps.workspaceRoot),
      describeProject: () => describeProject(deps.workspaceRoot),
      async rerun(command: string): Promise<RerunResult> {
        const r = await shell.runAsync(command, 10 * 60 * 1000, () => {}, () => {});
        return { output: r.output, exitCode: r.timedOut ? null : r.exitCode };
      },
    },
    config,
  );

  return async (failure: CommandFailure): Promise<InterceptResult | null> => {
    if (deps.live && !interceptorConfigFromEnv().enabled) return null;
    if (!deps.mayRun()) return null;
    // The Debug Agent already is the debugger: starting a second one for its own failed commands only duplicates work.
    if (failure.agentId === "debug") return null;
    // Another agent already used up the attempts on this exact command: stop this one too, with the same report.
    const earlier = interceptor.haltFor(failure.command);
    if (earlier) {
      return { note: `AUTO-DEBUG STOP: the debug attempts for \`${failure.command}\` are used up. The run ends here with a triage report.`, verified: false, halt: earlier };
    }
    const note = await interceptor.handle({ ...failure });
    if (!note) return null;
    // takeHalt: this call used up the attempts. haltFor: another agent's call sharing the same debug run did.
    const halt = interceptor.takeHalt() ?? interceptor.haltFor(failure.command);
    return { note, verified: note.includes(VERIFIED_MARKER), ...(halt ? { halt } : {}) };
  };
}

/** `new Executor(...)`, plus the automatic debug interceptor when AGENT_AUTO_DEBUG is on. */
export function createExecutor(
  llm: LLMProvider,
  workspaceRoot: string,
  mcp?: McpManager,
  options: ExecutorOptions = {},
  extra: { liveAutoDebug?: boolean } = {},
): Executor {
  const hooks: ExecutorHooks = { ...(options.hooks ?? {}) };
  const executor = new Executor(llm, workspaceRoot, mcp, { ...options, hooks });
  if (!hooks.commandInterceptor) {
    // Only when nobody has to approve anything: a debug run that stops to ask a question defeats the purpose.
    hooks.commandInterceptor = makeCommandInterceptor({
      llm,
      workspaceRoot,
      mcp,
      mayRun: () => executor.isAutoWrite() && executor.isAutoRun(),
      live: extra.liveAutoDebug,
    });
  }
  return executor;
}

export interface TaskRunnerDeps {
  llm: LLMProvider;
  workspaceRoot: string;
  mcp?: McpManager;
  locks: import("./workspace-locks").WorkspaceLocks;
  /** Limits concurrent model calls. Default: AGENT_LLM_CONCURRENCY (2). */
  gate?: Semaphore;
  log?: (line: string) => void;
}

export function buildTaskPrompt(task: OrchTask, ctx: TaskContext): string {
  return [
    `You are the "${task.agent}" agent in a team that works in parallel. Your task: ${task.title}`,
    "",
    task.instructions,
    "",
    task.scope.length
      ? task.scope.some((s) => s === "./" || s === "")
        ? "You run alone at this stage and may write anywhere in the project, including the root files."
        : `You may write ONLY in: ${task.scope.join(", ")}. Writes anywhere else are refused (other agents own those paths). If you need a change there, say so in your final message, and do not try another path to get around the refusal.`
      : "This task is read-only: do not write files.",
    task.scope.some((s) => s === "./" || s === "")
      ? "Use `npm --prefix <dir>` inside the app's folder; do not create a root package.json unless the task asks for one."
      : "Never edit the root package.json or lockfiles; use `npm --prefix <dir>` inside your own folder.",
    ctx.contractsText ? `\nINTERFACES YOU MUST FOLLOW (published by other agents):\n${ctx.contractsText}` : "",
    task.publishes
      ? `\nWhen you are done, end your final message with a section "CONTRACT:" listing exactly what the others need from you (endpoints with methods and bodies, DTO field names, env variable names, model names). Keep it under 60 lines.`
      : "",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n");
}

/** One Executor per task (parallel runs must not share state), model calls gated, writes confined to the task's scope. */
export function makeTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  const gate = deps.gate ?? new Semaphore(llmConcurrencyFromEnv());
  const gated = gateProvider(deps.llm as LLMProvider & { chat: (...a: never[]) => Promise<unknown> }, gate) as LLMProvider;
  const guard = (owner: string): ExecutorHooks => ({
    writeGuard: (_agentId, rel) => deps.locks.canWrite(owner, rel),
  });
  // One interceptor for all tasks, so two agents hitting the same failure share one debug run.
  const interceptor = makeCommandInterceptor({
    llm: gated,
    workspaceRoot: deps.workspaceRoot,
    mcp: deps.mcp,
    mayRun: () => true,
    nestedHooks: guard,
    log: deps.log,
  });

  return async (task: OrchTask, ctx: TaskContext): Promise<TaskOutcome> => {
    const agent = getAgent(task.agent);
    if (!agent) return { status: "failed", summary: `unknown agent "${task.agent}"`, filesWritten: [], commandsRun: [] };

    const executor = new Executor(gated, deps.workspaceRoot, deps.mcp, {
      autoWrite: true,
      autoRun: true,
      maxSteps: TASK_MAX_STEPS,
      hooks: {
        unattended: true,
        // Ctrl+C on the team run: the master aborts ctx.signal and this task stops before its next model call.
        cancelled: () => ctx.signal.aborted,
        // The task id is the lock owner; the agent id inside the executor is the role, so use the task id here.
        writeGuard: (_a, rel) => deps.locks.canWrite(task.id, rel),
        onFileWritten: (_a, rel) => ctx.board.post(task.id, "file-written", `wrote ${rel}`, rel),
        teamUpdates: () => ctx.digest(),
        commandInterceptor: interceptor
          ? (f) => interceptor({ ...f, agentId: task.id })
          : undefined,
      },
    });

    try {
      const res = await executor.run(agent, buildTaskPrompt(task, ctx));
      const hitLimit = res.stepsTaken >= TASK_MAX_STEPS;
      const contract = task.publishes ? extractContract(res.finalMessage, task.publishes) : undefined;
      const status = taskStatus({ interrupted: res.interrupted, hitLimit, unresolvedFailure: res.unresolvedFailure });
      return {
        status,
        // A task that ends on a failed command says so, so the report and the dependents' prompts are not misleading.
        summary: (status === "failed" ? "UNRESOLVED FAILURE (the last command still fails). " : "") + res.finalMessage.slice(0, 1500),
        filesWritten: res.filesWritten,
        commandsRun: res.commandsRun,
        ...(contract ? { contract } : {}),
      };
    } finally {
      bus.setAgent(task.id);
    }
  };
}

/**
 * How a finished task counts. Only a clean finish is "done": a task whose last command still fails is "failed", so the
 * orchestra skips whatever depends on it instead of building on a red build or test.
 */
export function taskStatus(r: { interrupted?: boolean; hitLimit: boolean; unresolvedFailure?: boolean }): "done" | "incomplete" | "failed" | "interrupted" {
  if (r.interrupted) return "interrupted";
  if (r.unresolvedFailure) return "failed";
  if (r.hitLimit) return "incomplete";
  return "done";
}

/** Everything team mode needs to run engineer tasks side by side: runner, fresh locks and blackboard, concurrency. */
export function makeParallelOptions(deps: { llm: LLMProvider; workspaceRoot: string; mcp?: McpManager }): ParallelOptions {
  const locks = new WorkspaceLocks(deps.workspaceRoot);
  const board = new Blackboard();
  const concurrency = llmConcurrencyFromEnv();
  // One controller per team run: beginRun() before the orchestra starts, cancel() from the Ctrl+C handler.
  let controller: AbortController | undefined;
  return {
    runner: makeTaskRunner({ ...deps, locks, gate: new Semaphore(concurrency) }),
    locks,
    board,
    concurrency,
    beginRun: () => {
      controller = new AbortController();
      return controller.signal;
    },
    endRun: () => {
      controller = undefined;
    },
    cancel: () => {
      if (!controller || controller.signal.aborted) return false;
      controller.abort();
      return true;
    },
  };
}

/** Text after the last "CONTRACT:" heading of the agent's final message. */
export function extractContract(finalMessage: string, name: string): { name: string; body: string } | undefined {
  const idx = finalMessage.lastIndexOf("CONTRACT:");
  if (idx < 0) return undefined;
  const body = finalMessage.slice(idx + "CONTRACT:".length).trim();
  return body ? { name, body } : undefined;
}
