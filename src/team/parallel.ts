// src/team/parallel.ts
//
// Turns the Project Manager's plan into a task graph the OrchestraMaster can run in parallel, or says why it cannot.
// Pure: no model calls, no files. Used by team mode when `--parallel` is on.
//
// Rules (all of them make a wrong plan fall back to the normal one-after-another run instead of running unsafely):
//  - every engineer task needs a `scope` (the folders/files it may write);
//  - `dependsOn` holds task numbers (1-based, as printed in the plan);
//  - the usual order is added when the PM left it out: db before api, api/db before design, everything before qa;
//  - tasks that can run at the same time must not own overlapping paths (OrchestraMaster.validate checks it);
//  - UX tasks are not part of the graph: they run first, and their spec is given to every engineer task.

import { OrchestraMaster, type OrchTask } from "../orchestra/orchestra-master";
import type { PmPlan } from "./roles";

type PlanTask = PmPlan["tasks"][number];

const WRITES_CONTRACT = new Set(["db", "api"]);

/** The scope of an infra task: the whole project (normalizeScope turns it into the empty scope that matches every path). */
export const WHOLE_PROJECT = "./";

/** "apps/api/**" and "apps/api/*" mean the folder; "./src" means "src". */
export function cleanScope(raw: string): string {
  let s = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  s = s.replace(/\/?\*+(\.\w+)?$/, "/");
  return s;
}

/** Task numbers (1-based) from numbers or strings like "2", "t2", "task 2". */
export function parseDependency(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string") {
    const m = /(\d+)/.exec(raw);
    if (m) return Number(m[1]);
  }
  return null;
}

export interface ParallelPlan {
  tasks: OrchTask[];
  /** Why the plan cannot run in parallel. Empty = it can. */
  problems: string[];
  /** Task id -> index in plan.tasks. */
  indexOf: Map<string, number>;
}

/**
 * `extra` is context every engineer task should carry (the original request, the content of the files it names).
 * Sequential runs get it through the team assignment; the parallel runner only sees `instructions`, so it is added there.
 */
export function planToOrchTasks(plan: PmPlan, uxSpec = "", extra = ""): ParallelPlan {
  const problems: string[] = [];
  const indexOf = new Map<string, number>();
  const engineers: Array<{ t: PlanTask; i: number; id: string }> = [];
  plan.tasks.forEach((t, i) => {
    if (t.role === "ux") return;
    const id = `t${i + 1}`;
    indexOf.set(id, i);
    engineers.push({ t, i, id });
  });

  if (engineers.length < 2) problems.push("fewer than two engineer tasks, nothing to run side by side");

  const idOfNumber = (n: number) => (engineers.some((e) => e.i + 1 === n) ? `t${n}` : null);

  const deps = new Map<string, Set<string>>();
  for (const e of engineers) {
    const set = new Set<string>();
    for (const raw of e.t.dependsOn ?? []) {
      const n = parseDependency(raw);
      if (n === null) {
        problems.push(`task ${e.i + 1}: cannot read dependency "${String(raw)}"`);
        continue;
      }
      if (plan.tasks[n - 1]?.role === "ux") continue; // UX runs first anyway
      const id = idOfNumber(n);
      if (!id) problems.push(`task ${e.i + 1}: depends on task ${n}, which does not exist`);
      else if (id !== e.id) set.add(id);
    }
    deps.set(e.id, set);
  }

  // Default order the PM prompt already asks for: infra (skeleton, installs) first, db before api, everything before qa.
  for (const e of engineers) {
    const set = deps.get(e.id)!;
    if (e.t.role !== "infra") {
      for (const o of engineers) if (o.t.role === "infra" && o.i < e.i) set.add(o.id);
    } else {
      // An infra task owns the whole project, so it also waits for everything planned before it.
      for (const o of engineers) if (o.i < e.i) set.add(o.id);
    }
    if (e.t.role === "api") {
      for (const o of engineers) if (o.t.role === "db" && o.i < e.i) set.add(o.id);
    }
    // The interface is built against the real API and data, so a design task waits for the api and db tasks planned before it.
    if (e.t.role === "design") {
      for (const o of engineers) if ((o.t.role === "api" || o.t.role === "db") && o.i < e.i) set.add(o.id);
    }
    if (e.t.role === "qa") {
      for (const o of engineers) if (o.t.role !== "qa" && o.i < e.i) set.add(o.id);
    }
  }

  const needed = new Set<string>();
  deps.forEach((set) => set.forEach((id) => needed.add(id)));

  const tasks: OrchTask[] = engineers.map((e) => {
    // An infra task runs first and alone (every other task waits for it, see above), so it owns the whole project: it creates
    // folders the planner could not know about yet (the scaffold's own folder), and may write the root files too.
    const scope = e.t.role === "infra" ? [WHOLE_PROJECT] : (e.t.scope ?? []).map(cleanScope).filter(Boolean);
    if (scope.length === 0) problems.push(`task ${e.i + 1} (${e.t.title}) has no scope (the folders it may write)`);
    const dependsOn = [...(deps.get(e.id) ?? [])];
    const acceptance = e.t.acceptance.length ? `\nAcceptance criteria:\n${e.t.acceptance.map((a) => `- ${a}`).join("\n")}` : "";
    const ux = uxSpec ? `\n\n## UX SPEC (build to this)\n${uxSpec.slice(0, 4500)}` : "";
    const more = extra.trim() ? `\n\n${extra.trim().slice(0, 10000)}` : "";
    return {
      id: e.id,
      agent: e.t.role,
      title: e.t.title,
      instructions: `${e.t.instructions}${acceptance}${ux}${more}`.trim(),
      scope,
      dependsOn,
      readsContracts: dependsOn,
      ...(WRITES_CONTRACT.has(e.t.role) && needed.has(e.id) ? { publishes: e.id } : {}),
    };
  });

  if (problems.length === 0) problems.push(...OrchestraMaster.validate(tasks));
  return { tasks, problems, indexOf };
}
