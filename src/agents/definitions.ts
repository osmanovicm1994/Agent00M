// src/agents/definitions.ts
import { devAgent } from "./list/dev";
import { apiAgent } from "./list/api";
import { dbAgent } from "./list/db";
import { designAgent } from "./list/design";
import { logicAgent } from "./list/logic";
import { kbHarvesterAgent } from "./list/kb-harvester";
import { qaAgent } from "./list/qa";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
}

// 1. Register all imported agents here
export const AGENTS: AgentDefinition[] = [
  devAgent,
  apiAgent,
  dbAgent,
  designAgent,
  logicAgent,
  kbHarvesterAgent,
  qaAgent,
];

// 2. Helper to fetch them
export function getAgent(id: string): AgentDefinition | undefined {
  return AGENTS.find((a) => a.id.toLowerCase() === id.toLowerCase());
}
