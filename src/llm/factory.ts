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
      throw new Error(
        "Anthropic provider not implemented yet — this is the plug point for adding it later.",
      );
    default:
      throw new Error(`Unknown LLM provider: ${id}`);
  }

  // Wrap the base provider in the caching layer before returning
  return new CachedLLMProvider(baseProvider);
}