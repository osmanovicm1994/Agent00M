import type { LLMProvider } from "../llm/types";
import { bus, truncate } from "../core/events";
import { AGENTS, getAgent, type AgentDefinition } from "./definitions";
import { detectStackKnowledge } from "./helpers";
import { describeSignals, pickByKeywords, rankDomains, type DomainScore } from "./orchestration";

// Routing signals live in orchestration.ts (pure, unit-tested). Cheap keyword scoring: when exactly one
// specialist clearly wins, route instantly and skip an LLM round-trip (slow on a local 32B model).
// Anything ambiguous still goes to the model, which is also told which signals were found.

export interface RouteOptions {
  /** Target project root. Lets generic words like "write tests" route to QA in an Appium/Playwright project. */
  workspaceRoot?: string;
}

const warnedUnregistered = new Set<string>();

// A signal group whose agent is not registered used to fall through silently (the research agent was
// in that state). Say so once instead.
function resolveAgent(id: string): AgentDefinition | undefined {
  const agent = getAgent(id);
  if (!agent && !warnedUnregistered.has(id)) {
    warnedUnregistered.add(id);
    console.warn(`⚠ Routing matched agent '${id}' but it is not registered in agents/definitions.ts. Falling back.`);
  }
  return agent;
}

function isAutomationProject(workspaceRoot?: string): boolean {
  if (!workspaceRoot) return false;
  try {
    return detectStackKnowledge(workspaceRoot).some((p) => p.startsWith("02-qa-automation/"));
  } catch {
    return false;
  }
}

export function keywordRoute(task: string, opts: RouteOptions = {}): { agent?: AgentDefinition; scores: DomainScore[] } {
  const scores = rankDomains(task, { automationProject: isAutomationProject(opts.workspaceRoot) });
  const id = pickByKeywords(scores);
  return { agent: id ? resolveAgent(id) : undefined, scores };
}

type RouteMethod = "keyword" | "llm" | "default" | "forced" | "triage";

// Hands the baton to `agent` and tells any dashboard about it. The routing result is unchanged.
function routed(agent: AgentDefinition, method: RouteMethod): AgentDefinition {
  bus.setAgent(agent.id);
  bus.emit("agent_routed", { agentId: agent.id, agentName: agent.name, method });
  return agent;
}

// For callers that skip routing because the user picked the agent (-a / /use).
export function announceForcedAgent(agent: AgentDefinition): void {
  routed(agent, "forced");
}

// For callers that take the agent the research stage / planner recommended instead of routing.
export function announceTriageAgent(agent: AgentDefinition): void {
  routed(agent, "triage");
}

// Asks the model to pick which specialist agent should handle a task.
// Falls back to the "dev" agent if the model's answer doesn't match a known
// agent id (keeps the router robust against a small/local model being sloppy).
export async function routeTask(llm: LLMProvider, task: string, opts: RouteOptions = {}): Promise<AgentDefinition> {
  bus.emit("orchestrator_evaluating", { task: truncate(task, 500) });

  const { agent: quick, scores } = keywordRoute(task, opts);
  if (quick) return routed(quick, "keyword");

  // AGENT_ROUTER=keywords: never spend a model call on routing (unmatched tasks go to "dev").
  if ((process.env.AGENT_ROUTER ?? "auto").toLowerCase() === "keywords") return routed(getAgent("dev")!, "default");

  const agentList = AGENTS.map((a) => `- ${a.id}: ${a.description}`).join("\n");
  const signals = scores.length ? `\nKeyword signals found in the task (a tie, so you decide): ${describeSignals(scores)}` : "";

  const routerPrompt = `You are a router that assigns a coding task to exactly one specialist agent.

Available agents:
${agentList}

Rules: "debug" when something fails or misbehaves; "dev" for building or changing features that do not fit a specialist; "logic" only for planning or architecture questions that need no code; "research" only for questions answered by reading the web; a specialist when the task is clearly in its area.

Task: "${task}"${signals}

Respond with ONLY the agent id (one of: ${AGENTS.map((a) => a.id).join(", ")}), nothing else.`;

  // The answer is one word, so cap the output: a model that starts to ramble or think
  // (reasoning models) must not hold up the task for minutes. An empty answer falls back to "dev".
  const response = await llm.chat(
    [
      { role: "system", content: "You are a precise task router. Reply with a single agent id and nothing else." },
      { role: "user", content: routerPrompt },
    ],
    undefined,
    { maxTokens: 24, temperature: 0 },
  );

  const candidate = response.content.trim().toLowerCase().replace(/[^a-z-]/g, "");
  const picked = getAgent(candidate);
  return picked ? routed(picked, "llm") : routed(getAgent("dev")!, "default");
}
