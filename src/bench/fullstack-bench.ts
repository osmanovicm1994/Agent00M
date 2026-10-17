// src/bench/fullstack-bench.ts
// Pure logic of the full-stack benchmark (no process spawning, no model): spec validation, slice selection,
// result summaries, the markdown report and the before/after comparison. The runner (run.ts) does the I/O.
import { z } from "zod";

const AcceptanceSchema = z.union([
  z.object({
    label: z.string().min(1),
    cmd: z.string().min(1),
    timeoutSec: z.number().int().positive().max(1800).optional(),
  }),
  z.object({ label: z.string().min(1), predeploy: z.literal(true) }),
]);

const SliceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "id must be lowercase letters, digits and dashes"),
  title: z.string().min(1),
  task: z.string().min(20),
  accept: z.array(AcceptanceSchema).min(1),
});

export const SpecSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  slices: z.array(SliceSchema).min(1),
});

export type Acceptance = z.infer<typeof AcceptanceSchema>;
export type Slice = z.infer<typeof SliceSchema>;
export type Spec = z.infer<typeof SpecSchema>;

/** Returns a list of problems (empty when the spec is usable). */
export function validateSpec(raw: unknown): string[] {
  const parsed = SpecSchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".") || "spec"}: ${i.message}`);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of parsed.data.slices) {
    if (seen.has(s.id)) problems.push(`duplicate slice id: ${s.id}`);
    seen.add(s.id);
    const labels = new Set<string>();
    for (const a of s.accept) {
      if (labels.has(a.label)) problems.push(`${s.id}: duplicate acceptance label "${a.label}"`);
      labels.add(a.label);
    }
  }
  return problems;
}

export interface SelectOptions {
  from?: string;
  only?: string[];
  max?: number;
}

/** --only wins over --from; --max caps the count after both. Unknown ids throw so a typo is not a silent no-op. */
export function selectSlices(spec: Spec, opts: SelectOptions = {}): Slice[] {
  const ids = spec.slices.map((s) => s.id);
  for (const id of [...(opts.only ?? []), ...(opts.from ? [opts.from] : [])]) {
    if (!ids.includes(id)) throw new Error(`Unknown slice id "${id}". Valid: ${ids.join(", ")}`);
  }
  let list = spec.slices;
  if (opts.only?.length) list = list.filter((s) => opts.only!.includes(s.id));
  else if (opts.from) list = list.slice(ids.indexOf(opts.from));
  if (opts.max !== undefined && opts.max > 0) list = list.slice(0, opts.max);
  return list;
}

export interface AcceptanceResult {
  label: string;
  ok: boolean;
  ms: number;
  /** Last lines of output, kept short so result files stay readable. */
  tail: string;
}

export interface SliceResult {
  id: string;
  title: string;
  /** null when the agent was not run (accept-only / baseline). */
  agentExit: number | null;
  agentMs: number;
  timedOut: boolean;
  steps: number | null;
  filesWritten: number | null;
  /** What the agent run itself ended as (exit code is 0 even when the run failed): see agentOutcome. */
  outcome?: AgentOutcome;
  /** Last stderr lines of the agent process (uncaught errors land here). */
  errorTail?: string;
  acceptance: AcceptanceResult[];
}

export type AgentOutcome = "finished" | "step-limit" | "no-summary" | "timeout" | "crashed";

export type RunMode = "full" | "accept-only" | "baseline";

export interface RunResult {
  startedAt: string;
  mode: RunMode;
  workspace: string;
  model: string;
  specName: string;
  specVersion: number;
  /** AGENT_MAX_STEPS the agent ran with (a slice that used all of them was cut off). */
  maxSteps?: number;
  slices: SliceResult[];
}

export const slicePassed = (s: SliceResult): boolean => s.acceptance.length > 0 && s.acceptance.every((a) => a.ok);

/** Keeps the last `maxLines` lines and `maxChars` characters of command output. */
export function tailOf(text: string, maxLines = 12, maxChars = 800): string {
  const lines = text.trimEnd().split("\n").slice(-maxLines).join("\n");
  return lines.length > maxChars ? lines.slice(-maxChars) : lines;
}

/**
 * Parses the agent's stdout: "(N step(s) taken)" and the written files. `run` prints "Files written (N):" in its
 * summary; `chat` prints a "Files written this session:" list.
 */
export function parseAgentOutput(stdout: string): { steps: number | null; filesWritten: number | null } {
  const plain = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const steps = /\((\d+) step\(s\) taken\)/.exec(plain);
  const summary = /Files written \((\d+)\):/.exec(plain);
  if (summary) return { steps: steps ? Number(steps[1]) : null, filesWritten: Number(summary[1]) };
  const idx = plain.lastIndexOf("Files written this session:");
  let files: number | null = null;
  if (idx >= 0) {
    files = 0;
    for (const line of plain.slice(idx).split("\n").slice(1)) {
      if (/^\s+- \S/.test(line)) files++;
      else break;
    }
  }
  return { steps: steps ? Number(steps[1]) : null, filesWritten: files };
}

/**
 * The CLI exits 0 and prints a normal summary even when the run hit the step limit or died, so the exit code says
 * nothing. No "(N step(s) taken)" line means the run never reached its summary (crash, or killed).
 */
export function agentOutcome(o: { steps: number | null; timedOut: boolean; exit: number | null; maxSteps: number }): AgentOutcome {
  if (o.timedOut) return "timeout";
  if (o.exit !== 0 && o.exit !== null) return "crashed";
  if (o.steps === null) return "no-summary";
  return o.steps >= o.maxSteps ? "step-limit" : "finished";
}

export interface Summary {
  slices: number;
  passed: number;
  /** Slices in a row that passed from the first one: the "how far did it get" number. */
  streak: number;
  firstFailure: string | null;
  checksPassed: number;
  checksTotal: number;
  agentMinutes: number;
  timedOut: number;
  /** Slices that used every step they were given. */
  cutOff: number;
  /** Slices whose agent run never printed its summary (crashed or died). */
  noSummary: number;
}

export function summarize(run: RunResult): Summary {
  let streak = 0;
  let broken = false;
  let firstFailure: string | null = null;
  let checksPassed = 0;
  let checksTotal = 0;
  for (const s of run.slices) {
    const ok = slicePassed(s);
    if (!ok && firstFailure === null) firstFailure = s.id;
    if (ok && !broken) streak++;
    else broken = true;
    checksTotal += s.acceptance.length;
    checksPassed += s.acceptance.filter((a) => a.ok).length;
  }
  return {
    slices: run.slices.length,
    passed: run.slices.filter(slicePassed).length,
    streak,
    firstFailure,
    checksPassed,
    checksTotal,
    agentMinutes: Math.round((run.slices.reduce((n, s) => n + s.agentMs, 0) / 60000) * 10) / 10,
    timedOut: run.slices.filter((s) => s.timedOut).length,
    cutOff: run.slices.filter((s) => s.outcome === "step-limit").length,
    noSummary: run.slices.filter((s) => s.outcome === "no-summary" || s.outcome === "crashed").length,
  };
}

/**
 * Baseline guard: on an EMPTY workspace every acceptance check must fail. A check that passes there proves
 * nothing (for example a negative grep without a presence check). Returns "slice-id: label" for each one.
 */
export function vacuousChecks(run: RunResult): string[] {
  return run.slices.flatMap((s) => s.acceptance.filter((a) => a.ok).map((a) => `${s.id}: ${a.label}`));
}

const cell = (s: string) => s.replace(/\|/g, "\\|");

export function renderMarkdown(run: RunResult): string {
  const sum = summarize(run);
  const out: string[] = [];
  out.push(`# Full-stack benchmark: ${run.specName} v${run.specVersion}`);
  out.push("");
  out.push(`- Started: ${run.startedAt}`);
  out.push(`- Mode: ${run.mode}`);
  out.push(`- Model: ${run.model}`);
  out.push(`- Workspace: ${run.workspace}`);
  out.push("");
  out.push(
    `**Slices passed: ${sum.passed}/${sum.slices}** (unbroken streak from the start: ${sum.streak}; first failure: ${sum.firstFailure ?? "none"}). ` +
      `Checks: ${sum.checksPassed}/${sum.checksTotal}. Agent time: ${sum.agentMinutes} min, ${sum.timedOut} timeout(s), ${sum.cutOff} cut off by the step limit${run.maxSteps ? ` (${run.maxSteps})` : ""}, ${sum.noSummary} without a summary (crashed).`,
  );
  out.push("");
  out.push("| Slice | Result | Checks | Agent | Steps | Files |");
  out.push("|---|---|---|---|---|---|");
  for (const s of run.slices) {
    const ok = s.acceptance.filter((a) => a.ok).length;
    const agent =
      s.agentExit === null ? "-" : s.timedOut ? "timeout" : `${Math.round(s.agentMs / 1000)}s${s.outcome && s.outcome !== "finished" ? ` ${s.outcome}` : ""}`;
    out.push(`| ${cell(s.id)} | ${slicePassed(s) ? "PASS" : "FAIL"} | ${ok}/${s.acceptance.length} | ${agent} | ${s.steps ?? "-"} | ${s.filesWritten ?? "-"} |`);
  }
  const failed = run.slices.filter((s) => !slicePassed(s));
  if (failed.length) {
    out.push("");
    out.push("## Failed checks");
    for (const s of failed) {
      out.push("");
      out.push(`### ${s.id}: ${s.title}`);
      for (const a of s.acceptance.filter((x) => !x.ok)) {
        out.push(`- ${a.label}`);
        if (a.tail) out.push("  ```", ...a.tail.split("\n").map((l) => `  ${l}`), "  ```");
      }
    }
  }
  out.push("");
  out.push("Not measured here: visual quality, whether the app behaves correctly beyond the acceptance commands, security review depth.");
  return out.join("\n");
}

