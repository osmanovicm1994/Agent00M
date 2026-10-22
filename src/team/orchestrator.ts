// src/team/orchestrator.ts
//
// Team mode: one request goes through a small "company" workflow instead of a single agent.
//
//   request ─► Project Manager (plan) ─► you approve ─► for each task: UX spec / engineer (Executor loop)
//           ─► Safety Reviewer (read-only) ─► one fix round if it finds blockers ─► PM delivery report
//
// Lead roles (Project Manager, UX) run on Gemini when `think` is given (the user opted into Gemini triage); with no
// `think`, or when Gemini fails, they run on the local model. Engineers and the reviewer always run locally.
// Each engineer gets a fresh, small context (the assignment, the
// acceptance criteria and a short summary of earlier steps) rather than one ever-growing conversation,
// which keeps a local model fast and focused.
//
// Parallel mode (`opts.parallel`): the PM also gives every task a write scope and the tasks it waits for. UX runs
// first; the engineer tasks then run through the OrchestraMaster, independent ones at the same time, each confined to
// its scope. A plan that cannot be run safely in parallel (no scope, overlapping scopes, a cycle) runs one after
// another exactly as before.

import pc from "picocolors";
import prompts from "prompts";
import type { LLMProvider } from "../llm/types";
import { bus } from "../core/events";
import type { Executor, ExecutorResult } from "../core/executor";
import { getAgent } from "../agents/definitions";
import { OrchestraMaster, type TaskRunner } from "../orchestra/orchestra-master";
import type { WorkspaceLocks } from "../orchestra/workspace-locks";
import type { Blackboard } from "../orchestra/blackboard";
import { planToOrchTasks } from "./parallel";
import { projectTree } from "./tree";
import { NO_FILES_NUDGE, applyEvidence, isComplete, lacksEvidence } from "./evidence";
import {
  ASSIGNABLE_ROLES,
  PM_KNOWLEDGE,
  PM_PARALLEL_ADDENDUM,
  PM_SYSTEM,
  REPORT_SYSTEM,
  ROLE_TITLES,
  UX_SYSTEM,
  pmPlanSchema,
  safetyAgent,
  type PmPlan,
} from "./roles";

export type TaskStatus = "done" | "incomplete" | "skipped" | "interrupted";
export type SafetyVerdict = "PASS" | "FAIL" | "UNKNOWN" | "NOT_RUN";

export interface TeamTaskOutcome {
  role: string;
  title: string;
  status: TaskStatus;
  summary: string;
}

export interface TeamResult {
  plan: PmPlan;
  tasks: TeamTaskOutcome[];
  filesWritten: string[];
  commandsRun: string[];
  safety: SafetyVerdict;
  safetyNotes: string;
  interrupted: boolean;
  /** Every task done (builders wrote files), not stopped, and the safety review passed or had nothing to review. */
  complete: boolean;
  report: string;
}

export interface ParallelOptions {
  /** Runs one task as an agent loop (see makeTaskRunner in orchestra/wire.ts). */
  runner: TaskRunner;
  locks: WorkspaceLocks;
  /** How many tasks may run at once. Default 2. */
  concurrency?: number;
  board?: Blackboard;
  /** Called when the orchestra starts; the returned signal aborts the whole parallel run (Ctrl+C). */
  beginRun?(): AbortSignal;
  /** Called when the orchestra has finished, whatever the outcome. */
  endRun?(): void;
  /** Aborts the parallel run in progress. Returns false when none is running. Used by the Ctrl+C handler. */
  cancel?(): boolean;
}

export interface TeamOptions {
  llm: LLMProvider;
  executor: Executor;
  task: string;
  workspaceRoot: string;
  /** Extra guidance for everyone: the Gemini triage plan, the reference-design brief. */
  context?: string;
  /** Ask the user to approve the PM's plan before work starts. */
  approvePlan: boolean;
  /** Gemini hook for the lead roles. Returns null on failure (the local model then does the step). */
  think?: (system: string, user: string, maxTokens: number, json?: boolean) => Promise<string | null>;
  /** Run independent engineer tasks at the same time. Needs auto-write and auto-run (nobody can answer prompts). */
  parallel?: ParallelOptions;
}

