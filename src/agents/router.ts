import type { LLMProvider } from "../llm/types";
import { AGENTS, getAgent, type AgentDefinition } from "./definitions";

// Asks the model to pick which specialist agent should handle a task.
// Falls back to the "dev" agent if the model's answer doesn't match a known
// agent id (keeps the router robust against a small/local model being sloppy).
export async function routeTask(llm: LLMProvider, task: string): Promise<AgentDefinition> {
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
