// Pluggable LLM abstraction. Every backend (LM Studio / Qwen, NVIDIA NIM,
// Anthropic, etc.) implements this same interface, so agents/executor never
// know or care which model is actually running.

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

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  // Model's raw reasoning/think block, if the backend exposes one (e.g. DeepSeek R1).
  reasoning?: string;
  // Why generation stopped. "length" means the output was cut off by the token
  // limit even after any automatic continuation attempts.
  finishReason?: string;
}

export interface LLMProvider {
  readonly name: string;
  // Model identifier (used e.g. to keep response caches of different models apart).
  readonly model?: string;
  chat(messages: ChatMessage[], tools?: ToolSchema[]): Promise<LLMResponse>;
}
