import { describe, it, expect } from "vitest";
import { analyzeTask, pickByKeywords, rankDomains, selectTaskKnowledge } from "./orchestration";

const ids = (task: string, opts = {}) => rankDomains(task, opts).map((s) => s.id);

describe("rankDomains / pickByKeywords", () => {
  it("routes failure language to debug even when it also mentions the api", () => {
    const scores = rankDomains("npm run dev:api fails");
    expect(pickByKeywords(scores)).toBe("debug");
  });

  it("routes a REST endpoint task to api", () => {
    expect(pickByKeywords(rankDomains("Create a REST endpoint and a migration for users"))).toBe("api");
  });

  it("does not route generic words", () => {
    expect(rankDomains("add an npm run script")).toEqual([]);
    expect(rankDomains("fix the button")).toEqual([]);
  });

  it("returns undefined on a tie so the model router decides", () => {
    expect(pickByKeywords([{ id: "api", score: 1 }, { id: "db", score: 1 }])).toBeUndefined();
    expect(pickByKeywords([])).toBeUndefined();
  });

  it("keeps a pure lookup as research", () => {
    expect(ids("look up the latest version of nestjs")).toContain("research");
  });

  it("does not hand a change task to the research agent", () => {
    expect(ids("update the dependencies and look up the latest version of nestjs")).not.toContain("research");
  });

  it("treats generic test words as QA only in a test-automation project", () => {
    expect(ids("write tests for the login screen")).toEqual([]);
    expect(ids("write tests for the login screen", { automationProject: true })).toEqual(["qa"]);
  });
});

describe("selectTaskKnowledge", () => {
  it("loads the edge-case standards first for payment/retry work", () => {
    const picks = selectTaskKnowledge("Add a payment webhook with retries", "dev");
    expect(picks[0].path).toBe("08-logic/02-edge-case-analysis.md");
  });

  it("loads distributed-systems standards for queue work", () => {
    const paths = selectTaskKnowledge("Process orders from a Kafka queue", "dev").map((p) => p.path);
    expect(paths).toContain("08-logic/03-distributed-systems.md");
  });

  it("loads root-cause standards for intermittent failures", () => {
    const paths = selectTaskKnowledge("The checkout test is flaky and only fails in CI", "qa").map((p) => p.path);
    expect(paths).toContain("08-logic/04-root-cause-debugging.md");
  });

  it("adds database standards for a migration task given to a non-db agent, not to the db agent", () => {
    const forDev = selectTaskKnowledge("add a migration for the users table", "dev").map((p) => p.path);
    const forDb = selectTaskKnowledge("add a migration for the users table", "db").map((p) => p.path);
    expect(forDev).toContain("06-database/02-migration-safety.md");
    expect(forDb.some((p) => p.startsWith("06-database/"))).toBe(false);
  });

  it("gives nothing to agents that write no code", () => {
    expect(selectTaskKnowledge("Add a payment webhook with retries", "research")).toEqual([]);
    expect(selectTaskKnowledge("Add a payment webhook with retries", "kb-harvester")).toEqual([]);
  });

  it("never exceeds the file limit and keeps the heaviest rule first", () => {
    const task =
      "Implement a payment webhook with retries through a Kafka queue, a database migration, a REST endpoint with JWT auth and a React component";
    const picks = selectTaskKnowledge(task, "dev", 4);
    expect(picks.length).toBeLessThanOrEqual(4);
    expect(picks[0].weight).toBeGreaterThanOrEqual(picks[picks.length - 1].weight);
    expect(new Set(picks.map((p) => p.path)).size).toBe(picks.length);
  });

  it("returns nothing for a plain small task", () => {
    expect(selectTaskKnowledge("rename the variable foo to bar", "dev")).toEqual([]);
  });
});

describe("analyzeTask", () => {
  it("flags a task that spans several layers and suggests team mode", () => {
    const a = analyzeTask("Add a REST endpoint, a database migration and a React component with tailwind", "dev");
    expect(a.crossCutting).toBe(true);
    expect(a.domains).toEqual(expect.arrayContaining(["api", "db", "design"]));
    expect(a.teamHint).toMatch(/team/);
  });

  it("does not flag a single-layer task", () => {
    expect(analyzeTask("Add a REST endpoint for users", "api").crossCutting).toBe(false);
  });
});
