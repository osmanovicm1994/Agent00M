// src/llm/factory.ts
import type { LLMProvider } from "./types";
import { LMStudioProvider, type LMStudioConfig } from "./providers/lmstudio";
import { CachedLLMProvider } from "./cached-provider";

export type ProviderId = "lmstudio" | "anthropic";

export function createProvider(id: ProviderId = "lmstudio", config?: LMStudioConfig): LLMProvider {
  let baseProvider: LLMProvider;

  switch (id) {
    case "lmstudio":
      baseProvider = new LMStudioProvider(config);
      break;
    case "anthropic":
      // Intentionally not implemented: the agent's brain is the local model (worker) plus Gemini (architect, see src/gateway).
      throw new Error("Anthropic provider is not implemented. The agent uses the local model; Gemini plans via the triage gateway.");
    default:
      throw new Error(`Unknown LLM provider: ${id}`);
  }

  // Wrap the base provider in the caching layer before returning
  return new CachedLLMProvider(baseProvider);
}
