import { describe, it, expect } from "vitest";
import { cleanScope, parseDependency, planToOrchTasks } from "./parallel";
import { pmPlanSchema } from "./roles";

const plan = (tasks: object[]) => pmPlanSchema.parse({ goal: "g", tasks });

describe("cleanScope", () => {
  it("turns globs and ./ into folder scopes", () => {
    expect(cleanScope("apps/api/**")).toBe("apps/api/");
    expect(cleanScope("apps/api/*")).toBe("apps/api/");
    expect(cleanScope("./prisma/")).toBe("prisma/");
    expect(cleanScope("apps\\web\\")).toBe("apps/web/");
    expect(cleanScope("package.json")).toBe("package.json");
  });
});

describe("parseDependency", () => {
  it("reads numbers and task labels", () => {
    expect(parseDependency(2)).toBe(2);
    expect(parseDependency("3")).toBe(3);
    expect(parseDependency("t4")).toBe(4);
    expect(parseDependency("task 5")).toBe(5);
    expect(parseDependency("later")).toBeNull();
    expect(parseDependency(1.5)).toBeNull();
  });
});

describe("planToOrchTasks", () => {
  const good = plan([
    { role: "db", title: "Schema", instructions: "x", scope: ["prisma/"] },
    { role: "api", title: "Users API", instructions: "x", scope: ["apps/api/**"] },
    { role: "design", title: "Web page", instructions: "x", scope: ["apps/web/"], dependsOn: [2] },
    { role: "qa", title: "Tests", instructions: "x", acceptance: ["npm test passes"], scope: ["e2e/"] },
  ]);

  it("builds a valid graph and adds the usual order (db before api, everything before qa)", () => {
    const g = planToOrchTasks(good);
    expect(g.problems).toEqual([]);
    const by = Object.fromEntries(g.tasks.map((t) => [t.id, t]));
    expect(by.t2.dependsOn).toEqual(["t1"]);
    // a design task also waits for the db task planned before it (the interface is built against the real data)
    expect([...by.t3.dependsOn].sort()).toEqual(["t1", "t2"]);
    expect(by.t4.dependsOn.sort()).toEqual(["t1", "t2", "t3"]);
    expect(by.t2.scope).toEqual(["apps/api/"]);
  });

  it("makes db and api tasks publish a contract when others wait for them", () => {
    const by = Object.fromEntries(planToOrchTasks(good).tasks.map((t) => [t.id, t]));
    expect(by.t1.publishes).toBe("t1");
    expect(by.t2.publishes).toBe("t2");
    expect(by.t3.publishes).toBeUndefined();
    expect([...(by.t3.readsContracts ?? [])].sort()).toEqual(["t1", "t2"]);
  });

  it("adds acceptance criteria and the UX spec to the instructions, and leaves UX out of the graph", () => {
    const p = plan([
      { role: "ux", title: "Spec", scope: [] },
      { role: "design", title: "A", instructions: "build a", scope: ["apps/web/"] },
      { role: "api", title: "B", instructions: "build b", scope: ["apps/api/"], acceptance: ["returns 200"] },
    ]);
    const g = planToOrchTasks(p, "SCREEN LIST");
    expect(g.problems).toEqual([]);
    expect(g.tasks.map((t) => t.id)).toEqual(["t2", "t3"]);
    expect(g.tasks[0].instructions).toContain("SCREEN LIST");
    expect(g.tasks[1].instructions).toContain("returns 200");
  });

  it("makes a design task wait for the api and db tasks planned before it, even when the planner forgot", () => {
    const g = planToOrchTasks(
      plan([
        { role: "db", title: "Schema", scope: ["packages/db/"] },
        { role: "api", title: "API", scope: ["apps/web/src/app/api/"] },
        { role: "design", title: "Pages", scope: ["apps/web/src/app/(app)/"] },
      ]),
    );
    expect(g.problems).toEqual([]);
    const by = Object.fromEntries(g.tasks.map((t) => [t.id, t]));
    expect([...by.t3.dependsOn].sort()).toEqual(["t1", "t2"]);
  });

  it("does not make a design task wait for an api task planned AFTER it", () => {
    const g = planToOrchTasks(
      plan([
        { role: "design", title: "Pages", scope: ["apps/web/src/app/"] },
        { role: "api", title: "API", scope: ["apps/web/src/app/api/"] },
      ]),
    );
    const by = Object.fromEntries(g.tasks.map((t) => [t.id, t]));
    expect(by.t1.dependsOn).toEqual([]);
  });

  it("adds the extra context (original request, referenced files) to every engineer task", () => {
    const g = planToOrchTasks(
      plan([
        { role: "api", title: "A", instructions: "build a", scope: ["a/"] },
        { role: "db", title: "B", instructions: "build b", scope: ["b/"] },
      ]),
      "",
      "## REFERENCED FILES\nSPEC TEXT",
    );
    for (const t of g.tasks) expect(t.instructions).toContain("SPEC TEXT");
  });

  it("reports a missing scope", () => {
    const g = planToOrchTasks(plan([{ role: "dev", title: "A" }, { role: "api", title: "B", scope: ["apps/api/"] }]));
    expect(g.problems.join()).toContain("has no scope");
  });

  it("reports overlapping scopes between independent tasks", () => {
    const g = planToOrchTasks(
      plan([
        { role: "dev", title: "A", scope: ["apps/"] },
        { role: "design", title: "B", scope: ["apps/web/"] },
      ]),
    );
    expect(g.problems.join()).toContain("parallel");
  });

  it("accepts the same overlap when one task waits for the other", () => {
    const g = planToOrchTasks(
      plan([
        { role: "dev", title: "A", scope: ["apps/"] },
        { role: "design", title: "B", scope: ["apps/web/"], dependsOn: [1] },
      ]),
    );
    expect(g.problems).toEqual([]);
  });

  it("reports unreadable or unknown dependencies", () => {
    const g = planToOrchTasks(
      plan([
        { role: "dev", title: "A", scope: ["a/"], dependsOn: ["soon"] },
        { role: "api", title: "B", scope: ["b/"], dependsOn: [9] },
      ]),
    );
    expect(g.problems.join()).toContain("cannot read dependency");
    expect(g.problems.join()).toContain("does not exist");
  });

  it("says a single engineer task is not worth running in parallel", () => {
    const g = planToOrchTasks(plan([{ role: "dev", title: "A", scope: ["a/"] }]));
    expect(g.problems.join()).toContain("fewer than two");
  });

  it("reports a dependency cycle", () => {
    const g = planToOrchTasks(
      plan([
        { role: "dev", title: "A", scope: ["a/"], dependsOn: [2] },
        { role: "design", title: "B", scope: ["b/"], dependsOn: [1] },
      ]),
    );
    expect(g.problems.join()).toContain("cycle");
  });
});
