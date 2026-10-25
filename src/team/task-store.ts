// src/team/task-store.ts
//
// File-backed task queue for team mode.
//
// The Project Manager's plan is saved in the target project as
//
//   tasks/tasks.json            the manifest: the plan, plus the state of every task (the source of truth)
//   tasks/01-db-schema.md       one ticket per task: the assignment the agent works from
//   tasks/02-api-users.md       ...
//
// A token limit, a crash or Ctrl+C no longer loses the plan: `/tasks resume` loads the manifest and runs only the
// tasks that are not finished. The **Status:** line in each ticket mirrors the manifest for humans; if they ever
// differ, the manifest wins. The rest of a ticket may be edited by hand before the task runs: the agent is given the
// ticket as it is on disk.
//
// Pure file handling: no model calls. Folder name: AGENT_TASKS_DIR (default "tasks", relative to the project).

import * as fs from "fs";
import * as path from "path";
import { pmPlanSchema, ROLE_TITLES, type PmPlan } from "./roles";

export type StoredStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "INCOMPLETE" | "SKIPPED";

export interface StoredTask {
  /** 1-based, the same number the plan prints. */
  n: number;
  /** Ticket file name inside the tasks folder. */
  file: string;
  role: string;
  title: string;
  dependsOn: number[];
  status: StoredStatus;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  /** What the agent reported at the end of its last attempt. */
  summary?: string;
  /** The one-paragraph note later tasks receive ("what the team has done so far"). */
  note?: string;
  filesWritten: string[];
  commandsRun: string[];
}

export interface TaskManifest {
  version: 1;
  goal: string;
  createdAt: string;
  updatedAt: string;
  /**
   * The ORIGINAL request this job is about, as the person wrote it. A later message in the same job ("next step", "continue", a
   * fix) is a follow-up, not a new job: the Project Manager plans the rest of the mission and never loses the first request.
   */
  mission?: string;
  /** The full plan, so a resume needs no new planning call. */
  plan: PmPlan;
  /** The UX Designer's build spec, kept so the frontend task still gets it after a resume. */
  uxSpec?: string;
  /** Verdict of the last Safety Review, when one ran. */
  safety?: string;
  tasks: StoredTask[];
}

export interface TaskPatch {
  status: StoredStatus;
  summary?: string;
  note?: string;
  filesWritten?: string[];
  commandsRun?: string[];
}

export const MANIFEST_NAME = "tasks.json";

/** Folder name inside the project. AGENT_TASKS_DIR may change it; anything unsafe falls back to "tasks". */
export function tasksDirName(): string {
  const raw = (process.env.AGENT_TASKS_DIR ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!raw || raw.startsWith("/") || !/^[\w.\-/]+$/.test(raw) || raw.split("/").some((p) => p === "" || p === "..")) return "tasks";
  return raw;
}