const MAX_SUMMARY = 700;

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)} …` : t;
}

async function ask(llm: LLMProvider, system: string, user: string, maxTokens = 2500): Promise<string> {
  const res = await llm.chat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    undefined,
    { temperature: 0.2, maxTokens },
  );
  return res.content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// A lead-role step: Gemini first when available, the local model otherwise.
async function lead(opts: TeamOptions, system: string, user: string, maxTokens: number, json = false): Promise<string> {
  if (opts.think) {
    const text = await opts.think(system, user, maxTokens, json);
    if (text) return text;
    console.log(pc.dim("  (Gemini unavailable for this step, the local model takes over)"));
  }
  return ask(opts.llm, system, user, maxTokens);
}

// The PM and the UX designer plan from the real tree of the project (three levels), so they know what exists.
const projectListing = (root: string): string => projectTree(root);

function parsePlan(raw: string): PmPlan {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("the Project Manager did not return a JSON plan");
  return pmPlanSchema.parse(JSON.parse(raw.slice(start, end + 1)));
}

async function planWithPm(opts: TeamOptions): Promise<PmPlan> {
  const user =
    `<request>\n${opts.task}\n</request>\n\n<project_tree>\n${projectListing(opts.workspaceRoot)}\n</project_tree>` +
    (opts.context ? `\n\n<extra_context>\n${clip(opts.context, 5000)}\n</extra_context>` : "");
  const system = PM_SYSTEM + (opts.parallel ? PM_PARALLEL_ADDENDUM : "") + PM_KNOWLEDGE;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await lead(opts, system, attempt === 0 ? user : `${user}\n\nYour previous answer was not valid (${lastErr}). Reply with ONLY the JSON object.`, 2500, true);
    try {
      const plan = parsePlan(raw);
      // Keep only roles that exist; unknown ones fall back to the general engineer.
      plan.tasks = plan.tasks.slice(0, 6).map((t) => ({
        ...t,
        role: (ASSIGNABLE_ROLES as readonly string[]).includes(t.role) ? t.role : "dev",
      }));
      return plan;
    } catch (err: any) {
      lastErr = String(err?.message ?? err).split("\n")[0].slice(0, 200);
    }
  }
  throw new Error(`could not get a usable plan from the Project Manager (${lastErr})`);
}

function printPlan(plan: PmPlan, parallel: boolean): void {
  console.log(pc.bold(`\n📋 Project Manager: ${plan.goal}`));
  plan.tasks.forEach((t, i) => {
    console.log(`  ${i + 1}. ${pc.cyan(`[${ROLE_TITLES[t.role] ?? t.role}]`)} ${t.title}`);
    if (parallel && t.role !== "ux") {
      const after = t.dependsOn.length ? `after ${t.dependsOn.join(", ")}` : "no wait";
      console.log(pc.dim(`       ⇢ writes: ${t.scope.join(", ") || "(no scope given)"} · ${after}`));
    }
    t.acceptance.forEach((a) => console.log(pc.dim(`       ✓ ${a}`)));
  });
  if (plan.assumptions.length) console.log(pc.dim(`  Assumptions: ${plan.assumptions.join("; ")}`));
  if (plan.risks.length) console.log(pc.yellow(`  Risks: ${plan.risks.join("; ")}`));
  if (plan.questions.length) console.log(pc.yellow(`  Open questions: ${plan.questions.join("; ")}`));
  console.log(pc.dim("  🛡  A Safety Reviewer checks the result at the end.\n"));

  // The same plan as plain text for the dashboard.
  const lines = [`Project Manager: ${plan.goal}`];
  plan.tasks.forEach((t, i) => {
    lines.push(`${i + 1}. [${ROLE_TITLES[t.role] ?? t.role}] ${t.title}`);
    t.acceptance.forEach((a) => lines.push(`     ✓ ${a}`));
  });
  if (plan.assumptions.length) lines.push(`Assumptions: ${plan.assumptions.join("; ")}`);
  if (plan.risks.length) lines.push(`Risks: ${plan.risks.join("; ")}`);
  if (plan.questions.length) lines.push(`Open questions: ${plan.questions.join("; ")}`);
  bus.emit("log", { text: lines.join("\n"), level: "plan" });
}

// The same discipline the Executor enforces with its write gates, stated up front so the model does not hit them blindly.
const FILE_RULE =
  "File rule: before you write a file, check whether it exists (list_dir, find_files). If it exists, read it completely and change it in place; do not create a second copy or a new file with the same purpose. If it does not exist, make sure its folder exists and was looked at first.";

function assignment(plan: PmPlan, index: number, notes: string[], uxSpec: string, extra?: string): string {
  const t = plan.tasks[index];
  const parts = [
    "## TEAM ASSIGNMENT",
    `Overall goal: ${plan.goal}`,
    `You are the ${ROLE_TITLES[t.role] ?? t.role}. This is task ${index + 1} of ${plan.tasks.length}: ${t.title}`,
    t.instructions ? `Instructions: ${t.instructions}` : "",
    t.acceptance.length ? `Acceptance criteria (you are done only when these hold, and you have checked them):\n${t.acceptance.map((a) => `- ${a}`).join("\n")}` : "",
    plan.risks.length ? `Risks to avoid: ${plan.risks.join("; ")}` : "",
    plan.assumptions.length ? `Assumptions made by the planner (verify them against the real files): ${plan.assumptions.join("; ")}` : "",
    FILE_RULE,
    notes.length ? `What the team has done so far:\n${notes.join("\n")}` : "",
    uxSpec ? `## UX SPEC (build to this)\n${clip(uxSpec, 4500)}` : "",
    extra ? clip(extra, 5000) : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}

