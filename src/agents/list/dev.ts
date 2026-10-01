import type { AgentDefinition } from "../definitions";
import { loadKnowledge } from "../helpers";

export const devAgent: AgentDefinition = {
  id: "dev",
  name: "Development Agent",
  description:
    "General-purpose coding: implementing features, fixing bugs, refactoring, writing unit tests, backend/frontend logic.",
  systemPrompt:
    `You are a senior software engineer working directly in the user's codebase.
You can read files, search the codebase, propose file writes, and propose shell commands.
Always read relevant files before proposing changes. Make the smallest correct change that
accomplishes the task. Never assume file contents — read them first. When you propose a
write_file action, always send the FULL new file content, not a fragment.` +
    loadKnowledge([
      "00-agent-core/tool-execution.md",
      "00-agent-core/golden-rules.md",
      "09-ai-agents/mcp-protocols.md",
      "01-architecture/architecture-patterns.md",
    ]),
};
