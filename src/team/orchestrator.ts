// src/team/orchestrator.ts
//
// Team mode: one request goes through a small "company" workflow instead of a single agent.
//
//   request ─► Project Manager (plan) ─► you approve ─► plan saved as task files (tasks/*.md + tasks/tasks.json)
//           ─► for each task: UX spec / engineer (Executor loop), state recorded after every task
//           ─► Safety Reviewer (read-only) ─► one fix round if it finds blockers ─► PM delivery report
//
// Saved tasks (see task-store.ts): the plan survives a token limit, a crash or Ctrl+C. `resume` loads the saved plan and
// runs only the tasks that are not finished; `planOnly` writes the task files and stops, so you can edit them first.
// Each engineer is given its task file as it is on disk, so hand edits count.
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
// another exactly as before. A resume always runs the remaining tasks one after another.

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
import { describeStarter, findStarterContent, starterFixTask, type ScaffoldFinding } from "./scaffold-gate";
import { findSpecFiles, specWarnings } from "./spec-files";
import { GitFlow, type GitLevel, type GitSummary } from "./git-flow";
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
import {
  describeManifest,
  hasOpenTasks,
  loadTaskManifest,
  readTaskDoc,
  setGit,
  setSafety,
  tasksDirName,
  updateTask,
  writeTaskPlan,
  type StoredStatus,
  type TaskManifest,
} from "./task-store";

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
  /** The local git branches of this run (see git-flow.ts). Absent when git was not used. */
  git?: GitSummary;
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
  /** Continue the plan saved in the tasks folder instead of planning again. Only unfinished tasks run. */
  resume?: boolean;
  /** Plan and write the task files, then stop without building anything. Edit the files, then resume. */
  planOnly?: boolean;
}

const MAX_SUMMARY = 700;

// How many tasks one plan may have. A whole application needs 6 to 9 (the planner prompt says so); AGENT_TEAM_MAX_TASKS changes the cap.
const MAX_PLAN_TASKS = Math.min(12, Math.max(1, Math.floor(Number(process.env.AGENT_TEAM_MAX_TASKS)) || 9));

const UI_WORDS = /\b(ui|user interface|front-?end|pages?|screens?|dashboard|login|web ?app|website|wizard)\b/i;

/** The plan builds something a person opens in a browser (a UX or frontend task, or the goal says so). */
export function wantsInterface(plan: PmPlan): boolean {
  return plan.tasks.some((t) => t.role === "ux" || t.role === "design") || UI_WORDS.test(plan.goal);
}

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