const isStopped = (r: ExecutorResult) => /^Stopped/i.test(r.finalMessage.trim());

function parseVerdict(text: string): SafetyVerdict {
  const m = /VERDICT:\s*(PASS|FAIL)/i.exec(text);
  return m ? (m[1].toUpperCase() as SafetyVerdict) : "UNKNOWN";
}

async function review(opts: TeamOptions, plan: PmPlan, files: string[], label: string): Promise<{ verdict: SafetyVerdict; notes: string; interrupted: boolean }> {
  console.log(pc.bold(`\n🛡  ${label}`));
  bus.emit("log", { text: label, level: "step" });
  const res = await opts.executor.run(
    safetyAgent,
    `Review the work done for this goal: ${plan.goal}`,
    `## REVIEW SCOPE\nFiles changed by the team (read every one in full):\n${files.length ? files.map((f) => `- ${f}`).join("\n") : "- (none reported; use git status and git diff if this is a git repository)"}\n` +
      (plan.risks.length ? `\nRisks the planner flagged: ${plan.risks.join("; ")}\n` : "") +
      "\nEnd with the VERDICT format from your instructions.",
  );
  return { verdict: parseVerdict(res.finalMessage), notes: res.finalMessage, interrupted: Boolean(res.interrupted) };
}

function fallbackReport(r: Omit<TeamResult, "report">): string {
  const lines = [
    `**Result:** ${r.interrupted ? "Stopped by you before finishing." : r.complete ? "All planned tasks finished and the safety review passed." : "NOT complete: some tasks did not finish or the safety review did not pass."}`,
    `**What changed:** ${r.filesWritten.length ? r.filesWritten.map((f) => `\n- ${f}`).join("") : "no files were written"}`,
    `**Checked:** ${r.commandsRun.length ? `${r.commandsRun.length} command(s) run. ` : "no commands were run. "}Safety review: ${r.safety}.`,
    `**Open items:** ${r.tasks.filter((t) => t.status !== "done").map((t) => t.title).join("; ") || "none"}`,
    "**Next step:** review the changes in your version control before committing.",
  ];
  return lines.join("\n");
}

