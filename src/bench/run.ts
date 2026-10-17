// src/bench/run.ts
// Full-stack benchmark runner. Feeds the slices of bench/fullstack/spec.json to the agent one after another in ONE
// workspace (each slice builds on the previous ones) and checks each slice with plain acceptance commands.
//
//   npm run bench:fullstack -- --baseline                     sanity check: every check must FAIL on an empty folder
//   npm run bench:fullstack -- --workspace ~/bench-app        full run (needs LM Studio; takes hours)
//   npm run bench:fullstack -- --workspace ~/bench-app --accept-only   re-check an existing workspace, no agent
//   npm run bench:fullstack -- --compare before.json after.json
//
// Flags: --from <id>  --only <id,id>  --max <n>  --agent-timeout-min <n> (default 45)  --stop-on-fail
//        --team  --research  --mcp  --model <id>  --spec <file>
import "dotenv/config";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import * as dotenv from "dotenv";
import { checkDeployReadiness } from "../tools/deploy.tool";
import {
  agentOutcome,
  compareRuns,
  parseAgentOutput,
  renderComparison,
  renderMarkdown,
  selectSlices,
  summarize,
  tailOf,
  vacuousChecks,
  validateSpec,
  type Acceptance,
  type AcceptanceResult,
  type RunMode,
  type RunResult,
  type SliceResult,
  type Spec,
} from "./fullstack-bench";

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_SPEC = path.join(ROOT, "bench", "fullstack", "spec.json");
const RESULTS_DIR = path.join(ROOT, "bench", "fullstack", "results");

interface Args {
  flags: Set<string>;
  values: Map<string, string>;
  rest: string[];
}

const VALUE_FLAGS = new Set(["workspace", "from", "only", "max", "agent-timeout-min", "max-steps", "model", "spec"]);
// The agent's default is 50 steps, which cut off 7 of 21 slices in the first run. The benchmark gives each slice more.
const DEFAULT_BENCH_MAX_STEPS = 300;

function parseArgs(argv: string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const name = a.slice(2);
    if (VALUE_FLAGS.has(name)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`--${name} needs a value`);
      values.set(name, v);
    } else flags.add(name);
  }
  return { flags, values, rest };
}

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

function loadSpec(file: string): Spec {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const problems = validateSpec(raw);
  if (problems.length) throw new Error(`Invalid spec ${file}:\n  ${problems.join("\n  ")}`);
  return raw as Spec;
}

function loadRun(file: string): RunResult {
  return JSON.parse(fs.readFileSync(path.resolve(expandHome(file)), "utf8")) as RunResult;
}

function git(ws: string, args: string[]): void {
  spawnSync("git", args, { cwd: ws, stdio: "ignore" });
}

function prepareWorkspace(ws: string): void {
  fs.mkdirSync(ws, { recursive: true });
  if (!fs.existsSync(path.join(ws, ".git"))) {
    git(ws, ["init", "-q"]);
    git(ws, ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "-q", "--allow-empty", "-m", "bench start"]);
  }
}

