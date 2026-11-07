import { describe, expect, it } from "vitest";
import { LITE_GUIDELINE_AGENTS, ROLE_FOCUS, guidelinesEnabled, operatingGuidelines } from "./operating-guidelines";

describe("operating guidelines", () => {
  it("building roles get the full text plus their own role focus", () => {
    for (const id of ["dev", "design", "api", "db", "infra", "qa"]) {
      const text = operatingGuidelines(id, {});
      expect(text, id).toContain("How you work");
      expect(text, id).toContain("## Your role in this team");
      expect(text, id).toContain(ROLE_FOCUS[id].slice(0, 40));
    }
  });

  it("investigating and reviewing roles get the short version without a role focus", () => {
    const full = operatingGuidelines("dev", {});
    for (const id of LITE_GUIDELINE_AGENTS) {
      const text = operatingGuidelines(id, {});
      expect(text, id).not.toBe("");
      expect(text.length, id).toBeLessThan(full.length / 2);
      expect(text, id).not.toContain("## Your role in this team");
    }
  });

  it("can be switched off with AGENT_GUIDELINES=0", () => {
    expect(guidelinesEnabled({ AGENT_GUIDELINES: "0" })).toBe(false);
    expect(operatingGuidelines("dev", { AGENT_GUIDELINES: "0" })).toBe("");
    expect(guidelinesEnabled({})).toBe(true);
  });

  it("states the rules that matter for the failed run: done means checks passed, the starter page is not done", () => {
    const text = operatingGuidelines("dev", {});
    expect(text).toMatch(/starter/i);
    expect(text).toMatch(/exited 0/i);
  });

  it("the front-end role is told to replace the generated home page", () => {
    expect(ROLE_FOCUS.design).toContain("src/app/page.tsx");
  });
});
