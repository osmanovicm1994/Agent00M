import type { LLMProvider } from "./types";
import { LMStudioProvider, type LMStudioConfig } from "./providers/lmstudio";

export type ProviderId = "lmstudio" | "anthropic";

// Central place that decides which LLM backend an agent talks to.
// Adding a new backend later = add a case here + a provider file; nothing
// else in the codebase (agents, executor, planner) needs to change.
export function createProvider(id: ProviderId = "lmstudio", config?: LMStudioConfig): LLMProvider {
  switch (id) {
    case "lmstudio":
      return new LMStudioProvider(config);
    case "anthropic":
      throw new Error(
        "Anthropic provider not implemented yet — this is the plug point for adding it later.",
      );
    default:
      throw new Error(`Unknown LLM provider: ${id}`);
  }
}
