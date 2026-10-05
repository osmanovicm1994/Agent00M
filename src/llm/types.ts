// Pluggable LLM abstraction. Every backend (LM Studio, NVIDIA NIM, Anthropic, ...)
// implements this same interface, so agents/executor never know or care which
// model is actually running.

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  // Present when role === "tool": which tool call this message is a result for.
  toolCallId?: string;
  // Present when role === "assistant" and the model wants to call tools.
  toolCalls?: ToolCall[];
}

export interface ToolSchema {
  name: string;
  description: string;
  // JSON Schema for the tool's arguments object.
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  // Raw JSON string of arguments, as returned by the model.
  arguments: string;
}

// Per-request overrides. Passing maxTokens also turns off automatic continuation.
export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
}

// Timing of one chat() call (all continuation requests included).
export interface LLMStats {
  // Time until the first generated token (content, reasoning or tool call).
  ttftMs: number;
  totalMs: number;
  outTokens: number;
  // Generation speed after the first token; 0 when too few tokens to be meaningful.
  tokPerSec: number;
  // true when the server sent no usage and the token count is a chars/3.5 estimate.
  estimated: boolean;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  // Model's raw reasoning/think block, if the backend exposes one (e.g. DeepSeek R1).
  reasoning?: string;
  // Why generation stopped. "length" means the output was cut off by the token
  // limit even after any automatic continuation attempts.
  finishReason?: string;
  stats?: LLMStats;
}

export interface LLMProvider {
  readonly name: string;
  // Model identifier (also used to keep response caches of different models apart).
  readonly model?: string;
  // false = the model has no tool-calling template: no `tools` payload is sent and the
  // agent uses fenced ```action blocks. undefined/true = native tool calls.
  readonly nativeTools?: boolean;
  chat(messages: ChatMessage[], tools?: ToolSchema[], options?: ChatOptions): Promise<LLMResponse>;
  listModels?(): Promise<string[]>;
  // Switch model at runtime (used by `/model` in the chat).
  setModel?(id: string): void;
}
