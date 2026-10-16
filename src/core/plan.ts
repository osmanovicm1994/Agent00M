// A persisted build plan: `.agent/plan.md` in the TARGET project. A long task (a whole app) outlives the model's
// context window; the plan is what survives. The agent writes it with the `update_plan` tool, ticks steps off only
// after verifying them, and a later run (or the same run after history compaction) reads it back.
//
// Everything except PlanStore is pure and unit-tested (plan.test.ts).

import * as fs from "fs";
import * as path from "path";
import type { ToolSchema } from "../llm/types";

export interface PlanStep {
  text: string;
  done: boolean;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  notes: string[];
}

export const PLAN_DIR = ".agent";
export const PLAN_FILE = "plan.md";
const MAX_STEPS = 30;
const MAX_STEP_CHARS = 200;
const MAX_GOAL_CHARS = 300;
const MAX_NOTES = 12;
const MAX_NOTE_CHARS = 300;

export function emptyPlan(): Plan {
  return { goal: "", steps: [], notes: [] };
}

export function parsePlan(md: string): Plan {
  const plan = emptyPlan();
  let inNotes = false;
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (/^##\s+notes/i.test(line)) {
      inNotes = true;
      continue;
    }
    if (inNotes) {
      if (line.startsWith("- ")) plan.notes.push(line.slice(2));
      continue;
    }
    const goal = /^goal:\s*(.*)$/i.exec(line);
    if (goal) {
      plan.goal = goal[1];
      continue;
    }
    const step = /^- \[( |x|X)\]\s*(?:\d+[.)]\s*)?(.+)$/.exec(line);
    if (step) plan.steps.push({ text: step[2].trim(), done: step[1].toLowerCase() === "x" });
  }
  return plan;
}

export function renderPlan(plan: Plan): string {
  const lines = ["# Plan"];
  if (plan.goal) lines.push(`Goal: ${plan.goal}`);
  lines.push("");
  plan.steps.forEach((s, i) => lines.push(`- [${s.done ? "x" : " "}] ${i + 1}. ${s.text}`));
  if (plan.notes.length) lines.push("", "## Notes", ...plan.notes.map((n) => `- ${n}`));
  return lines.join("\n") + "\n";
}

/** 1-based number of the first step that is not done, or undefined when every step is done. */
export function nextStep(plan: Plan): number | undefined {
  const i = plan.steps.findIndex((s) => !s.done);
  return i === -1 ? undefined : i + 1;
}

export function openSteps(plan: Plan): { n: number; text: string }[] {
  return plan.steps.map((s, i) => ({ n: i + 1, text: s.text, done: s.done })).filter((s) => !s.done).map(({ n, text }) => ({ n, text }));
}

/** The plan plus one status line, as returned to the model. */
export function describePlan(plan: Plan): string {
  const done = plan.steps.filter((s) => s.done).length;
  const next = nextStep(plan);
  const status =
    plan.steps.length === 0
      ? "The plan has no steps."
      : next === undefined
        ? `All ${plan.steps.length} steps are done: run the final check and give your answer.`
        : `${done}/${plan.steps.length} done. Next: step ${next}.`;
  return `${renderPlan(plan)}\n${status}`;
}

export interface PlanUpdate {
  goal?: unknown;
  steps?: unknown;
  done?: unknown;
  reopen?: unknown;
  note?: unknown;
}

function cleanStep(text: string): string {
  return text
    .replace(/^\s*(?:[-*]\s*)?(?:\[[ xX]\]\s*)?(?:\d+[.)]\s*)?/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_STEP_CHARS);
}

function toStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? ""));
  if (typeof v === "string") return v.split("\n");
  return [];
}

function toNumbers(v: unknown): number[] {
  const list = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v];
  return list.map((x) => Number(x)).filter((n) => Number.isInteger(n));
}

/** Applies one update: replace steps, set the goal, mark steps done or open again, add a note. Never throws. */
export function applyPlanUpdate(current: Plan, update: PlanUpdate): { plan: Plan; warnings: string[] } {
  const warnings: string[] = [];
  const plan: Plan = { goal: current.goal, steps: current.steps.map((s) => ({ ...s })), notes: [...current.notes] };

  if (typeof update.goal === "string" && update.goal.trim()) plan.goal = update.goal.trim().slice(0, MAX_GOAL_CHARS);

  if (update.steps !== undefined) {
    const texts = toStrings(update.steps).map(cleanStep).filter(Boolean);
    if (texts.length > MAX_STEPS) warnings.push(`Only the first ${MAX_STEPS} steps were kept: split big steps instead of listing more.`);
    const previous = new Map(plan.steps.map((s) => [s.text.toLowerCase(), s.done]));
    plan.steps = texts.slice(0, MAX_STEPS).map((text) => ({ text, done: previous.get(text.toLowerCase()) ?? false }));
  }

  for (const [key, value] of [["done", true], ["reopen", false]] as const) {
    for (const n of toNumbers(update[key])) {
      if (n < 1 || n > plan.steps.length) warnings.push(`Step ${n} does not exist (the plan has ${plan.steps.length} steps).`);
      else plan.steps[n - 1].done = value;
    }
  }

  if (typeof update.note === "string" && update.note.trim()) {
    plan.notes.push(update.note.trim().replace(/\s+/g, " ").slice(0, MAX_NOTE_CHARS));
    plan.notes = plan.notes.slice(-MAX_NOTES);
  }
  return { plan, warnings };
}

export class PlanStore {
  constructor(private readonly workspaceRoot: string) {}

  get file(): string {
    return path.join(this.workspaceRoot, PLAN_DIR, PLAN_FILE);
  }

  /** The saved plan, or null when there is none (or it has no steps). */
  load(): Plan | null {
    try {
      const plan = parsePlan(fs.readFileSync(this.file, "utf8"));
      return plan.steps.length > 0 ? plan : null;
    } catch {
      return null;
    }
  }

  save(plan: Plan): void {
    const dir = path.join(this.workspaceRoot, PLAN_DIR);
    fs.mkdirSync(dir, { recursive: true });
    // Bookkeeping, not source: keep it out of git unless the user decides otherwise.
    const ignore = path.join(dir, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n", "utf8");
    fs.writeFileSync(this.file, renderPlan(plan), "utf8");
  }
}

export const planToolSchema: ToolSchema = {
  name: "update_plan",
  description:
    "Keep the build plan in .agent/plan.md. Use it for any task with 4 or more steps (a feature, a whole app): write the steps FIRST (small, each verifiable), " +
    "then mark a step done only after you verified it (typecheck, test, or the command ran). The plan survives a long session: call update_plan with no arguments to read it again. " +
    "No approval needed. Pass any of: steps (replaces the list; finished steps with the same text stay done), done (step numbers to tick), reopen, goal, note (a decision or blocker worth remembering).",
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string", description: "One sentence: what 'done' looks like for the whole task" },
      steps: { type: "array", items: { type: "string" }, description: "The ordered steps (replaces the current list)" },
      done: { type: "array", items: { type: "number" }, description: "Step numbers (1-based) that are finished AND verified" },
      reopen: { type: "array", items: { type: "number" }, description: "Step numbers to mark as not done again" },
      note: { type: "string", description: "A decision, assumption or blocker to remember" },
    },
  },
};
