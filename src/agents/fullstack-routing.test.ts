import { describe, it, expect } from "vitest";
import { analyzeTask, isFullstackBuild, pickByKeywords, rankDomains } from "./orchestration";

describe("whole-app build routing", () => {
  const task = "build a full-stack app with Next.js, NestJS, Prisma on Neon, Docker deploy";

  it("goes to dev, not to the one specialist keyword it happens to contain", () => {
    expect(pickByKeywords(rankDomains(task))).toBe("dev");
  });

  it("prints the team hint even when only one build domain matched", () => {
    const a = analyzeTask(task);
    expect(a.crossCutting).toBe(true);
    expect(a.teamHint).toContain("/team");
  });

  it("recognises the narrow set of whole-app phrases and needs a change verb", () => {
    expect(isFullstackBuild("scaffold a monorepo with a web and an api app")).toBe(true);
    expect(isFullstackBuild("what is a full-stack developer")).toBe(false);
    expect(isFullstackBuild("rewrite this test from scratch")).toBe(false);
  });

  it("leaves failure reports and single-layer tasks alone", () => {
    expect(pickByKeywords(rankDomains("the full-stack app build fails with TS2304 and an exception"))).not.toBe("dev");
    expect(pickByKeywords(rankDomains("add a prisma migration for the orders table"))).toBe("db");
  });

  it("does not hijack test-automation projects", () => {
    expect(pickByKeywords(rankDomains("create a new project of playwright tests", { automationProject: true }))).toBe("qa");
  });
});