// `mission` is the original request of this job when the current message is a follow-up of it (see TaskManifest.mission);
// `prior` is the saved plan with its open tasks. Both let the planner finish the job instead of starting a new, smaller one.
async function planWithPm(opts: TeamOptions, mission?: string, prior?: TaskManifest | null, specBlock = ""): Promise<PmPlan> {
  const followUp = Boolean(mission && mission.trim() !== opts.task.trim());
  const user =
    (followUp ? `<mission>\n${clip(mission as string, 6000)}\n</mission>\n\n` : "") +
    `<request>\n${opts.task}\n</request>\n\n` +
    (followUp && prior ? `<previous_plan_state>\n${describeManifest(prior)}\n</previous_plan_state>\n\n` : "") +
    `<project_tree>\n${projectListing(opts.workspaceRoot)}\n</project_tree>` +
    (opts.context ? `\n\n<extra_context>\n${clip(opts.context, 5000)}\n</extra_context>` : "") +
    (specBlock ? `\n\n<referenced_files>\n${specBlock}\n</referenced_files>` : "");
  const system = PM_SYSTEM + (opts.parallel ? PM_PARALLEL_ADDENDUM : "") + PM_KNOWLEDGE;

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await lead(opts, system, attempt === 0 ? user : `${user}\n\nYour previous answer was not valid (${lastErr}). Reply with ONLY the JSON object.`, 2500, true);
    try {
      const plan = parsePlan(raw);
      // Keep only roles that exist; unknown ones fall back to the general engineer.
      plan.tasks = plan.tasks.slice(0, MAX_PLAN_TASKS).map((t) => ({
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
    // Planned, not proven: a box is ticked only by a check that ran (see the delivery report).
    t.acceptance.forEach((a) => console.log(pc.dim(`       ☐ ${a}`)));
  });
  if (plan.tasks.some((t) => t.acceptance.length)) console.log(pc.dim("  (☐ = planned acceptance check, not yet run)"));
  if (plan.assumptions.length) console.log(pc.dim(`  Assumptions: ${plan.assumptions.join("; ")}`));
  if (plan.risks.length) console.log(pc.yellow(`  Risks: ${plan.risks.join("; ")}`));
  if (plan.questions.length) console.log(pc.yellow(`  Open questions: ${plan.questions.join("; ")}`));
  console.log(pc.dim("  🛡  A Safety Reviewer checks the result at the end.\n"));

  // The same plan as plain text for the dashboard.
  const lines = [`Project Manager: ${plan.goal}`];
  plan.tasks.forEach((t, i) => {
    lines.push(`${i + 1}. [${ROLE_TITLES[t.role] ?? t.role}] ${t.title}`);
    t.acceptance.forEach((a) => lines.push(`     ☐ ${a}`));
  });
  if (plan.tasks.some((t) => t.acceptance.length)) lines.push("(☐ = planned acceptance check, not yet run)");
  if (plan.assumptions.length) lines.push(`Assumptions: ${plan.assumptions.join("; ")}`);
  if (plan.risks.length) lines.push(`Risks: ${plan.risks.join("; ")}`);
  if (plan.questions.length) lines.push(`Open questions: ${plan.questions.join("; ")}`);
  bus.emit("log", { text: lines.join("\n"), level: "plan" });
}

// The same discipline the Executor enforces with its write gates, stated up front so the model does not hit them blindly.
const FILE_RULE =
  "File rule: before you write a file, check whether it exists (list_dir, find_files). If it exists, read it completely and change it in place; do not create a second copy or a new file with the same purpose. If it does not exist, make sure its folder exists and was looked at first.";

// `doc` is the task file as it is on disk (when task files are saved). It replaces the instructions and acceptance
// lines, so a hand-edited ticket is what the engineer works from.
function assignment(plan: PmPlan, index: number, notes: string[], uxSpec: string, extra?: string, doc?: string, mission?: string): string {
  const t = plan.tasks[index];
  const parts = [
    "## TEAM ASSIGNMENT",
    `Overall goal: ${plan.goal}`,
    `You are the ${ROLE_TITLES[t.role] ?? t.role}. This is task ${index + 1} of ${plan.tasks.length}: ${t.title}`,
    // The engineers used to see only the planner's one-sentence goal and their own ticket: field lists, roles and wording of the
    // original request were lost on the way. Here is the request itself; the acceptance criteria say which part is yours.
    mission ? `## ORIGINAL REQUEST (the whole job; your task is one part of it, your acceptance criteria say which part)\n${clip(mission, 4500)}` : "",
    doc
      ? `## TASK FILE (your assignment from the Project Manager; follow it, and read its Progress Log if an earlier attempt failed)\n${clip(doc, 4000)}`
      : t.instructions
        ? `Instructions: ${t.instructions}`
        : "",
    !doc && t.acceptance.length ? `Acceptance criteria (you are done only when these hold, and you have checked them):\n${t.acceptance.map((a) => `- ${a}`).join("\n")}` : "",
    plan.risks.length ? `Risks to avoid: ${plan.risks.join("; ")}` : "",
    plan.assumptions.length ? `Assumptions made by the planner (verify them against the real files): ${plan.assumptions.join("; ")}` : "",
    FILE_RULE,
    notes.length ? `What the team has done so far:\n${notes.join("\n")}` : "",
    uxSpec ? `## UX SPEC (build to this)\n${clip(uxSpec, 4500)}` : "",
    extra ? clip(extra, 12000) : "",
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

function printGit(g: GitSummary): void {
  const lines = [
    `Git: all work of this run is on branch ${g.feature} (your branch ${g.base} is untouched), ${g.commits.length} commit(s).`,
    ...(g.openBranches.length ? [`Not merged, kept for you: ${g.openBranches.join("; ")}`] : []),
    ...(g.stoppedBecause ? [`The git workflow stopped early: ${g.stoppedBecause}`] : []),
    "Review, then merge when you are happy:",
    ...g.commands.map((c) => `  ${c}`),
  ];
  console.log(pc.bold("\n⎇ Git"));
  lines.forEach((l) => console.log(pc.dim(l)));
  bus.emit("log", { text: lines.join("\n"), level: "info" });
}

const emptyPlan = (): PmPlan => ({ goal: "", assumptions: [], risks: [], questions: [], tasks: [] });

/** A result for runs that build nothing (plan only, nothing to resume). `ok` decides how the caller words it. */
function noWork(plan: PmPlan, report: string, ok: boolean): TeamResult {
  return { plan, tasks: [], filesWritten: [], commandsRun: [], safety: "NOT_RUN", safetyNotes: "", interrupted: false, complete: ok, report };
}

const toStored = (s: TaskStatus): StoredStatus => (s === "done" ? "COMPLETED" : s === "skipped" ? "SKIPPED" : "INCOMPLETE");

/**
 * Runs the whole workflow. Returns null when the user declined the plan or no plan could be made
 * (the caller then falls back to the normal single-agent path). Resume and plan-only runs never return null once
 * they have started: there is nothing for a single agent to fall back to.
 */
export async function runTeam(opts: TeamOptions): Promise<TeamResult | null> {
  const resuming = Boolean(opts.resume);
  const parallelOpts = resuming ? undefined : opts.parallel;
  let plan: PmPlan;
  let manifest: TaskManifest | undefined;
  // The original request of this job (see TaskManifest.mission). A follow-up message never replaces it.
  let missionText = opts.task;
  // Files the request names (their content, or a warning that nobody looked at them), and the context every role gets.
  let specBlock = "";
  let specNotes: string[] = [];
  const loadSpecs = (text: string): void => {
    const sf = findSpecFiles(opts.workspaceRoot, text);
    specBlock = sf.block;
    specNotes = specWarnings(sf);
  };
  const roleContext = (): string => [opts.context ?? "", specBlock].filter(Boolean).join("\n\n");

  if (resuming) {
    const saved = loadTaskManifest(opts.workspaceRoot);
    if (!saved || !hasOpenTasks(saved)) {
      const msg = saved
        ? "All saved tasks are already finished. Nothing to resume."
        : `No saved tasks found in ${tasksDirName()}/. Plan first with /tasks plan <task> or /team <task>.`;
      console.log(pc.yellow(`\n${msg}\n`));
      return noWork(emptyPlan(), msg, true);
    }
    manifest = saved;
    plan = saved.plan;
    missionText = saved.mission ?? saved.goal;
    loadSpecs(missionText);
    console.log(pc.bold(`\n🏢 Team mode: resuming the saved plan`));
    console.log(describeManifest(saved));
    if (opts.parallel) console.log(pc.dim("  (a resume runs the remaining tasks one after another)"));
    bus.emit("log", { text: `Team mode: resuming the saved plan\n${describeManifest(saved)}`, level: "step" });
    if (opts.approvePlan) {
      const ok = await prompts({ type: "confirm", name: "ok", message: "Run the unfinished tasks?", initial: true });
      if (ok.ok === false || ok.ok === undefined) {
        console.log(pc.dim("Resume cancelled."));
        return noWork(plan, "Resume cancelled. The saved tasks are unchanged.", true);
      }
    }
  } else {
    console.log(pc.bold(`\n🏢 Team mode: Project Manager is planning${opts.think ? " (Gemini)" : ""} …`));
    bus.emit("log", { text: "Team mode: the Project Manager is planning…", level: "step" });

    // A message that arrives while the saved plan still has open tasks belongs to the same job ("next step", "continue", a fix):
    // the planner gets the original request next to it, so the job is finished instead of replaced by a smaller one.
    const savedPlan = loadTaskManifest(opts.workspaceRoot);
    const priorOpen = savedPlan && hasOpenTasks(savedPlan) ? savedPlan : null;
    if (priorOpen) missionText = priorOpen.mission ?? priorOpen.goal;

    loadSpecs(`${missionText}\n${opts.task}`);
    if (specNotes.length) {
      console.log(pc.yellow(`  Reference files: ${specNotes.join("; ")}`));
      bus.emit("log", { text: `Reference files: ${specNotes.join("; ")}`, level: "warn" });
    }

    try {
      plan = await planWithPm(opts, missionText, priorOpen, specBlock);
      // The warnings travel with the plan (task files, delivery report), so nobody later assumes the picture was matched.
      for (const n of specNotes) plan.assumptions.push(`Reference files ${n}`);
    } catch (err: any) {
      if (opts.planOnly) {
        console.log(pc.yellow(`⚠ Team planning failed: ${err?.message ?? err}`));
        return noWork(emptyPlan(), `Planning failed: ${err?.message ?? err}`, false);
      }
      console.log(pc.yellow(`⚠ Team planning failed: ${err?.message ?? err}\n  Falling back to a single agent.`));
      return null;
    }

    printPlan(plan, Boolean(opts.parallel));

    if (plan.questions.length && opts.approvePlan) {
      console.log(pc.yellow("The planner has open questions. Answer them in your next message if they matter; the team can still start now.\n"));
    }
    if (opts.approvePlan) {
      const ok = await prompts({
        type: "confirm",
        name: "ok",
        message: opts.planOnly ? `Save this plan as task files in ${tasksDirName()}/?` : "Start this plan?",
        initial: true,
      });
      if (ok.ok === false || ok.ok === undefined) {
        console.log(pc.dim(opts.planOnly ? "Plan not saved." : "Plan not started."));
        return opts.planOnly ? noWork(plan, "Plan not saved.", true) : null;
      }
    }

    // Save the plan as task files before any work starts: this is what makes a resume possible.
    let saveError = "";
    try {
      const saved = writeTaskPlan(opts.workspaceRoot, plan, missionText);
      manifest = saved.manifest;
      if (saved.archivedTo) console.log(pc.dim(`  Earlier saved tasks were moved to ${saved.archivedTo}/`));
      console.log(pc.green(`📁 ${plan.tasks.length} task file(s) saved in ${tasksDirName()}/ (state in ${tasksDirName()}/tasks.json).`));
      bus.emit("log", { text: `Task files saved in ${tasksDirName()}/`, level: "step" });
    } catch (err: any) {
      saveError = String(err?.message ?? err);
      console.log(pc.yellow(`⚠ Could not save the task files (${saveError}). The team continues without them, so this run cannot be resumed.`));
    }

    if (opts.planOnly) {
      if (!manifest) return noWork(plan, `The plan could not be saved: ${saveError}`, false);
      const report = [
        `**Result:** The plan is saved as ${plan.tasks.length} task file(s) in ${tasksDirName()}/. Nothing has been built yet.`,
        `**What changed:** ${manifest.tasks.map((t) => `\n- ${tasksDirName()}/${t.file}`).join("")}\n- ${tasksDirName()}/tasks.json`,
        "**Checked:** no commands were run.",
        "**Open items:** all tasks are PENDING.",
        "**Next step:** edit the task files if you want to change a task, then run /tasks resume.",
      ].join("\n");
      console.log(pc.bold("\n📦 Plan saved"));
      console.log(report);
      return noWork(plan, report, true);
    }
  }

  // Local git: a feature branch for the job and one branch per task (see git-flow.ts). Never stops the work.
  const gitLog = (line: string, level: GitLevel = "info"): void => {
    console.log(level === "warn" ? pc.yellow(`⚠ git: ${line}`) : pc.dim(`⎇ ${line}`));
    bus.emit("log", { text: `git: ${line}`, level: level === "warn" ? "warn" : level === "step" ? "step" : "info" });
  };
  const gitFlow: GitFlow | null = await GitFlow.start({
    root: opts.workspaceRoot,
    goal: plan.goal || missionText,
    resume: resuming ? manifest?.git : undefined,
    confirm: opts.approvePlan
      ? async (question: string) => {
          const a = await prompts({ type: "confirm", name: "ok", message: question, initial: true });
          return a.ok === true;
        }
      : undefined,
    log: gitLog,
    tasksDir: tasksDirName(),
  });
  if (gitFlow && manifest) {
    try {
      const { base, feature } = gitFlow.info();
      setGit(opts.workspaceRoot, manifest, { base, feature });
    } catch {
      // the task files are a convenience
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

  // A resume starts from what the finished tasks left behind.
  if (resuming && manifest) {
    manifest.tasks.forEach((st, i) => {
      if (st.status !== "COMPLETED" && st.status !== "SKIPPED") return; // IN_PROGRESS and INCOMPLETE run again
      handled.add(i);
      outcomes.push({ role: st.role, title: st.title, status: st.status === "COMPLETED" ? "done" : "skipped", summary: st.summary ?? "" });
      st.filesWritten.forEach((f) => files.add(f));
      commands.push(...st.commandsRun);
      if (st.note) notes.push(st.note);
      if (st.role !== "qa" && st.status === "COMPLETED") lastEngineer = st.role;
    });
    uxSpec = manifest.uxSpec ?? "";
  }

  // Records the state of a task in the task files. A failure to write them never stops the work.
  let saveWarned = false;
  const record = (
    i: number,
    status: StoredStatus,
    extra: { summary?: string; note?: string; filesWritten?: string[]; commandsRun?: string[] } = {},
  ): void => {
    const m = manifest;
    if (!m) return;
    try {
      updateTask(opts.workspaceRoot, m, i, { status, ...extra });
    } catch (err: any) {
      if (!saveWarned) {
        saveWarned = true;
        console.log(pc.yellow(`⚠ Could not update the task files: ${err?.message ?? err}`));
      }
    }
  };

  // One task, one after another. Also runs the UX tasks in parallel mode.
  const runTask = async (i: number): Promise<void> => {
    handled.add(i);
    const t = plan.tasks[i];
    const title = ROLE_TITLES[t.role] ?? t.role;
    console.log(pc.bold(`\n━━ [${i + 1}/${plan.tasks.length}] ${title}: ${t.title}`));
    bus.emit("log", { text: `[${i + 1}/${plan.tasks.length}] ${title}: ${t.title}`, level: "step" });
    record(i, "IN_PROGRESS");

    if (t.role === "ux") {
      try {
        const user =
          `<goal>${plan.goal}</goal>\n<task>${t.title}\n${t.instructions}</task>\n` +
          `<project_tree>\n${projectListing(opts.workspaceRoot)}\n</project_tree>` +
          (roleContext() ? `\n\n<reference_and_context>\n${clip(roleContext(), 14000)}\n</reference_and_context>` : "");
        uxSpec = await lead(opts, UX_SYSTEM, user, 3000);
        console.log(pc.dim(clip(uxSpec, 1200)));
        const note = `- UX Designer wrote a build spec for: ${t.title}`;
        notes.push(note);
        outcomes.push({ role: t.role, title: t.title, status: "done", summary: "UX spec written" });
        if (manifest) manifest.uxSpec = uxSpec; // saved together with the status below
        record(i, "COMPLETED", { summary: clip(uxSpec, 1500), note });
      } catch (err: any) {
        console.log(pc.yellow(`⚠ UX spec failed: ${err?.message ?? err}`));
        outcomes.push({ role: t.role, title: t.title, status: "incomplete", summary: "UX spec could not be written" });
        record(i, "INCOMPLETE", { summary: `UX spec failed: ${String(err?.message ?? err)}` });
      }
      return;
    }

    const agent = getAgent(t.role);
    if (!agent) {
      console.log(pc.yellow(`⚠ No agent for role '${t.role}', skipped.`));
      outcomes.push({ role: t.role, title: t.title, status: "skipped", summary: "no such agent" });
      record(i, "SKIPPED", { summary: "no such agent" });
      return;
    }

    if (t.role !== "qa") lastEngineer = t.role;
    gitFlow?.beginTask(i + 1, t.role, t.title);
    // The task file as it is on disk now: a hand-edited ticket is what the engineer follows.
    const doc = manifest ? readTaskDoc(opts.workspaceRoot, manifest, i) : "";
    // The task text also steers which standards the Executor loads (keywords such as "NextAuth" or "wizard"), so the planner's
    // instructions are always part of it; the task file below may add to them or carry hand edits.
    const taskText = `${t.title}${t.instructions ? `\n${clip(t.instructions, 1500)}` : ""}${doc ? "\n(The TASK FILE below is the full, current version of these instructions.)" : ""}`;
    let res = await opts.executor.run(agent, taskText, assignment(plan, i, notes, uxSpec, roleContext(), doc, missionText));
    // A builder that ended without writing a file delivered nothing: one more attempt, stated plainly.
    if (!res.interrupted && !isStopped(res) && lacksEvidence(t.role, res.filesWritten)) {
      console.log(pc.yellow("⚠ This task wrote no files. One more attempt with a stricter instruction."));
      const again = await opts.executor.run(agent, taskText, `${assignment(plan, i, notes, uxSpec, roleContext(), doc, missionText)}\n\n${NO_FILES_NUDGE}`);
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
    gitFlow?.endTask(i + 1, t.role, t.title, status, res.filesWritten);
    const note =
      `- ${title} (${status}): ${t.title}. Files: ${res.filesWritten.join(", ") || "none"}. ${clip(res.finalMessage, 300)}` +
      (t.contract ? `\n  Contract: ${clip(t.contract, 500)}` : "");
    notes.push(note);
    record(i, toStored(status), { summary, note, filesWritten: res.filesWritten, commandsRun: res.commandsRun });
    if (res.interrupted) interrupted = true;
  };

  // Parallel mode: UX first (its spec goes into every task), then the engineer tasks side by side.
  if (parallelOpts) {
    for (let i = 0; i < plan.tasks.length && !interrupted; i++) if (plan.tasks[i].role === "ux") await runTask(i);

    const graph = planToOrchTasks(
      plan,
      uxSpec,
      [`## ORIGINAL REQUEST (the whole job; your task is one part of it)\n${clip(missionText, 4500)}`, roleContext()].filter(Boolean).join("\n\n"),
    );
    if (interrupted) {
      // nothing more to do
    } else if (graph.problems.length > 0) {
      console.log(pc.yellow(`\n⚠ This plan cannot run in parallel, so the tasks run one after another:`));
      graph.problems.forEach((p) => console.log(pc.yellow(`   - ${p}`)));
    } else {
      const concurrency = Math.max(1, parallelOpts.concurrency ?? 2);
      console.log(pc.bold(`\n🎼 Orchestra: ${graph.tasks.length} tasks, up to ${concurrency} at the same time`));
      // Mark them all as started; a task that never reports back stays IN_PROGRESS and runs again on a resume.
      for (const gt of graph.tasks) {
        const idx = graph.indexOf.get(gt.id);
        if (idx !== undefined) record(idx, "IN_PROGRESS");
      }
      const signal = parallelOpts.beginRun?.();
      const master = new OrchestraMaster({
        runner: parallelOpts.runner,
        locks: parallelOpts.locks,
        board: parallelOpts.board,
        concurrency,
        signal,
        log: (line) => console.log(pc.dim(line)),
      });
      let res: Awaited<ReturnType<OrchestraMaster["run"]>>;
      try {
        res = await master.run(graph.tasks);
      } finally {
        parallelOpts.endRun?.();
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
        const note =
          `- ${ROLE_TITLES[t.role] ?? t.role} (${status}): ${t.title}. Files: ${o.filesWritten.join(", ") || "none"}.` +
          (t.contract ? `\n  Contract: ${clip(t.contract, 500)}` : "");
        notes.push(note);
        gitFlow?.commitFiles(t.role, t.title, status, o.filesWritten);
        record(idx, toStored(status), { summary: clip(o.summary, MAX_SUMMARY), note, filesWritten: o.filesWritten, commandsRun: o.commandsRun });
        if (t.role !== "qa") lastEngineer = t.role;
        if (o.status === "interrupted") interrupted = true;
      }
      gitFlow?.commitAll("chore: save remaining changes from the parallel run");
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

  // The generated starter page is the first thing the person opens. When every task says "done" but it is still in place, one repair run
  // by the frontend engineer replaces it; when it still stands afterwards (or other tasks did not finish), the run is not complete.
  let starterLeft: ScaffoldFinding[] = [];
  if (!interrupted && wantsInterface(plan)) {
    starterLeft = findStarterContent(opts.workspaceRoot).filter((f) => f.blocking);
    const allDone = outcomes.length > 0 && outcomes.every((o) => o.status === "done");
    const fixAgent = getAgent("design");
    if (starterLeft.length > 0 && allDone && fixAgent) {
      console.log(pc.yellow(`\n⚠ The generated starter page is still in place (${describeStarter(starterLeft)}). One repair run replaces it.`));
      bus.emit("log", { text: `The generated starter page is still in place: ${describeStarter(starterLeft)}. One repair run follows.`, level: "warn" });
      const fixTitle = "Replace the generated starter page";
      const fixRes = await opts.executor.run(
        fixAgent,
        fixTitle,
        `${starterFixTask(starterLeft)}\n\n## ORIGINAL REQUEST\n${clip(missionText, 4500)}\n\n${notes.length ? `What the team has done so far:\n${notes.join("\n")}\n\n` : ""}${FILE_RULE}`,
      );
      fixRes.filesWritten.forEach((f) => files.add(f));
      commands.push(...fixRes.commandsRun);
      gitFlow?.commitAll("fix(ui): replace the generated starter page");
      starterLeft = findStarterContent(opts.workspaceRoot).filter((f) => f.blocking);
      const fixStatus: TaskStatus = fixRes.interrupted ? "interrupted" : starterLeft.length > 0 || isStopped(fixRes) ? "incomplete" : "done";
      outcomes.push({ role: "design", title: fixTitle, status: fixStatus, summary: clip(fixRes.finalMessage, MAX_SUMMARY) });
      if (fixRes.interrupted) interrupted = true;
    }
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
        gitFlow?.commitAll("fix(safety): fix the blockers found by the safety review");
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

  if (manifest && safety !== "NOT_RUN") {
    try {
      setSafety(opts.workspaceRoot, manifest, safety);
    } catch {
      // the task files are a convenience; a failed write here changes nothing about the result
    }
  }

  const gitSummary = gitFlow?.finish();
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
    ...(gitSummary ? { git: gitSummary } : {}),
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
        ...(manifest && hasOpenTasks(manifest) ? { resumeWith: "/tasks resume" } : {}),
        ...(starterLeft.length ? { starterPageStillInPlace: true, starterFiles: starterLeft.map((f) => f.file) } : {}),
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
  if (gitSummary) printGit(gitSummary);
  if (safety === "FAIL") console.log(pc.red("\n⚠ The Safety Reviewer still reports blockers. Review the findings above before using these changes."));
  if (safety === "UNKNOWN") console.log(pc.yellow("\n⚠ The Safety Reviewer gave no clear verdict. Treat the changes as unreviewed."));
  if (manifest && !complete && hasOpenTasks(manifest)) console.log(pc.dim(`\nTask state is saved in ${tasksDirName()}/. Continue unfinished work with /tasks resume (or run --resume).`));

  return { ...base, report };
}
