// src/team/verify-gate.ts
//
// The safety reviewer is read-only: it cannot run a typecheck or a build, so its "PASS" said nothing about whether the code
// compiles (a real run ended with PASS while `tsc` still printed six errors). This gate runs the project's own checks itself,
// once, before the review, and the result goes to three places: the reviewer (real output instead of guesses), the repair run
// (the exact errors to fix) and the delivery report (what really passed).
//
// The shell is injected (`Runner`) so the selection logic is unit-tested without running anything.

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { candidateAppDirs } from "./scaffold-gate";

export interface CheckResult {
  /** Folder the check ran in, relative to the workspace ("." for the root). */
  dir: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** The end of the output (errors come last). */
  output: string;
}

export interface VerifyReport {
  results: CheckResult[];
  /** Every check passed. True when there was nothing to run. */
  ok: boolean;
}

export interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

export type Runner = (command: string, cwd: string, timeoutMs: number) => RunResult | Promise<RunResult>;

const OUTPUT_TAIL = 6000;
const MAX_TARGETS = 3;

export function tailOf(text: string, n = OUTPUT_TAIL): string {
  const t = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim();
  return t.length > n ? `[...]\n${t.slice(-n)}` : t;
}

/** The real shell, asynchronous so the dashboard stays alive. A timeout stops the command; the end of both output streams is kept. */
export const shellRunner: Runner = (command, cwd, timeoutMs) =>
  new Promise<RunResult>((resolve) => {
    let output = "";
    let timedOut = false;
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-200_000);
    };
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, CI: "1", NEXT_TELEMETRY_DISABLED: "1" },
    });
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, output: `${output}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, output });
    });
  });

interface PackageInfo {
  scripts: Record<string, string>;
  hasTypescript: boolean;
}

function readPackage(dir: string): PackageInfo | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return { scripts: pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {}, hasTypescript: Boolean(deps.typescript) };
  } catch {
    return null;
  }
}

/** The checks to run in one folder: its typecheck (own script, else tsc over tsconfig) and, when it has one, its build. */
export function checksFor(dir: string, withBuild: boolean): string[] {
  const pkg = readPackage(dir);
  if (!pkg) return [];
  const commands: string[] = [];
  if (pkg.scripts.typecheck) commands.push("npm run typecheck");
  else if (pkg.hasTypescript && fs.existsSync(path.join(dir, "tsconfig.json"))) commands.push("npx --no-install tsc --noEmit");
  if (withBuild && pkg.scripts.build) commands.push("npm run build");
  return commands;
}

export interface VerifyOptions {
  runner?: Runner;
  withBuild?: boolean;
  typecheckTimeoutMs?: number;
  buildTimeoutMs?: number;
}

/** Runs the project's own typecheck and build. The build only runs when the typecheck of that folder passed. */
export async function runChecks(root: string, opts: VerifyOptions = {}): Promise<VerifyReport> {
  // AGENT_TEAM_VERIFY=0 switches the gate off (for tests and for projects whose build needs services that are not running).
  if (!opts.runner && process.env.AGENT_TEAM_VERIFY === "0") return { results: [], ok: true };
  const runner = opts.runner ?? shellRunner;
  const withBuild = opts.withBuild ?? process.env.AGENT_TEAM_VERIFY_BUILD !== "0";
  const results: CheckResult[] = [];

  const dirs = candidateAppDirs(root).filter((d) => checksFor(d, withBuild).length > 0).slice(0, MAX_TARGETS);
  for (const dir of dirs) {
    const rel = path.relative(root, dir).split(path.sep).join("/") || ".";
    let passed = true;
    for (const command of checksFor(dir, withBuild)) {
      const isBuild = /\bbuild\b/.test(command);
      if (isBuild && !passed) break; // a build on top of failing types only repeats the same errors
      const timeout = isBuild ? opts.buildTimeoutMs ?? 300_000 : opts.typecheckTimeoutMs ?? 180_000;
      const r = await runner(command, dir, timeout);
      const ok = !r.timedOut && r.exitCode === 0;
      results.push({ dir: rel, command, ok, exitCode: r.exitCode, timedOut: r.timedOut, output: tailOf(r.output) });
      if (!ok) passed = false;
    }
  }
  return { results, ok: results.every((r) => r.ok) };
}

/** One line per check, for logs and for the report facts. */
export function summarizeChecks(report: VerifyReport): string {
  if (report.results.length === 0) return "no typecheck or build script was found, nothing was run";
  return report.results
    .map((r) => `${r.dir === "." ? "" : `${r.dir}: `}${r.command} -> ${r.ok ? "passed (exit 0)" : r.timedOut ? "timed out" : `FAILED (exit ${r.exitCode ?? "?"})`}`)
    .join("; ");
}

/** The failing output for the repair run and the reviewer. Empty when everything passed. */
export function failureText(report: VerifyReport, limit = 5000): string {
  const failed = report.results.filter((r) => !r.ok);
  if (failed.length === 0) return "";
  return failed
    .map((r) => `### ${r.dir === "." ? "" : `${r.dir}: `}${r.command} (${r.timedOut ? "timed out" : `exit ${r.exitCode ?? "?"}`})\n${r.output}`)
    .join("\n\n")
    .slice(0, limit);
}

/** The task for the one repair run after a failed check. */
export function checkFixTask(report: VerifyReport): string {
  return [
    "The project's own checks FAIL. This is the real output of the commands, run by the team just now:",
    "",
    failureText(report),
    "",
    "Fix it now:",
    "1. Read the FIRST error of each failing command, then the file it names, in full.",
    "2. Fix the cause in that file with write_file. A missing import or export means the file that should provide it must provide it (read it); do not invent modules or install a library the project does not use (check package.json).",
    "3. Run the same command (npm run typecheck, or npm run build) and fix the next error. Stop when it exits 0.",
    "4. Never silence an error with @ts-ignore, any, or by loosening tsconfig.",
  ].join("\n");
}