function runAcceptance(ws: string, entry: Acceptance): AcceptanceResult {
  const t0 = Date.now();
  if ("predeploy" in entry) {
    const results = checkDeployReadiness(ws);
    const failed = results.filter((r) => r.level === "fail");
    const ok = results.length > 0 && failed.length === 0;
    return {
      label: entry.label,
      ok,
      ms: Date.now() - t0,
      tail: failed.map((f) => `${f.id}: ${f.message}`).join("\n"),
    };
  }
  const res = spawnSync("sh", ["-c", entry.cmd], {
    cwd: ws,
    encoding: "utf8",
    timeout: (entry.timeoutSec ?? 120) * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const timedOut = res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return {
    label: entry.label,
    ok: res.status === 0 && !timedOut,
    ms: Date.now() - t0,
    tail: timedOut ? `timed out after ${entry.timeoutSec ?? 120}s\n${tailOf(out, 6)}` : tailOf(out),
  };
}

interface AgentRun {
  exit: number | null;
  timedOut: boolean;
  ms: number;
  stdout: string;
  stderr: string;
}

function runAgent(task: string, ws: string, timeoutMin: number, maxSteps: number, extra: string[], logFile: string): Promise<AgentRun> {
  return new Promise((resolve) => {
    const tsNode = require.resolve("ts-node/dist/bin.js");
    const args = [tsNode, "src/cli.ts", "run", task, "-p", ws, "-y", ...extra];
    const env = { ...process.env, AGENT_MAX_STEPS: String(maxSteps) };
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    const log = fs.createWriteStream(logFile);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const t0 = Date.now();
    child.stdout.on("data", (d) => {
      stdout += d;
      log.write(d);
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      log.write(d);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMin * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      log.end();
      resolve({ exit: code, timedOut, ms: Date.now() - t0, stdout, stderr });
    });
    child.on("error", () => {
      clearTimeout(timer);
      log.end();
      resolve({ exit: null, timedOut, ms: Date.now() - t0, stdout, stderr });
    });
  });
}

function save(run: RunResult, stamp: string): string {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const base = path.join(RESULTS_DIR, `${stamp}-${run.mode}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(run, null, 2));
  fs.writeFileSync(`${base}.md`, renderMarkdown(run));
  return base;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.has("compare")) {
    const [a, b] = args.rest;
    if (!a || !b) throw new Error("Usage: --compare <before.json> <after.json>");
    console.log(renderComparison(compareRuns(loadRun(a), loadRun(b))));
    return 0;
  }

  dotenv.config({ path: path.join(ROOT, ".env.local") });
  const spec = loadSpec(path.resolve(expandHome(args.values.get("spec") ?? DEFAULT_SPEC)));
  const slices = selectSlices(spec, {
    from: args.values.get("from"),
    only: args.values.get("only")?.split(",").map((s) => s.trim()).filter(Boolean),
    max: args.values.has("max") ? Number(args.values.get("max")) : undefined,
  });
  const baseline = args.flags.has("baseline");
  const acceptOnly = args.flags.has("accept-only");
  const mode: RunMode = baseline ? "baseline" : acceptOnly ? "accept-only" : "full";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  let ws: string;
  if (baseline) ws = fs.mkdtempSync(path.join(os.tmpdir(), "bench-empty-"));
  else ws = path.resolve(expandHome(args.values.get("workspace") ?? path.join(ROOT, "bench", "fullstack", "workspace")));
  if (mode === "full") prepareWorkspace(ws);
  else if (!fs.existsSync(ws)) throw new Error(`Workspace not found: ${ws}`);

  const logDir = path.join(RESULTS_DIR, `${stamp}-logs`);
  if (mode === "full") fs.mkdirSync(logDir, { recursive: true });

  const extra: string[] = [];
  if (!args.flags.has("mcp")) extra.push("--no-mcp");
  if (args.flags.has("team")) extra.push("--team");
  if (args.flags.has("research")) extra.push("--research");
  if (args.values.has("model")) extra.push("-m", args.values.get("model")!);
  const timeoutMin = Number(args.values.get("agent-timeout-min") ?? 45);
  const maxSteps = Number(args.values.get("max-steps") ?? DEFAULT_BENCH_MAX_STEPS);

  console.log(`Benchmark: ${spec.name} (v${spec.version}), mode ${mode}, ${slices.length} slice(s)\nWorkspace: ${ws}\n`);

  const results: SliceResult[] = [];
  for (const [i, slice] of slices.entries()) {
    console.log(`[${i + 1}/${slices.length}] ${slice.id}: ${slice.title}`);
    let agent: AgentRun | undefined;
    if (mode === "full") {
      agent = await runAgent(slice.task, ws, timeoutMin, maxSteps, extra, path.join(logDir, `${slice.id}.log`));
    }
    const acceptance = slice.accept.map((a) => {
      const r = runAcceptance(ws, a);
      console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label}`);
      return r;
    });
    const parsed = agent ? parseAgentOutput(agent.stdout) : { steps: null, filesWritten: null };
    const outcome = agent ? agentOutcome({ steps: parsed.steps, timedOut: agent.timedOut, exit: agent.exit, maxSteps }) : undefined;
    if (agent) console.log(`  agent: ${outcome} in ${Math.round(agent.ms / 1000)}s (steps ${parsed.steps ?? "-"}, files ${parsed.filesWritten ?? "-"})`);
    const result: SliceResult = {
      id: slice.id,
      title: slice.title,
      agentExit: agent ? agent.exit : null,
      agentMs: agent?.ms ?? 0,
      timedOut: agent?.timedOut ?? false,
      steps: parsed.steps,
      filesWritten: parsed.filesWritten,
      outcome,
      errorTail: agent && agent.stderr.trim() ? tailOf(agent.stderr, 8, 600) : undefined,
      acceptance,
    };
    results.push(result);
    if (mode === "full" && acceptance.some((a) => !a.ok)) {
      if (args.flags.has("stop-on-fail")) break;
      // Keep each slice's changes separate in git, so a later failure can be traced to the slice that caused it.
    }
    if (mode === "full") {
      git(ws, ["add", "-A"]);
      git(ws, ["-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "-q", "--allow-empty", "-m", `slice ${slice.id}`]);
    }
  }

  const run: RunResult = {
    startedAt: new Date().toISOString(),
    mode,
    workspace: ws,
    model: process.env.AI_MODEL_NAME ?? args.values.get("model") ?? "unknown",
    specName: spec.name,
    specVersion: spec.version,
    maxSteps: mode === "full" ? maxSteps : undefined,
    slices: results,
  };

  if (baseline) {
    fs.rmSync(ws, { recursive: true, force: true });
    const vacuous = vacuousChecks(run);
    if (vacuous.length) {
      console.log(`\nBASELINE PROBLEM: ${vacuous.length} check(s) pass on an empty folder, so they prove nothing:`);
      for (const v of vacuous) console.log(`  - ${v}`);
      return 1;
    }
    console.log(`\nBaseline OK: all ${run.slices.reduce((n, s) => n + s.acceptance.length, 0)} checks fail on an empty folder.`);
    return 0;
  }

  const base = save(run, stamp);
  const sum = summarize(run);
  console.log(`\nSlices passed ${sum.passed}/${sum.slices}, streak ${sum.streak}, first failure ${sum.firstFailure ?? "none"}.`);
  console.log(`Saved: ${base}.json and .md`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err?.message ?? err);
    process.exit(2);
  },
);
