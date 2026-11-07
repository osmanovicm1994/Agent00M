import { describe, it, expect } from "vitest";
import { planToOrchTasks } from "./parallel";
import { ASSIGNABLE_ROLES, PM_SYSTEM, ROLE_TITLES, pmPlanSchema } from "./roles";

describe("the infra role", () => {
  it("is assignable, titled and described to the PM", () => {
    expect(ASSIGNABLE_ROLES).toContain("infra");
    expect(ROLE_TITLES.infra).toBe("Infrastructure Engineer");
    expect(PM_SYSTEM).toContain("- infra ");
    expect(PM_SYSTEM).toContain("<project_tree>");
  });

  it("is registered as an agent with its knowledge files present", async () => {
    const { getAgent } = await import("../agents/definitions");
    const infra = getAgent("infra");
    expect(infra).toBeDefined();
    expect(infra!.verifyFixes).toBe(true);
    expect(infra!.systemPrompt).toContain("xcodegen");
    expect(infra!.systemPrompt).toContain("gradlew");
  });

  it("runs before the other engineer tasks in a parallel plan", () => {
    const plan = pmPlanSchema.parse({
      goal: "new app",
      tasks: [
        { role: "infra", title: "skeleton", scope: ["apps/api/"], dependsOn: [] },
        { role: "api", title: "api", scope: ["apps/api/src/"], dependsOn: [] },
        { role: "design", title: "web", scope: ["apps/web/"], dependsOn: [] },
      ],
    });
    const graph = planToOrchTasks(plan);
    const byId = Object.fromEntries(graph.tasks.map((t) => [t.id, t]));
    expect(byId.t2.dependsOn).toContain("t1");
    expect(byId.t3.dependsOn).toContain("t1");
    expect(byId.t1.dependsOn).toEqual([]);
  });
});