const dirOf = (workspace: string): string => path.join(workspace, tasksDirName());
const manifestPath = (workspace: string): string => path.join(dirOf(workspace), MANIFEST_NAME);
const stamp = (): string => new Date().toISOString();

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "task";

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)} …` : t;
}

/** Task numbers from numbers or strings such as "2", "t2", "task 2". */
function parseDeps(raw: ReadonlyArray<number | string>, self: number, total: number): number[] {
  const out: number[] = [];
  for (const r of raw) {
    const n = typeof r === "number" ? r : Number(/(\d+)/.exec(String(r))?.[1]);
    if (Number.isInteger(n) && n >= 1 && n <= total && n !== self && !out.includes(n)) out.push(n);
  }
  return out;
}

function ticketName(index: number, role: string, title: string, total: number): string {
  const width = Math.max(2, String(total).length);
  return `${String(index + 1).padStart(width, "0")}-${role}-${slug(title)}.md`;
}

// ---------- ticket text ----------

export function renderTicket(plan: PmPlan, index: number, deps: number[], status: StoredStatus): string {
  const t = plan.tasks[index];
  const list = (items: string[], box: boolean): string => (items.length ? items.map((x) => (box ? `- [ ] ${x}` : `- ${x}`)).join("\n") : "- (none given)");
  const after = deps.length ? deps.map((d) => `task ${d}`).join(", ") : index === 0 ? "None" : `runs after task ${index} (plan order)`;
  const lines = [
    `# Task ${index + 1}: ${t.title}`,
    `**Assigned Agent:** ${ROLE_TITLES[t.role] ?? t.role} (\`${t.role}\`)`,
    `**Status:** ${status}`,
    `**Dependencies:** ${after}`,
    `**Order:** ${index + 1} of ${plan.tasks.length}`,
    "",
    "## Objective",
    t.title,
    "",
    "## Instructions",
    t.instructions.trim() || "(none given: use the title and the acceptance criteria)",
    "",
  ];
  if (t.scope.length) lines.push("## Write scope", list(t.scope, false), "");
  if (t.contract) lines.push("## Contract (interfaces other tasks rely on)", t.contract, "");
  lines.push("## Acceptance Criteria", list(t.acceptance, true), "", "## Goal of the whole job", plan.goal, "", "## Progress Log", "");
  return lines.join("\n");
}

// ---------- persistence ----------

export function saveManifest(workspace: string, manifest: TaskManifest): void {
  manifest.updatedAt = stamp();
  atomicWrite(manifestPath(workspace), JSON.stringify(manifest, null, 2) + "\n");
}

/** The saved manifest, or null when there is none or it cannot be trusted. */
export function loadTaskManifest(workspace: string): TaskManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(workspace), "utf8"));
    if (!raw || raw.version !== 1 || !Array.isArray(raw.tasks)) return null;
    const plan = pmPlanSchema.safeParse(raw.plan);
    if (!plan.success || plan.data.tasks.length !== raw.tasks.length) return null;
    return { ...raw, plan: plan.data } as TaskManifest;
  } catch {
    return null;
  }
}

/** Moves the previous manifest and its tickets (only those) to <tasks>/archive/<time>/. Other files are left alone. */
function archiveSaved(workspace: string): string | undefined {
  const dir = dirOf(workspace);
  const mf = manifestPath(workspace);
  if (!fs.existsSync(mf)) return undefined;
  const old = loadTaskManifest(workspace);
  const dest = path.join(dir, "archive", stamp().replace(/[:.]/g, "-"));
  fs.mkdirSync(dest, { recursive: true });
  for (const name of [MANIFEST_NAME, ...(old?.tasks.map((t) => t.file) ?? [])]) {
    const from = path.join(dir, name);
    if (fs.existsSync(from)) fs.renameSync(from, path.join(dest, name));
  }
  return path.relative(workspace, dest);
}

/** Longest mission text kept in the manifest (a pasted specification can be long). */
export const MAX_MISSION_CHARS = 12_000;

/**
 * Saves a new plan: one ticket per task plus the manifest. An earlier saved plan is archived first.
 * `mission` is the original request the plan belongs to (see TaskManifest.mission).
 */
export function writeTaskPlan(workspace: string, plan: PmPlan, mission?: string): { manifest: TaskManifest; archivedTo?: string } {
  const archivedTo = archiveSaved(workspace);
  const total = plan.tasks.length;
  const created = stamp();
  const tasks: StoredTask[] = plan.tasks.map((t, i) => ({
    n: i + 1,
    file: ticketName(i, t.role, t.title, total),
    role: t.role,
    title: t.title,
    dependsOn: parseDeps(t.dependsOn, i + 1, total),
    status: "PENDING",
    attempts: 0,
    filesWritten: [],
    commandsRun: [],
  }));
  const missionText = mission?.trim() ? mission.trim().slice(0, MAX_MISSION_CHARS) : undefined;
  const manifest: TaskManifest = { version: 1, goal: plan.goal, createdAt: created, updatedAt: created, ...(missionText ? { mission: missionText } : {}), plan, tasks };
  tasks.forEach((st, i) => atomicWrite(path.join(dirOf(workspace), st.file), renderTicket(plan, i, st.dependsOn, "PENDING")));
  saveManifest(workspace, manifest);
  return { manifest, archivedTo };
}