export interface Comparison {
  before: Summary;
  after: Summary;
  improved: string[];
  regressed: string[];
  unchanged: number;
  onlyIn: { before: string[]; after: string[] };
}

/** Compares two runs of the same spec slice by slice (Phase 7: did the changes help?). */
export function compareRuns(before: RunResult, after: RunResult): Comparison {
  const b = new Map(before.slices.map((s) => [s.id, slicePassed(s)]));
  const a = new Map(after.slices.map((s) => [s.id, slicePassed(s)]));
  const improved: string[] = [];
  const regressed: string[] = [];
  let unchanged = 0;
  for (const [id, was] of b) {
    if (!a.has(id)) continue;
    const now = a.get(id)!;
    if (!was && now) improved.push(id);
    else if (was && !now) regressed.push(id);
    else unchanged++;
  }
  return {
    before: summarize(before),
    after: summarize(after),
    improved,
    regressed,
    unchanged,
    onlyIn: {
      before: [...b.keys()].filter((id) => !a.has(id)),
      after: [...a.keys()].filter((id) => !b.has(id)),
    },
  };
}

export function renderComparison(c: Comparison): string {
  const row = (name: string, x: string | number, y: string | number) => `| ${name} | ${x} | ${y} |`;
  return [
    "| | Before | After |",
    "|---|---|---|",
    row("Slices passed", `${c.before.passed}/${c.before.slices}`, `${c.after.passed}/${c.after.slices}`),
    row("Unbroken streak", c.before.streak, c.after.streak),
    row("First failure", c.before.firstFailure ?? "none", c.after.firstFailure ?? "none"),
    row("Checks passed", `${c.before.checksPassed}/${c.before.checksTotal}`, `${c.after.checksPassed}/${c.after.checksTotal}`),
    row("Agent minutes", c.before.agentMinutes, c.after.agentMinutes),
    "",
    `Improved: ${c.improved.join(", ") || "none"}`,
    `Regressed: ${c.regressed.join(", ") || "none"}`,
    `Unchanged: ${c.unchanged}`,
    ...(c.onlyIn.before.length || c.onlyIn.after.length
      ? [`Not comparable (only in one run): before [${c.onlyIn.before.join(", ")}], after [${c.onlyIn.after.join(", ")}]`]
      : []),
    "",
    "One run per side is a small sample: the local model is not deterministic. Treat a single flip as noise; repeat before concluding.",
  ].join("\n");
}
