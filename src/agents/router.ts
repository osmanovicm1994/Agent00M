import type { LLMProvider } from "../llm/types";
import { AGENTS, getAgent, type AgentDefinition } from "./definitions";

// Cheap keyword scoring: when exactly one specialist clearly wins, route
// instantly and skip an LLM round-trip (slow on a local 32B model). Anything
// ambiguous still goes to the model. Keywords are deliberately specific;
// generic words like "test" or "fix" are NOT here so they fall through.
const KEYWORDS: Record<string, RegExp[]> = {
  qa: [/appium/i, /playwright/i, /selenium/i, /\be2e\b/i, /page object/i, /locator/i, /test automation/i, /xcuitest/i, /espresso/i, /flaky/i, /nunit/i],
  db: [/\bschema\b/i, /migration/i, /\bsql\b/i, /postgres/i, /\bindex(es|ing)?\b/i, /\borm\b/i, /prisma/i, /entity framework/i, /\bquery\b/i],
  api: [/endpoint/i, /\brest(ful)?\b/i, /controller/i, /\bapi\b/i, /middleware/i, /\bdto\b/i, /openapi|swagger/i],
  design: [/\bcss\b/i, /tailwind/i, /\bui\b/i, /\bux\b/i, /layout/i, /responsive/i, /accessib/i, /design system/i, /styling/i],
  "kb-harvester": [/knowledge base/i, /document (the )?(project|codebase|architecture)/i, /architecture docs?/i, /reverse.?engineer/i],
  logic: [/decompos/i, /trade-?offs?/i, /edge cases?/i, /root cause/i, /\bplan\b.*\b(approach|architecture)\b/i, /distributed/i],
};

function keywordRoute(task: string): AgentDefinition | undefined {
  const scores = Object.entries(KEYWORDS)
    .map(([id, patterns]) => ({ id, score: patterns.filter((p) => p.test(task)).length }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scores.length === 0) return undefined;
  // Require a strict winner; ties are ambiguous and go to the LLM.
  if (scores.length > 1 && scores[0].score === scores[1].score) return undefined;
  return getAgent(scores[0].id);
}

// Asks the model to pick which specialist agent should handle a task.
// Falls back to the "dev" agent if the model's answer doesn't match a known
// agent id (keeps the router robust against a small/local model being sloppy).
export async function routeTask(llm: LLMProvider, task: string): Promise<AgentDefinition> {
  const quick = keywordRoute(task);
  if (quick) return quick;

  const agentList = AGENTS.map((a) => `- ${a.id}: ${a.description}`).join("\n");

  const routerPrompt = `You are a router that assigns a coding task to exactly one specialist agent.

Available agents:
${agentList}

Task: "${task}"

Respond with ONLY the agent id (one of: ${AGENTS.map((a) => a.id).join(", ")}), nothing else.`;

  const response = await llm.chat([
    { role: "system", content: "You are a precise task router. Reply with a single agent id and nothing else." },
    { role: "user", content: routerPrompt },
  ]);

  const candidate = response.content.trim().toLowerCase().replace(/[^a-z-]/g, "");
  return getAgent(candidate) ?? getAgent("dev")!;
}
