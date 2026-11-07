import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { redactSecrets } from "../gateway/redact";
import type { GeminiTriageClient } from "../gateway/gemini";
import { parseBrief, fallbackBrief } from "./types";
import { renderResearchContext } from "./render";
import { ResearchAgent } from "./research-agent";
import { combineContext, contextBudget, fitText } from "./budget";
import { isGeneralRealtime, plannerModeEnv } from "./index";

// A stand-in for the Gemini client: nothing here touches the network.
function fakeClient(impl: (instruction: string, content: string) => unknown) {
  const calls: Array<{ instruction: string; content: string }> = [];
  const client = {
    research: async (instruction: string, content: string) => {
      calls.push({ instruction, content });
      const out = impl(instruction, content);
      if (out instanceof Error) throw out;
      return out;
    },
  } as unknown as GeminiTriageClient;
  return { client, calls };
}

const answer = (text: string, extra: Record<string, unknown> = {}) => ({ text, sources: [], queries: [], grounded: false, model: "mock", ...extra });

let workspace: string;
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "research-test-"));
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "demo", scripts: { build: "tsc" } }));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("redactSecrets", () => {
  it("masks well-known secret shapes", () => {
    const googleKey = "AIza" + "S".repeat(35);
    const input = `key ${googleKey} and token=abcd1234efgh and Bearer abcdefghijklmnop and sk-abcdefghijklmnopqrstuv`;
    const r = redactSecrets(input);
    expect(r.text).not.toContain(googleKey);
    expect(r.text).not.toContain("abcd1234efgh");
    expect(r.text).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(r.count).toBeGreaterThanOrEqual(3);
  });
  it("leaves ordinary text alone", () => {
    expect(redactSecrets("add a health endpoint to apps/api")).toEqual({ text: "add a health endpoint to apps/api", count: 0 });
  });
});

describe("parseBrief and fallbackBrief", () => {
  it("accepts JSON in a fence and fills missing fields", () => {
    const b = parseBrief('```json\n{"clarifiedProblem":"x","needsPlan":true,"findings":null}\n```');
    expect(b.clarifiedProblem).toBe("x");
    expect(b.needsPlan).toBe(true);
    expect(b.findings).toEqual([]);
  });
  it("rejects an answer without JSON, and the fallback keeps the prose as a low-confidence finding", () => {
    expect(() => parseBrief("I could not find anything")).toThrow();
    const f = fallbackBrief("some prose answer");
    expect(f.findings[0]).toMatchObject({ fact: "some prose answer", confidence: "low" });
  });
});

describe("ResearchAgent with a mock Gemini client", () => {
  it("sends the query with secrets masked, and only a file-name overview of the project", async () => {
    const { client, calls } = fakeClient(() => answer('{"clarifiedProblem":"ok"}'));
    const secret = "AIza" + "S".repeat(35);
    await new ResearchAgent(client).run(`fix the build, my key is ${secret}`, workspace);
    expect(calls).toHaveLength(1);
    expect(calls[0].content).not.toContain(secret);
    expect(calls[0].content).toContain("[REDACTED");
    expect(calls[0].content).toContain("<workspace_fingerprint>");
  });

  it("falls back to a low-confidence brief when the answer is not JSON", async () => {
    const { client } = fakeClient(() => answer("just some prose"));
    const out = await new ResearchAgent(client).run("task", workspace);
    expect(out?.brief.findings[0].confidence).toBe("low");
  });

  it("marks every finding low when Google Search was not used", async () => {
    const { client } = fakeClient(() => answer('{"findings":[{"fact":"a","source":"s","confidence":"high"}]}', { grounded: false }));
    const out = await new ResearchAgent(client).run("task", workspace);
    expect(out?.brief.findings.every((f) => f.confidence === "low")).toBe(true);
  });

  it("returns null instead of throwing when Gemini fails (quota, network)", async () => {
    const { client } = fakeClient(() => new Error("429 quota exceeded"));
    await expect(new ResearchAgent(client).run("task", workspace)).resolves.toBeNull();
  });

  it("ignores an unknown recommended agent", async () => {
    const { client } = fakeClient(() => answer('{"recommendedAgent":"no-such-agent"}'));
    const out = await new ResearchAgent(client).run("task", workspace);
    expect(out?.recommendedAgent).toBeUndefined();
  });
});

describe("context size", () => {
  const brief = parseBrief(
    JSON.stringify({
      clarifiedProblem: "p".repeat(500),
      findings: Array.from({ length: 12 }, (_, i) => ({ fact: `fact ${i} ` + "x".repeat(300), source: "src", confidence: "high" })),
      unknowns: ["u".repeat(300), "v".repeat(300)],
    }),
  );

  it("renderResearchContext stays near its limit", () => {
    const text = renderResearchContext(brief, [], 1800);
    expect(text.length).toBeLessThanOrEqual(1800 + 40);
  });

  it("brief and plan together never exceed the total budget", () => {
    const budget = contextBudget(true, {} as NodeJS.ProcessEnv);
    const research = renderResearchContext(brief, [], budget.research);
    const ctx = combineContext(research, "PLAN ".repeat(5000), budget);
    expect(ctx.length).toBeLessThanOrEqual(budget.total);
  });

  it("uses the whole budget for the brief when there is no plan", () => {
    const budget = contextBudget(false, {} as NodeJS.ProcessEnv);
    expect(budget).toEqual({ total: 2800, research: 2800, plan: 0 });
  });

  it("AGENT_RESEARCH_MAX_CHARS is the total; bad values fall back", () => {
    expect(contextBudget(true, { AGENT_RESEARCH_MAX_CHARS: "5000" } as NodeJS.ProcessEnv).total).toBe(5000);
    expect(contextBudget(true, { AGENT_RESEARCH_MAX_CHARS: "abc" } as NodeJS.ProcessEnv).total).toBe(4600);
    expect(contextBudget(false, { AGENT_RESEARCH_MAX_CHARS: "-5" } as NodeJS.ProcessEnv).total).toBe(2800);
    expect(contextBudget(false, { AGENT_RESEARCH_MAX_CHARS: "50" } as NodeJS.ProcessEnv).total).toBe(2800);
  });

  it("fitText marks what it cut and respects the limit", () => {
    const t = fitText("a".repeat(1000), 100);
    expect(t.length).toBe(100);
    expect(t).toContain("[shortened to fit]");
    expect(fitText("short", 100)).toBe("short");
  });
});

describe("mode helpers", () => {
  it("recognises a plain real-time question but not a code question", () => {
    expect(isGeneralRealtime("what is the weather tomorrow")).toBe(true);
    expect(isGeneralRealtime("fix the weather component bug in my repo")).toBe(false);
  });
  it("plannerModeEnv defaults to auto", () => {
    const saved = process.env.AGENT_PLANNER;
    delete process.env.AGENT_PLANNER;
    expect(plannerModeEnv()).toBe("auto");
    process.env.AGENT_PLANNER = "always";
    expect(plannerModeEnv()).toBe("always");
    process.env.AGENT_PLANNER = "nonsense";
    expect(plannerModeEnv()).toBe("auto");
    if (saved === undefined) delete process.env.AGENT_PLANNER;
    else process.env.AGENT_PLANNER = saved;
  });
});
