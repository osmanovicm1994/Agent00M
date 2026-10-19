import { bus } from "../core/events";
import type { ChatMessage, ChatOptions, LLMProvider, LLMResponse, ToolSchema } from "./types";

// Reports the token usage of every real model call on the event bus (`llm_usage`), so the live
// dashboard can show prompt/completion tokens per run and per agent. It wraps the BASE provider and
// sits INSIDE the response cache: a cache hit never reaches this class, so it is correctly not
// counted as usage. bus.emit() is a cheap no-op when nobody listens.
export class UsageReportingProvider implements LLMProvider {
  constructor(private readonly inner: LLMProvider) {}

  get name(): string {
    return this.inner.name;
  }

  get model(): string | undefined {
    return this.inner.model;
  }

  get nativeTools(): boolean | undefined {
    return this.inner.nativeTools;
  }

  setModel(id: string): void {
    this.inner.setModel?.(id);
  }

  async listModels(): Promise<string[]> {
    return this.inner.listModels ? this.inner.listModels() : [];
  }

  async chat(messages: ChatMessage[], tools?: ToolSchema[], options?: ChatOptions): Promise<LLMResponse> {
    const response = await this.inner.chat(messages, tools, options);
    const stats = response.stats;
    if (stats) {
      bus.emit("llm_usage", {
        model: this.inner.model ?? "unknown",
        // A provider that does not report prompt tokens leaves them out: shown as an estimate of 0.
        promptTokens: stats.promptTokens ?? 0,
        completionTokens: stats.outTokens,
        promptEstimated: stats.promptEstimated ?? true,
        completionEstimated: stats.estimated,
        ttftMs: stats.ttftMs,
        totalMs: stats.totalMs,
        tokPerSec: stats.tokPerSec,
      });
    }
    return response;
  }
}
