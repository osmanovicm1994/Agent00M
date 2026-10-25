// src/core/stall-guard.ts
//
// Stops an agent that is going in circles. A local model that does not know the fix tends to look at the same things
// again and again (ls node_modules/a, ls node_modules/b, ls node_modules/a, ...), and every look costs a model call.
// The other trackers only catch an IDENTICAL failing command; this one catches the alternating and the "keeps
// looking, never changes anything" patterns.
//
// Pure and deterministic: no I/O, no clock. The executor feeds it one event per tool call and acts on the verdict:
//   ok    nothing to do,
//   warn  append the message to the tool result (the model sees it),
//   stop  end the run with the message (it is written for the person, not the model).
//
// Two checks:
//  1. LOOP     the last 6 steps since the last file write used at most 2 distinct "families" of step (same command,
//              same file, same folder). Warn at once, warn again after 2 more, stop after 4 more.
//  2. SPIRAL   (only when configured, used for the debug agent) N read-only steps in a row without a write or a
//              state-changing command. Warn at inspectWarn, stop at inspectStop.
// A successful file write resets everything: something changed, so looking again is legitimate.

export type StallKind = "inspect" | "command" | "write";

export interface StallEvent {
  kind: StallKind;
  /** What the step was, normalised so near-identical steps compare equal (see commandFamily). */
  family: string;
}

export interface StallVerdict {
  level: "ok" | "warn" | "stop";
  message?: string;
}

export interface StallOptions {
  /** Read-only steps in a row before a warning. null = the spiral check is off. */
  inspectWarn?: number | null;
  /** Read-only steps in a row before the run stops. */
  inspectStop?: number | null;
}

const LOOP_WINDOW = 6;
const LOOP_MAX_FAMILIES = 2;
// Consecutive events for which the loop condition held: warn at 1 and 3, stop at 5 (that is 10 steps in total).
const LOOP_WARN_AT = [1, 3];
const LOOP_STOP_AT = 5;

const INSPECT_TOOLS = new Set(["read_file", "read_multiple_files", "list_directory", "get_directory_tree", "find_files", "grep", "process_logs"]);
const WRITE_TOOLS = new Set(["write_file", "append_file"]);

const INSPECT_VERBS = new Set([
  "ls", "cat", "head", "tail", "find", "grep", "rg", "tree", "stat", "file", "wc", "pwd", "which", "whereis", "du", "type",
  "echo", "env", "printenv", "less", "more", "sort", "uniq", "cut", "awk", "sed", "readlink", "realpath", "dirname", "basename",
]);
const INSPECT_NPM = new Set(["view", "ls", "list", "explain", "why", "config", "root", "bin", "prefix", "outdated", "info", "show", "v", "search", "audit", "help", "doctor", "ping"]);
const INSPECT_GIT = new Set(["status", "log", "diff", "show", "branch", "remote", "ls-files", "rev-parse", "describe", "tag", "blame", "config"]);
// Tools whose family is the verb plus its first two words (npm install foo -> "npm install foo").
const SUBCOMMAND_TOOLS = new Set(["npm", "npx", "pnpm", "yarn", "git", "docker", "cargo", "go", "pip", "pip3", "brew", "prisma", "bun"]);

function splitSegments(command: string): string[] {
  return command
    .split(/&&|;|\n/)
    .map((s) => s.split("|")[0])
    .map((s) => s.replace(/\d*>&\d+|\d*>>?\s*\S+/g, " ").trim())
    .filter(Boolean);
}

function tokensOf(segment: string): string[] {
  const t = segment.split(/\s+/).filter(Boolean);
  while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t.shift(); // FOO=bar cmd
  return t;
}

