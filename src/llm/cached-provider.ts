import type { LLMProvider, LLMResponse, ChatMessage, ToolSchema } from "./types";
import { LLMCache } from "./cache";
import pc from "picocolors";

export class CachedLLMProvider implements LLMProvider {
  private cache = new LLMCache();

  constructor(private readonly baseProvider: LLMProvider) {}

  get name(): string {
    return this.baseProvider.name;
  }

  get model(): string | undefined {
    return this.baseProvider.model;
  }

  async chat(messages: ChatMessage[], tools?: ToolSchema[]): Promise<LLMResponse> {
    const salt = `${this.baseProvider.name}:${this.baseProvider.model ?? ""}`;
    const cached = this.cache.get(messages, tools, salt);

    if (cached) {
      console.log(pc.dim("  (⚡ LLM cache hit)"));
      return cached as LLMResponse;
    }

    const response = await this.baseProvider.chat(messages, tools);

    // Never cache a reply that was cut off at the token limit: replaying a
    // truncated file forever is exactly the failure we're trying to avoid.
    if (response.finishReason !== "length") {
      this.cache.set(messages, tools, response, salt);
    }

    return response;
  }
}
