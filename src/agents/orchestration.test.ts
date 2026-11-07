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

  it("sends a whole-app build to dev even when one stray failure word appears in the spec", () => {
    const task =
      "Build or finish an MVP car marketplace. Scaffold the app with a Prisma schema and migrations, REST endpoints and an admin UI. If a command fails, report it.";
    expect(pickByKeywords(rankDomains(task))).toBe("dev");
  });

  it("still treats a real failure report as debug even when the task says scaffold", () => {
    const task = "the scaffold script crashes: npm run build fails with TS2345 and cannot find module";
    expect(pickByKeywords(rankDomains(task))).toBe("debug");
  });

  it("treats generic test words as QA only in a test-automation project", () => {
    expect(ids("write tests for the login screen")).toEqual([]);
    expect(ids("write tests for the login screen", { automationProject: true })).toEqual(["qa"]);
  });
});

describe("selectTaskKnowledge", () => {
  it("loads the write-code protocol first, then the edge-case standards for payment/retry work", () => {
    const picks = selectTaskKnowledge("Add a payment webhook with retries", "dev");
    expect(picks[0].path).toBe("14-coding/00-write-code-protocol.md");
    expect(picks[1].path).toBe("08-logic/02-edge-case-analysis.md");
  });

  it("adds the coding-reliability standards that match the task", () => {
    const paths = (t: string, a = "dev") => selectTaskKnowledge(t, a, 8).map((p) => p.path);
    expect(paths("npm run typecheck fails with TS2339 in src/lib/auth.ts", "design")).toEqual(
      expect.arrayContaining(["14-coding/01-fix-loop.md", "14-coding/02-ts-error-codes.md"]),
    );
    expect(paths("fix the prisma seed script")).toContain("14-coding/04-prisma-contract.md");
    expect(paths("build the Next.js booking page with a shadcn select")).toContain("14-coding/03-nextjs-ui-pitfalls.md");
    expect(paths("upgrade the outdated dependencies and the JDK")).toContain("14-coding/05-dependency-updates.md");
    // the debug agent carries the fix loop itself
    expect(paths("npm run build fails", "debug")).not.toContain("14-coding/01-fix-loop.md");
  });

  it("loads the Bosnian standard for a Bosnian request or AGENT_LANGUAGE=bs, never for English", () => {
    const has = (t: string) => selectTaskKnowledge(t, "dev", 8).some((p) => p.path === "14-coding/07-language-bosnian.md");
    expect(has("Napravi stranicu za prijavu korisnika, treba i greške")).toBe(true);
    expect(has("Create a login page for users")).toBe(false);
    process.env.AGENT_LANGUAGE = "bs";
    try {
      expect(has("Create a login page for users")).toBe(true);
    } finally {
      delete process.env.AGENT_LANGUAGE;
    }
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

  it("gives the test strategy to whichever agent gets a task about tests, not to read-only agents", () => {
    const task = "Write integration tests for POST /api/listings";
    expect(selectTaskKnowledge(task, "api").map((p) => p.path)).toContain("02-qa-automation/00-test-strategy.md");
    expect(selectTaskKnowledge(task, "qa").map((p) => p.path)).toContain("02-qa-automation/00-test-strategy.md");
    expect(selectTaskKnowledge(task, "research")).toEqual([]);
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
