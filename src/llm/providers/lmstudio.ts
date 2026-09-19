import OpenAI from "openai";
import type {
  ChatMessage,
  LLMProvider,
  LLMResponse,
  ToolCall,
  ToolSchema,
} from "../types";

// Strips DeepSeek R1's <think>...</think> reasoning block out of the raw
// completion text, returning both parts separately. Some LM Studio setups
// truncate the opening <think> tag from the stream (only </think> survives),
// so this also handles a dangling closing tag with no opening one.
function splitReasoning(raw: string): { thought: string; answer: string } {
  const fullMatch = raw.match(/<think>([\s\S]*?)<\/think>/);
  if (fullMatch) {
    const thought = fullMatch[1].trim();
    const answer = raw.replace(/<think>[\s\S]*?<\/think>/, "").trim();
    return { thought, answer };
  }

  // No opening tag found, but a closing one is present — treat everything
  // before it as reasoning and everything after as the real answer.
  const closingIdx = raw.indexOf("</think>");
  if (closingIdx !== -1) {
    const thought = raw.slice(0, closingIdx).trim();
    const answer = raw.slice(closingIdx + "</think>".length).trim();
    return { thought, answer };
  }

  return { thought: "", answer: raw.trim() };
}

export interface LMStudioConfig {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
}

// LM Studio exposes an OpenAI-compatible /v1 server, so we can reuse the
// official `openai` SDK — just pointed at localhost instead of api.openai.com.
export class LMStudioProvider implements LLMProvider {
  readonly name = "lmstudio";
  private client: OpenAI;
  private model: string;
  private temperature: number;

  constructor(config: LMStudioConfig = {}) {
    const baseURL = config.baseURL ?? process.env.AI_BASE_URL ?? "http://localhost:1234/v1";
    const apiKey = config.apiKey ?? process.env.AI_API_KEY ?? "lm-studio";
    this.model = config.model ?? process.env.AI_MODEL_NAME ?? "deepseek-r1-qwen-32b";
    this.temperature = config.temperature ?? 0.6;

    this.client = new OpenAI({ baseURL, apiKey });
  }

  async chat(messages: ChatMessage[], tools?: ToolSchema[]): Promise<LLMResponse> {
    const openaiMessages = messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool" as const,
          content: m.content,
          tool_call_id: m.toolCallId ?? "",
        };
      }
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "assistant" as const,
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      return { role: m.role as "system" | "user" | "assistant", content: m.content };
    });

    const openaiTools = tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openaiMessages as any,
      temperature: this.temperature,
      tools: openaiTools,
    });

    const choice = response.choices[0];
    const rawContent = choice.message.content ?? "";
    const { thought, answer } = splitReasoning(rawContent);

    const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    return {
      content: answer,
      reasoning: thought || undefined,
      toolCalls,
    };
  }
}