/** The ticket exactly as it is on disk now (hand edits included). Empty when the file is gone. */
export function readTaskDoc(workspace: string, manifest: TaskManifest, index: number): string {
  const t = manifest.tasks[index];
  if (!t) return "";
  try {
    return fs.readFileSync(path.join(dirOf(workspace), t.file), "utf8");
  } catch {
    return "";
  }
}

/** Records the state of one task: manifest first, then the ticket's Status line and Progress Log. */
export function updateTask(workspace: string, manifest: TaskManifest, index: number, patch: TaskPatch): void {
  const t = manifest.tasks[index];
  if (!t) return;
  t.status = patch.status;
  if (patch.status === "IN_PROGRESS") {
    t.attempts += 1;
    t.startedAt = stamp();
    t.finishedAt = undefined;
  } else {
    t.finishedAt = stamp();
  }
  if (patch.summary !== undefined) t.summary = patch.summary;
  if (patch.note !== undefined) t.note = patch.note;
  if (patch.filesWritten) t.filesWritten = [...new Set([...t.filesWritten, ...patch.filesWritten])];
  if (patch.commandsRun) t.commandsRun = [...t.commandsRun, ...patch.commandsRun].slice(-30);
  saveManifest(workspace, manifest);

  const file = path.join(dirOf(workspace), t.file);
  if (!fs.existsSync(file)) return;
  let text = fs.readFileSync(file, "utf8");
  text = /^\*\*Status:\*\* .*$/m.test(text) ? text.replace(/^\*\*Status:\*\* .*$/m, `**Status:** ${patch.status}`) : text;
  if (patch.status !== "IN_PROGRESS") {
    const entry = [
      `### Attempt ${t.attempts}: ${patch.status} (${stamp()})`,
      patch.summary ? `Summary: ${clip(patch.summary, 600)}` : "",
      patch.filesWritten?.length ? `Files written: ${patch.filesWritten.join(", ")}` : "",
      patch.commandsRun?.length ? `Commands run: ${clip(patch.commandsRun.join(" | "), 400)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    text = `${text.replace(/\s*$/, "")}\n\n${entry}\n`;
  }
  atomicWrite(file, text);
}

export function setSafety(workspace: string, manifest: TaskManifest, verdict: string): void {
  manifest.safety = verdict;
  saveManifest(workspace, manifest);
}

// ---------- queries ----------

/** Positions (0-based) of tasks that still have to run: everything except COMPLETED and SKIPPED. */
export function openIndexes(manifest: TaskManifest): number[] {
  return manifest.tasks.flatMap((t, i) => (t.status === "COMPLETED" || t.status === "SKIPPED" ? [] : [i]));
}

export function hasOpenTasks(manifest: TaskManifest | null | undefined): boolean {
  return !!manifest && openIndexes(manifest).length > 0;
}

const MARK: Record<StoredStatus, string> = { COMPLETED: "✔", IN_PROGRESS: "▶", INCOMPLETE: "✖", PENDING: "○", SKIPPED: "–" };

/** Plain-text status for /tasks and for a resume. */
export function describeManifest(manifest: TaskManifest): string {
  const done = manifest.tasks.filter((t) => t.status === "COMPLETED").length;
  const lines = [`Saved tasks in ${tasksDirName()}/ for: ${manifest.goal}`];
  for (const t of manifest.tasks) {
    const tries = t.attempts > 1 ? ` (${t.attempts} attempts)` : "";
    lines.push(`  ${MARK[t.status]} ${t.n}. [${ROLE_TITLES[t.role] ?? t.role}] ${t.title}: ${t.status}${tries}`);
  }
  lines.push(`  ${done} of ${manifest.tasks.length} completed${manifest.safety ? `, safety review: ${manifest.safety}` : ""}.`);
  return lines.join("\n");
}
