// src/agents/definitions.ts
import { devAgent } from "./list/dev";
import { apiAgent } from "./list/api";
import { dbAgent } from "./list/db";
import { designAgent } from "./list/design";
import { logicAgent } from "./list/logic";
import { kbHarvesterAgent } from "./list/kb-harvester";
import { qaAgent } from "./list/qa";
import { debugAgent } from "./list/debug";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  // How many sequentialthinking calls this agent may make per task (default 8).
  thinkingBudget?: number;
  // Auto-approve a strict allowlist of read-only diagnostic commands (versions,
  // git status/log/diff, ls, port checks). Everything else still asks. AGENT_AUTO_DIAG=0 disables it.
  autoDiagnostics?: boolean;
  // Before finishing, require that the agent re-ran a command after its last file change.
  verifyFixes?: boolean;
  // Review role: file writes are refused and only read-only diagnostic commands run (see Executor).
  readOnly?: boolean;
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
  debugAgent,
];

// 2. Helper to fetch them
export function getAgent(id: string): AgentDefinition | undefined {
  return AGENTS.find((a) => a.id.toLowerCase() === id.toLowerCase());
}
