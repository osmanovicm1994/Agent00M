// src/orchestra/orchestra-master.ts
//
// The supervisor. Takes a task graph (who does what, which paths they own, what must finish first), validates it,
// then runs independent tasks concurrently, each as its own agent loop, with:
//  - scoped write leases (WorkspaceLocks) so two agents never edit the same files,
//  - a Blackboard so they see each other's progress and published contracts,
//  - dependency ordering ("contract first, then parallel"): e.g. db publishes the schema, then api and web start.
//
// It does not know how an agent runs. A `TaskRunner` is injected (in production it wraps Executor.run with the
// write guard, the debug interceptor and the digest hook), which keeps this file pure and testable.

import { Blackboard } from "./blackboard";
import { WorkspaceLocks, scopesOverlap } from "./workspace-locks";

export interface OrchTask {
  id: string;
  agent: string;
  title: string;
  instructions: string;
  /** Paths this task may write (dir prefixes like "apps/api/" or exact files). Empty = read-only task. */
  scope: string[];
  /** Task ids that must be done before this one starts. */
  dependsOn: string[];
  /** Contract names this task must read before starting (published by its dependencies). */
  readsContracts?: string[];
}

export type TaskStatus = "done" | "incomplete" | "failed" | "interrupted" | "skipped";

export interface TaskOutcome {
  status: TaskStatus;
  summary: string;
  filesWritten: string[];
  commandsRun: string[];
  /** Optional contract the task publishes for the others. */
  contract?: { name: string; body: string };
}

export interface TaskContext {
  task: OrchTask;
  board: Blackboard;
  locks: WorkspaceLocks;
  signal: AbortSignal;
  /** Text block with the contracts this task depends on. */
  contractsText: string;
  /** New updates from the other agents since the last call. Call it between steps. */
  digest(): string;
}

export type TaskRunner = (task: OrchTask, ctx: TaskContext) => Promise<TaskOutcome>;

export interface OrchestraOptions {
  runner: TaskRunner;
  board?: Blackboard;
  locks: WorkspaceLocks;
  /** How many agent loops may run at once. Default 2. */
  concurrency?: number;
  /** Stop starting new tasks after the first failure. Default false: independent branches continue. */
  failFast?: boolean;
  log?(line: string): void;
}

export interface OrchestraResult {
  outcomes: Record<string, TaskOutcome>;
  order: string[];
  ok: boolean;
  /** Writes refused by the locks, for the report. */
  denials: Array<{ owner: string; path: string }>;
}

/** Ids reachable through dependsOn (transitive). */
function ancestors(id: string, byId: Map<string, OrchTask>, seen = new Set<string>()): Set<string> {
  for (const d of byId.get(id)?.dependsOn ?? []) {
    if (!seen.has(d)) {
      seen.add(d);
      ancestors(d, byId, seen);
    }
  }
  return seen;
}

export class OrchestraMaster {
  readonly board: Blackboard;
  private readonly concurrency: number;

  constructor(private readonly opts: OrchestraOptions) {
    this.board = opts.board ?? new Blackboard();
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
  }