function shortPath(p: string): string {
  const clean = p.replace(/^['"]|['"]$/g, "").replace(/^\.\//, "").replace(/\/+$/, "");
  if (/(^|\/)node_modules(\/|$)/.test(clean)) return "node_modules";
  return clean.split("/").slice(0, 2).join("/");
}

/** A normalised label for a shell command, so `ls node_modules/a` and `ls node_modules/b` compare equal. */
export function commandFamily(command: string): string {
  const parts = splitSegments(command).map((seg) => {
    const t = tokensOf(seg);
    if (!t.length) return "";
    const verb = t[0].replace(/^.*\//, "");
    const rest = t.slice(1).filter((x) => !x.startsWith("-"));
    if (SUBCOMMAND_TOOLS.has(verb)) return [verb, ...rest.slice(0, 2)].join(" ");
    return rest.length ? `${verb} ${shortPath(rest[rest.length > 1 && verb === "grep" ? 1 : 0])}` : verb;
  });
  return parts.filter(Boolean).join(" && ") || command.trim().slice(0, 40);
}

/** True when every part of the command only looks at things (it cannot change the project). */
export function isInspectCommand(command: string): boolean {
  // `echo x > file` writes: a redirect into a file (anything but /dev/null or 2>&1) makes it a change.
  if (/(^|\s)\d*>>?\s*(?!&|\/dev\/null)[^\s>]/.test(command)) return false;
  const segs = splitSegments(command);
  if (!segs.length) return false;
  return segs.every((seg) => {
    const t = tokensOf(seg);
    if (!t.length) return true;
    const verb = t[0].replace(/^.*\//, "");
    if (t.length === 2 && /^(--version|-v|-V|--help|-h)$/.test(t[1])) return true; // node -v, npm --version
    if (verb === "cd") return true;
    if (INSPECT_VERBS.has(verb)) {
      if (verb === "sed" && t.some((x) => /^-i/.test(x))) return false;
      if (verb === "find" && t.some((x) => x === "-delete" || x === "-exec")) return false;
      return true;
    }
    const sub = t.slice(1).find((x) => !x.startsWith("-"));
    if (verb === "npm" || verb === "pnpm" || verb === "yarn") return sub !== undefined && INSPECT_NPM.has(sub);
    if (verb === "git") return sub !== undefined && INSPECT_GIT.has(sub);
    return false;
  });
}

function safeArgs(argsJson: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(argsJson || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Turns one tool call into an event, or null when the call says nothing about going in circles (web lookups, plan
 * updates, thinking tools). `result` is the raw tool result: a write only counts as a change when it succeeded.
 */
export function classifyCall(name: string, argsJson: string, result: string): StallEvent | null {
  const args = safeArgs(argsJson);
  if (WRITE_TOOLS.has(name)) {
    return /^File (written|appended):/.test(result) ? { kind: "write", family: `write:${str(args.path)}` } : null;
  }
  if (INSPECT_TOOLS.has(name)) {
    // A long file read in chunks is one path with different ranges: the range is part of the step, so reading on is not a loop.
    const range = name === "read_file" ? `:${String(args.start_line ?? "")}-${String(args.end_line ?? "")}` : "";
    const key =
      name === "grep" ? str(args.pattern)
      : name === "find_files" ? str(args.query)
      : name === "read_multiple_files" ? (Array.isArray(args.paths) ? args.paths.slice(0, 3).map(str).join(",") : "")
      : str(args.path ?? args.name ?? ".");
    return { kind: "inspect", family: `${name}:${key}${range}` };
  }
  if (name === "run_command") {
    const command = str(args.command);
    if (!command.trim()) return null;
    return { kind: isInspectCommand(command) ? "inspect" : "command", family: commandFamily(command) };
  }
  return null;
}

export class StallGuard {
  private window: string[] = [];
  private inspectRun = 0;
  private loopHits = 0;
  private spiralWarned = false;

  constructor(private readonly options: StallOptions = {}) {}

  /** Records one step and says what to do about it. */
  record(ev: StallEvent): StallVerdict {
    if (ev.kind === "write") {
      this.window = [];
      this.inspectRun = 0;
      this.loopHits = 0;
      this.spiralWarned = false;
      return { level: "ok" };
    }

    this.window.push(ev.family);
    if (this.window.length > 40) this.window.shift();
    if (ev.kind === "inspect") this.inspectRun++;
    else {
      this.inspectRun = 0;
      this.spiralWarned = false;
    }

    // 1. LOOP: few distinct steps in the last window, and nothing written since.
    const recent = this.window.slice(-LOOP_WINDOW);
    const distinct = [...new Set(recent)];
    if (recent.length >= LOOP_WINDOW && distinct.length <= LOOP_MAX_FAMILIES) {
      this.loopHits++;
      const total = LOOP_WINDOW + this.loopHits - 1;
      if (this.loopHits >= LOOP_STOP_AT) {
        return { level: "stop", message: loopStopText(distinct, total) };
      }
      if (LOOP_WARN_AT.includes(this.loopHits)) {
        return { level: "warn", message: loopWarnText(distinct, total) };
      }
      return { level: "ok" };
    }
    this.loopHits = 0;

    // 2. SPIRAL: only reading, never changing (debug agent).
    const { inspectWarn, inspectStop } = this.options;
    if (ev.kind === "inspect") {
      if (inspectStop && this.inspectRun >= inspectStop) return { level: "stop", message: spiralStopText(this.inspectRun) };
      if (inspectWarn && this.inspectRun >= inspectWarn && !this.spiralWarned) {
        this.spiralWarned = true;
        return { level: "warn", message: spiralWarnText(this.inspectRun) };
      }
    }
    return { level: "ok" };
  }
}

/** Stall options for an agent: only the debug agent gets the spiral check (other agents read a lot before writing, on purpose). */
export function stallOptionsFor(agentId: string, env: NodeJS.ProcessEnv = process.env): StallOptions {
  if (agentId !== "debug") return {};
  const warn = Number(env.AGENT_DEBUG_INSPECT_WARN) || 6;
  const stop = Number(env.AGENT_DEBUG_INSPECT_STOP) || 10;
  return { inspectWarn: warn, inspectStop: Math.max(stop, warn + 1) };
}

export function stallGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_STALL_GUARD !== "0";
}

const list = (families: string[]) => families.map((f) => `"${f}"`).join(" and ");

function loopWarnText(families: string[], n: number): string {
  return (
    `STALL WARNING: your last ${n} steps only repeated ${list(families)}. Nothing was written in between, so repeating them gives the same answer. ` +
    "Do ONE of these now: (a) make one concrete change (write a file, or run a DIFFERENT kind of command such as the fix itself), or (b) end your answer with what you know and what you need from the person. Do not look at the same things again."
  );
}

function loopStopText(families: string[], n: number): string {
  return (
    `I stopped this run because the agent was going in circles: ${n} steps in a row only repeated ${list(families)} without changing anything. ` +
    "Stopping early saves time and model tokens.\n" +
    "What to do: read the last error above and fix that one thing (or give the agent the missing detail, such as the exact version or setting), then run the task again. " +
    "If it is an install or version problem, run the failing command yourself in the project folder and check its first error line."
  );
}

function spiralWarnText(n: number): string {
  return (
    `STALL WARNING: you have only looked at things ${n} times in a row and changed nothing. You have enough information to act. ` +
    "If you know the cause, fix it now with one small change and re-run the failing command. If you do not, stop and report your best guess and the single thing you would check next."
  );
}

function spiralStopText(n: number): string {
  return (
    `I stopped debugging because the agent looked at files and folders ${n} times in a row without finding or changing anything. ` +
    "More looking would only cost tokens.\n" +
    "What to do: read the last error above. The most common causes are a wrong package version, a missing or misspelled config line, or a tool that is too old for the project. " +
    "Give the agent that detail (or fix it yourself) and run the task again."
  );
}