/**
 * Runs the whole workflow. Returns null when the user declined the plan or no plan could be made
 * (the caller then falls back to the normal single-agent path).
 */
export async function runTeam(opts: TeamOptions): Promise<TeamResult | null> {
  console.log(pc.bold(`\n🏢 Team mode: Project Manager is planning${opts.think ? " (Gemini)" : ""} …`));
  bus.emit("log", { text: "Team mode: the Project Manager is planning…", level: "step" });

  let plan: PmPlan;
  try {
    plan = await planWithPm(opts);
  } catch (err: any) {
    console.log(pc.yellow(`⚠ Team planning failed: ${err?.message ?? err}\n  Falling back to a single agent.`));
    return null;
  }

  printPlan(plan, Boolean(opts.parallel));

  if (plan.questions.length && opts.approvePlan) {
    console.log(pc.yellow("The planner has open questions. Answer them in your next message if they matter; the team can still start now.\n"));
  }
  if (opts.approvePlan) {
    const ok = await prompts({ type: "confirm", name: "ok", message: "Start this plan?", initial: true });
    if (ok.ok === false || ok.ok === undefined) {
      console.log(pc.dim("Plan not started."));
      return null;
    }
  }

  const outcomes: TeamTaskOutcome[] = [];
  const files = new Set<string>();
  const commands: string[] = [];
  const notes: string[] = [];
  const blockedWrites: string[] = [];
  const handled = new Set<number>();
  let uxSpec = "";
  let interrupted = false;
  let lastEngineer = "dev";

  // One task, one after another. Also runs the UX tasks in parallel mode.
  const runTask = async (i: number): Promise<void> => {
    handled.add(i);
    const t = plan.tasks[i];
    const title = ROLE_TITLES[t.role] ?? t.role;
    console.log(pc.bold(`\n━━ [${i + 1}/${plan.tasks.length}] ${title}: ${t.title}`));
    bus.emit("log", { text: `[${i + 1}/${plan.tasks.length}] ${title}: ${t.title}`, level: "step" });

    if (t.role === "ux") {
      try {
        const user =
          `<goal>${plan.goal}</goal>\n<task>${t.title}\n${t.instructions}</task>\n` +
          `<project_tree>\n${projectListing(opts.workspaceRoot)}\n</project_tree>` +
          (opts.context ? `\n\n<reference_and_context>\n${clip(opts.context, 6000)}\n</reference_and_context>` : "");
        uxSpec = await lead(opts, UX_SYSTEM, user, 3000);
        console.log(pc.dim(clip(uxSpec, 1200)));
        notes.push(`- UX Designer wrote a build spec for: ${t.title}`);
        outcomes.push({ role: t.role, title: t.title, status: "done", summary: "UX spec written" });
      } catch (err: any) {
        console.log(pc.yellow(`⚠ UX spec failed: ${err?.message ?? err}`));
        outcomes.push({ role: t.role, title: t.title, status: "incomplete", summary: "UX spec could not be written" });
      }
      return;
    }

    const agent = getAgent(t.role);
    if (!agent) {
      console.log(pc.yellow(`⚠ No agent for role '${t.role}', skipped.`));
      outcomes.push({ role: t.role, title: t.title, status: "skipped", summary: "no such agent" });
      return;
    }

    if (t.role !== "qa") lastEngineer = t.role;
    const taskText = `${t.title}${t.instructions ? `\n${t.instructions}` : ""}`;
    let res = await opts.executor.run(agent, taskText, assignment(plan, i, notes, uxSpec, opts.context));
    // A builder that ended without writing a file delivered nothing: one more attempt, stated plainly.
    if (!res.interrupted && !isStopped(res) && lacksEvidence(t.role, res.filesWritten)) {
      console.log(pc.yellow("⚠ This task wrote no files. One more attempt with a stricter instruction."));
      const again = await opts.executor.run(agent, taskText, `${assignment(plan, i, notes, uxSpec, opts.context)}\n\n${NO_FILES_NUDGE}`);
      res = {
        ...again,
        filesWritten: [...new Set([...res.filesWritten, ...again.filesWritten])],
        commandsRun: [...res.commandsRun, ...again.commandsRun],
      };
    }
    res.filesWritten.forEach((f) => files.add(f));
    commands.push(...res.commandsRun);

    const rawStatus: TaskStatus = res.interrupted ? "interrupted" : isStopped(res) || res.unresolvedFailure ? "incomplete" : "done";
    const status = applyEvidence(t.role, rawStatus, res.filesWritten);
    if (status !== rawStatus) console.log(pc.yellow(`⚠ ${title}: no file was written, so this task is NOT counted as done.`));
    const summary = clip(res.finalMessage, MAX_SUMMARY);
    outcomes.push({ role: t.role, title: t.title, status, summary });
    notes.push(`- ${title} (${status}): ${t.title}. Files: ${res.filesWritten.join(", ") || "none"}. ${clip(res.finalMessage, 300)}`);
    if (res.interrupted) interrupted = true;
  };

  // Parallel mode: UX first (its spec goes into every task), then the engineer tasks side by side.
  if (opts.parallel) {
    for (let i = 0; i < plan.tasks.length && !interrupted; i++) if (plan.tasks[i].role === "ux") await runTask(i);

    const graph = planToOrchTasks(plan, uxSpec);
    if (interrupted) {
      // nothing more to do
    } else if (graph.problems.length > 0) {
      console.log(pc.yellow(`\n⚠ This plan cannot run in parallel, so the tasks run one after another:`));
      graph.problems.forEach((p) => console.log(pc.yellow(`   - ${p}`)));
    } else {
      const concurrency = Math.max(1, opts.parallel.concurrency ?? 2);
      console.log(pc.bold(`\n🎼 Orchestra: ${graph.tasks.length} tasks, up to ${concurrency} at the same time`));
      const signal = opts.parallel.beginRun?.();
      const master = new OrchestraMaster({
        runner: opts.parallel.runner,
        locks: opts.parallel.locks,
        board: opts.parallel.board,
        concurrency,
        signal,
        log: (line) => console.log(pc.dim(line)),
      });
      let res: Awaited<ReturnType<OrchestraMaster["run"]>>;
      try {
        res = await master.run(graph.tasks);
      } finally {
        opts.parallel.endRun?.();
      }
      // Ctrl+C stopped the run: no safety review or fix round after it, even if no task reported itself interrupted.
      if (signal?.aborted) interrupted = true;
      for (const id of res.order) {
        const idx = graph.indexOf.get(id);
        if (idx === undefined) continue;
        handled.add(idx);
        const t = plan.tasks[idx];
        const o = res.outcomes[id];
        const status = applyEvidence(
          t.role,
          o.status === "done" ? "done" : o.status === "interrupted" ? "interrupted" : o.status === "skipped" ? "skipped" : "incomplete",
          o.filesWritten,
        );
        o.filesWritten.forEach((f) => files.add(f));
        commands.push(...o.commandsRun);
        outcomes.push({ role: t.role, title: t.title, status, summary: clip(o.summary, MAX_SUMMARY) });
        notes.push(`- ${ROLE_TITLES[t.role] ?? t.role} (${status}): ${t.title}. Files: ${o.filesWritten.join(", ") || "none"}.`);
        if (t.role !== "qa") lastEngineer = t.role;
        if (o.status === "interrupted") interrupted = true;
      }
      const denied = [...new Set(res.denials.map((d) => `${d.owner}: ${d.path}`))];
      if (denied.length) {
        blockedWrites.push(...denied);
        console.log(pc.yellow(`\n⚠ ${denied.length} write(s) were refused because they were outside the task's scope:`));
        denied.slice(0, 10).forEach((d) => console.log(pc.yellow(`   - ${d}`)));
      }
    }
  }

  for (let i = 0; i < plan.tasks.length && !interrupted; i++) {
    if (handled.has(i)) continue;
    await runTask(i);
  }

  // Safety review of whatever was written.
  let safety: SafetyVerdict = "NOT_RUN";
  let safetyNotes = "";
  if (!interrupted && files.size > 0) {
    let r = await review(opts, plan, [...files], "Safety Reviewer is checking the changes …");
    interrupted = r.interrupted;
    safety = r.verdict;
    safetyNotes = r.notes;

    if (safety === "FAIL" && !interrupted) {
      console.log(pc.yellow("\n🛡  Blockers found. One fix round follows."));
      bus.emit("log", { text: "Safety Reviewer found blockers. One fix round follows.", level: "warn" });
      const fixAgent = getAgent(lastEngineer) ?? getAgent("dev");
      if (fixAgent) {
        const fixRes = await opts.executor.run(
          fixAgent,
          "Fix ONLY the blockers listed by the Safety Reviewer. Do not change anything else.",
          `## SAFETY REVIEW FINDINGS\n${clip(safetyNotes, 4000)}\n\nGoal of the original work: ${plan.goal}`,
        );
        fixRes.filesWritten.forEach((f) => files.add(f));
        commands.push(...fixRes.commandsRun);
        outcomes.push({ role: lastEngineer, title: "Fix safety blockers", status: fixRes.interrupted ? "interrupted" : isStopped(fixRes) ? "incomplete" : "done", summary: clip(fixRes.finalMessage, MAX_SUMMARY) });
        if (fixRes.interrupted) {
          interrupted = true;
        } else {
          r = await review(opts, plan, [...files], "Safety Reviewer is re-checking …");
          interrupted = r.interrupted;
          safety = r.verdict;
          safetyNotes = r.notes;
        }
      }
    }
  }

  const complete = isComplete({ statuses: outcomes.map((o) => o.status), interrupted, safety });
  const base: Omit<TeamResult, "report"> = {
    plan,
    tasks: outcomes,
    filesWritten: [...files],
    commandsRun: commands,
    safety,
    safetyNotes,
    interrupted,
    complete,
  };

  // Delivery report from the PM, based only on the recorded facts.
  let report: string;
  try {
    const facts = JSON.stringify(
      {
        goal: plan.goal,
        tasks: outcomes.map((o) => ({ role: ROLE_TITLES[o.role] ?? o.role, title: o.title, status: o.status, summary: clip(o.summary, 300) })),
        filesChanged: base.filesWritten,
        commandsRun: base.commandsRun.slice(-15),
        safetyVerdict: safety,
        safetyNotes: clip(safetyNotes, 1500),
        stoppedByUser: interrupted,
        overallComplete: complete,
        plannerRisks: plan.risks,
        ...(blockedWrites.length ? { writesRefusedOutsideScope: blockedWrites.slice(0, 10) } : {}),
      },
      null,
      2,
    );
    report = (await ask(opts.llm, REPORT_SYSTEM, `<facts>\n${facts}\n</facts>`, 900)) || fallbackReport(base);
  } catch {
    report = fallbackReport(base);
  }

  console.log(pc.bold("\n📦 Delivery report"));
  console.log(report);
  if (safety === "FAIL") console.log(pc.red("\n⚠ The Safety Reviewer still reports blockers. Review the findings above before using these changes."));
  if (safety === "UNKNOWN") console.log(pc.yellow("\n⚠ The Safety Reviewer gave no clear verdict. Treat the changes as unreviewed."));

  return { ...base, report };
}