  /** Returns a list of problems; empty means the graph is safe to run. */
  static validate(tasks: OrchTask[]): string[] {
    const problems: string[] = [];
    const byId = new Map<string, OrchTask>();
    for (const t of tasks) {
      if (byId.has(t.id)) problems.push(`duplicate task id "${t.id}"`);
      byId.set(t.id, t);
    }
    for (const t of tasks) {
      for (const d of t.dependsOn) {
        if (!byId.has(d)) problems.push(`task "${t.id}" depends on unknown task "${d}"`);
        if (d === t.id) problems.push(`task "${t.id}" depends on itself`);
      }
    }
    if (problems.length) return problems;

    // cycles: a task that is its own ancestor
    for (const t of tasks) if (ancestors(t.id, byId).has(t.id)) problems.push(`dependency cycle through "${t.id}"`);
    if (problems.length) return problems;

    // Two tasks that can run at the same time must not own overlapping paths.
    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        const a = tasks[i];
        const b = tasks[j];
        const ordered = ancestors(a.id, byId).has(b.id) || ancestors(b.id, byId).has(a.id);
        if (ordered) continue;
        for (const sa of a.scope) for (const sb of b.scope) {
          if (scopesOverlap(sa, sb)) problems.push(`tasks "${a.id}" and "${b.id}" can run in parallel but both own "${sa}" / "${sb}"; split the scope or add dependsOn`);
        }
      }
    }
    return problems;
  }

  async run(tasks: OrchTask[]): Promise<OrchestraResult> {
    const problems = OrchestraMaster.validate(tasks);
    if (problems.length) throw new Error("Invalid orchestra plan:\n- " + problems.join("\n- "));

    const log = this.opts.log ?? (() => {});
    const outcomes: Record<string, TaskOutcome> = {};
    const order: string[] = [];
    const pending = new Map(tasks.map((t) => [t.id, t]));
    const running = new Map<string, Promise<string>>();
    const abort = new AbortController();
    let stopping = false;

    const finish = (id: string, outcome: TaskOutcome) => {
      outcomes[id] = outcome;
      order.push(id);
      this.opts.locks.release(id);
      if (outcome.contract) this.board.setContract(outcome.contract.name, id, outcome.contract.body);
      this.board.post(id, outcome.status === "done" ? "task-done" : "task-failed", `${outcome.status}: ${outcome.summary.slice(0, 200)}`);
    };

    const start = (task: OrchTask) => {
      pending.delete(task.id);
      this.board.post(task.id, "task-start", task.title);
      log(`orchestra: start ${task.id} (${task.agent}) scope=${task.scope.join(",") || "read-only"}`);
      const ctx: TaskContext = {
        task,
        board: this.board,
        locks: this.opts.locks,
        signal: abort.signal,
        contractsText: this.board.contractsText(task.readsContracts ?? []),
        digest: () => this.board.digestFor(task.id),
      };
      const p = (async () => {
        try {
          finish(task.id, await this.opts.runner(task, ctx));
        } catch (err) {
          finish(task.id, { status: "failed", summary: `runner crashed: ${(err as Error).message}`, filesWritten: [], commandsRun: [] });
        }
        return task.id;
      })();
      running.set(task.id, p);
    };

    while (pending.size > 0 || running.size > 0) {
      if (!stopping) {
        for (const task of [...pending.values()]) {
          if (running.size >= this.concurrency) break;
          const deps = task.dependsOn.map((d) => outcomes[d]);
          if (deps.some((o) => o === undefined)) {
            // A dependency that is still pending/running: wait. One that failed: skip this task.
            continue;
          }
          if (deps.some((o) => o.status !== "done")) {
            pending.delete(task.id);
            outcomes[task.id] = { status: "skipped", summary: "a dependency did not finish", filesWritten: [], commandsRun: [] };
            order.push(task.id);
            this.board.post(task.id, "task-failed", "skipped: a dependency did not finish");
            continue;
          }
          const lease = this.opts.locks.tryAcquire(task.id, task.scope);
          if (!lease.ok) continue; // a running task owns part of this scope: try again when it ends
          start(task);
        }
      }

      if (running.size === 0) {
        // Nothing running and nothing startable: whatever is left is blocked. Mark it and leave.
        for (const t of pending.values()) {
          outcomes[t.id] = { status: "skipped", summary: "blocked (dependency or scope never became free)", filesWritten: [], commandsRun: [] };
          order.push(t.id);
        }
        pending.clear();
        break;
      }

      const doneId = await Promise.race(running.values());
      running.delete(doneId);
      if (this.opts.failFast && outcomes[doneId].status !== "done" && !stopping) {
        stopping = true;
        abort.abort();
        for (const t of pending.values()) {
          outcomes[t.id] = { status: "skipped", summary: "stopped after a failure (failFast)", filesWritten: [], commandsRun: [] };
          order.push(t.id);
        }
        pending.clear();
      }
    }

    return {
      outcomes,
      order,
      ok: Object.values(outcomes).every((o) => o.status === "done"),
      denials: this.opts.locks.denials(),
    };
  }
}
