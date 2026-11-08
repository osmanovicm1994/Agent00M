// src/core/executor-hooks.ts
//
// Optional extension points of the Executor. All of them are optional and default to "do nothing", so an Executor
// built without hooks behaves exactly as before. The orchestra (src/orchestra/) uses them to:
//  - keep parallel agents inside their own paths (writeGuard),
//  - react to a failed command by running the Debug Agent in the middle of the tool call (commandInterceptor),
//  - show an agent what the others did (teamUpdates) and tell the others what it wrote (onFileWritten).
//
// This file imports nothing from the orchestra, so core/ stays independent of it.

export interface CommandFailure {
  agentId: string;
  /** Unique per executor run. An auto-debug halt applies to this run only, never to a later run that has not tried anything yet. */
  runId?: string;
  command: string;
  /** The exact combined output of the command. */
  output: string;
  exitCode: number | null;
}

export interface InterceptResult {
  /** Text added to the tool result as `autoDebug`, read by the agent that ran the command. */
  note: string;
  /** True when the failed command was re-run and now succeeds: the failure no longer counts. */
  verified: boolean;
  /**
   * Set when the automatic debug attempts for this command are used up: the executor stops the run at once (no further
   * attempt, no further tool call) and returns this text, a "Project Failure & Triage Report", as the final message.
   */
  halt?: string;
}

/** Why the agent is asking for outside help: it keeps hitting the same wall. */
export type ResolverTrigger = "repeated-failure" | "circling" | "known-problem";

export interface ResolverRequest {
  agentId: string;
  /** The task text of this run. */
  task: string;
  trigger: ResolverTrigger;
  /** The command that keeps failing (empty when the trigger is not a command). */
  command: string;
  /** The exact output of the last failing run. */
  output: string;
  filesWritten: string[];
  /** The last commands of this run, oldest first: what was already tried. */
  commandsRun: string[];
  /** Per-file summary of a many-file typecheck (see digestTypeErrors), or "". */
  errorDigest: string;
  /** Reads a project file by relative path; undefined when it cannot be read. */
  readFile(relPath: string): string | undefined;
}

export interface ResolverPrepared {
  /** What would be sent, as plain text: shown to the person before anything leaves the machine. */
  preview: string;
  /** What the local review of the full issue found (missing context that was added, secrets masked, ...). */
  notes: string[];
  /** Sends the reviewed report and returns the advice. Throws when no answer could be obtained. */
  send(): Promise<string>;
}

export interface ProblemResolver {
  /** Collects and reviews the full issue. Returns null when no help can be offered (no key, limit reached). Must not throw. */
  prepare(req: ResolverRequest): Promise<ResolverPrepared | null>;
}

export interface ExecutorHooks {
  /** Called when the same problem keeps coming back. Optional: without it the run just stops as before. */
  problemResolver?: ProblemResolver;
  /** Called before every write_file. Return `{ allowed: false, reason }` to refuse it; the reason goes to the agent. */
  writeGuard?(agentId: string, relPath: string): { allowed: boolean; reason?: string };
  /** Called after a write_file succeeded. */
  onFileWritten?(agentId: string, relPath: string): void;
  /** Called after a command exited non-zero. The agent waits (is paused) until the returned promise settles. Must not throw. */
  commandInterceptor?(failure: CommandFailure): Promise<InterceptResult | null>;
  /** Called before each model request. A non-empty string is added to the conversation as a short update. */
  teamUpdates?(agentId: string): string;
  /** True: there is nobody to answer approval prompts (parallel runs). Commands that would ask are declined instead. */
  unattended?: boolean;
  /** Checked before every model request. True: the run was cancelled from outside (Ctrl+C on a parallel team run); stop now. */
  cancelled?(): boolean;
}
