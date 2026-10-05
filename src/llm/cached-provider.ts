import type { ChatMessage, ChatOptions, LLMProvider, LLMResponse, ToolSchema } from "./types";
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

  get nativeTools(): boolean | undefined {
    return this.baseProvider.nativeTools;
  }

  setModel(id: string): void {
    this.baseProvider.setModel?.(id);
  }

  async listModels(): Promise<string[]> {
    if (!this.baseProvider.listModels) return [];
    return this.baseProvider.listModels();
  }

  async chat(messages: ChatMessage[], tools?: ToolSchema[], options?: ChatOptions): Promise<LLMResponse> {
    // The salt covers everything besides the messages that changes the answer: the model,
    // the tool protocol, the sampling settings and per-call overrides. Switching any of them
    // can therefore never replay another configuration's answer.
    const salt = [
      this.baseProvider.name,
      this.baseProvider.model ?? "",
      this.baseProvider.nativeTools === false ? "fenced" : "native",
      process.env.AI_TEMPERATURE ?? "",
      process.env.AI_MAX_TOKENS ?? "",
      JSON.stringify(options ?? {}),
    ].join(":");
    const cached = this.cache.get(messages, tools, salt);

    if (cached) {
      console.log(pc.dim("  (⚡ LLM cache hit)"));
      return cached as LLMResponse;
    }

    const response = await this.baseProvider.chat(messages, tools, options);

    // Never cache a reply that was cut off at the token limit: replaying a
    // truncated file forever is exactly the failure we're trying to avoid.
    if (response.finishReason !== "length") {
      this.cache.set(messages, tools, response, salt);
    }

    return response;
  }
}
