// Guards the wiring that used to break silently: an agent that has a file but is not registered, a routing
// group with no agent behind it, and knowledge paths that point at files that do not exist.
import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { DOMAIN_KEYWORDS, allRuleKnowledgePaths } from "./orchestration";

const KNOWLEDGE = path.resolve(process.cwd(), "src/knowledge");

describe("agent registry", () => {
  it("registers every agent once, including research, with no missing knowledge files", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { AGENTS, getAgent } = await import("./definitions");

    const idList = AGENTS.map((a) => a.id);
    expect(new Set(idList).size).toBe(idList.length);
    expect(idList).toEqual(expect.arrayContaining(["dev", "api", "db", "design", "logic", "kb-harvester", "qa", "debug", "research"]));
    expect(getAgent("research")).toBeDefined();

    // loadKnowledge warns once per missing file while the agent prompts are built at import time.
    const missing = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("Knowledge file not found"));
    expect(missing).toEqual([]);
    warn.mockRestore();
  });

  it("has an agent behind every routing keyword group", async () => {
    const { getAgent } = await import("./definitions");
    for (const id of Object.keys(DOMAIN_KEYWORDS)) expect(getAgent(id), `no agent registered for routing group '${id}'`).toBeDefined();
  });

  it("gives every engineering agent the reasoning core, and the logic agent all logic standards", async () => {
    const { getAgent } = await import("./definitions");
    for (const id of ["dev", "api", "db", "design", "qa"]) {
      expect(getAgent(id)!.systemPrompt, id).toContain("### STANDARD: 08-logic/00-reasoning-core.md");
    }
    const logic = getAgent("logic")!.systemPrompt;
    for (const f of ["01-problem-decomposition", "02-edge-case-analysis", "03-distributed-systems", "04-root-cause-debugging"]) {
      expect(logic).toContain(`08-logic/${f}.md`);
    }
  });
});

describe("task knowledge rules", () => {
  it("only point at files that exist", () => {
    for (const rel of allRuleKnowledgePaths()) {
      expect(fs.existsSync(path.join(KNOWLEDGE, rel)), `missing knowledge file ${rel}`).toBe(true);
    }
  });
});
