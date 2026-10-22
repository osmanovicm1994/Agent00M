import { describe, it, expect } from "vitest";
import * as os from "os";
import { taskStatus } from "./wire";
import { OrchestraMaster, type OrchTask, type TaskRunner } from "./orchestra-master";
import { WorkspaceLocks } from "./workspace-locks";

describe("taskStatus", () => {
  it("is done only for a clean finish", () => {
    expect(taskStatus({ hitLimit: false })).toBe("done");
  });
  it("is failed when the last command still fails", () => {
    expect(taskStatus({ hitLimit: false, unresolvedFailure: true })).toBe("failed");
    expect(taskStatus({ hitLimit: true, unresolvedFailure: true })).toBe("failed");
  });
  it("is incomplete at the step limit and interrupted after Ctrl+C", () => {
    expect(taskStatus({ hitLimit: true })).toBe("incomplete");
    expect(taskStatus({ hitLimit: false, interrupted: true, unresolvedFailure: true })).toBe("interrupted");
  });
});

describe("a failed prerequisite blocks its dependents", () => {
  const t = (id: string, scope: string[], dependsOn: string[] = []): OrchTask => ({ id, agent: "dev", title: id, instructions: "", scope, dependsOn });

  it("skips the dependent when the prerequisite ends on a failing command", async () => {
    const ran: string[] = [];
    const runner: TaskRunner = async (task) => {
      ran.push(task.id);
      const failed = task.id === "db";
      return { status: taskStatus({ hitLimit: false, unresolvedFailure: failed }), summary: "", filesWritten: [], commandsRun: [] };
    };
    const master = new OrchestraMaster({ runner, locks: new WorkspaceLocks(os.tmpdir()), concurrency: 2 });
    const res = await master.run([t("db", ["db/"]), t("api", ["api/"], ["db"])]);
    expect(ran).toEqual(["db"]);
    expect(res.outcomes.db.status).toBe("failed");
    expect(res.outcomes.api.status).toBe("skipped");
    expect(res.ok).toBe(false);
  });
});
