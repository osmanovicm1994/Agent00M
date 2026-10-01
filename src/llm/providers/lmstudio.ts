import OpenAI from "openai";
import pc from "picocolors";
import type {
  ChatMessage,
  LLMProvider,
  LLMResponse,
  ToolCall,
  ToolSchema,
} from "../types";

// Strips a <think>...</think> reasoning block (DeepSeek R1 style) out of the
// raw completion text, returning both parts separately. Some LM Studio setups
// truncate the opening <think> tag (only </think> survives), so a dangling
// closing tag is handled too. Qwen coder models simply never emit one.
function splitReasoning(raw: string): { thought: string; answer: string } {
  const fullMatch = raw.match(/<think>([\s\S]*?)<\/think>/);
  if (fullMatch) {
    const thought = fullMatch[1].trim();
    const answer = raw.replace(/<think>[\s\S]*?<\/think>/, "").trim();
    return { thought, answer };
  }

  const closingIdx = raw.indexOf("</think>");
  if (closingIdx !== -1) {
    const thought = raw.slice(0, closingIdx).trim();
    const answer = raw.slice(closingIdx + "</think>".length).trim();
    return { thought, answer };
  }

  return { thought: "", answer: raw.trim() };
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// When a reply is cut off by the token limit and we ask the model to continue,
// it often repeats the last line or two. Find the longest suffix of `prev`
// that `next` starts with (min 20 chars, to avoid false positives) and drop it.
function stitch(prev: string, next: string): string {
  const max = Math.min(300, prev.length, next.length);
  for (let n = max; n >= 20; n--) {
    if (prev.endsWith(next.slice(0, n))) return prev + next.slice(n);
  }
  return prev + next;
}

const CONTINUE_PROMPT =
  "Your previous reply was cut off by the output length limit. Continue EXACTLY from the last character " +
  "you wrote. Do not repeat any earlier text, do not restart the file, do not add commentary, and do not open " +
  "a new code fence. If you were inside a fenced block, keep writing its content and close it with the " +
  "closing fence once the content is complete.";

export interface LMStudioConfig {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  // Hard cap on generated tokens per request. Without this, LM Studio falls back
  // to its own (often small) default and long files get cut off mid-way.
  maxTokens?: number;
  timeoutMs?: number;
  // How many times to automatically continue a reply that hit the token limit.
  maxContinuations?: number;
}

interface StreamResult {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: string;
}

// LM Studio exposes an OpenAI-compatible /v1 server, so we reuse the official
// `openai` SDK — just pointed at localhost instead of api.openai.com. The same
// class works for any other OpenAI-compatible endpoint (e.g. NVIDIA NIM).
export class LMStudioProvider implements LLMProvider {
  readonly name = "lmstudio";
  readonly model: string;
  private client: OpenAI;
  private baseURL: string;
  private temperature: number;
  private maxTokens: number;
  private timeoutMs: number;
  private maxContinuations: number;
  private showProgress: boolean;

  constructor(config: LMStudioConfig = {}) {
    this.baseURL = config.baseURL ?? process.env.AI_BASE_URL ?? "http://localhost:1234/v1";
    const apiKey = config.apiKey ?? process.env.AI_API_KEY ?? "lm-studio";
    this.model = config.model ?? process.env.AI_MODEL_NAME ?? "qwen2.5-coder-32b-instruct-abliterated";
    this.temperature = config.temperature ?? envNumber("AI_TEMPERATURE", 0.2);
    this.maxTokens = config.maxTokens ?? envNumber("AI_MAX_TOKENS", 8192);
    this.timeoutMs = config.timeoutMs ?? envNumber("AI_TIMEOUT_MS", 600_000);
    this.maxContinuations = config.maxContinuations ?? envNumber("AI_MAX_CONTINUATIONS", 6);
    this.showProgress = process.env.AI_STREAM_PROGRESS !== "0" && Boolean(process.stdout.isTTY);

    this.client = new OpenAI({ baseURL: this.baseURL, apiKey, maxRetries: 1 });
  }

  private toOpenAIMessages(messages: ChatMessage[]): any[] {
    return messages.map((m) => {
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
  }

  // One streamed completion. Streaming keeps the connection alive for long
  // generations and lets us show progress instead of a frozen terminal.
  private async streamOnce(messages: any[], tools?: ToolSchema[]): Promise<StreamResult> {
    const openaiTools = tools?.length
      ? tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      : undefined;

    let stream: AsyncIterable<any>;
    try {
      stream = (await this.client.chat.completions.create(
        {
          model: this.model,
          messages,
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          tools: openaiTools,
          stream: true,
        } as any,
        { timeout: this.timeoutMs },
      )) as unknown as AsyncIterable<any>;
    } catch (err: any) {
      throw this.friendlyError(err);
    }

    let content = "";
    let finishReason = "stop";
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let lastTick = 0;

    try {
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;

        if (delta?.content) {
          content += delta.content;
          if (this.showProgress && Date.now() - lastTick > 400) {
            lastTick = Date.now();
            process.stdout.write(`\r${pc.dim(`  generating… ${content.length} chars`)}`);
          }
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            let entry = toolAcc.get(idx);
            if (!entry) {
              entry = { id: "", name: "", args: "" };
              toolAcc.set(idx, entry);
            }
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name && !entry.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
          }
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (err: any) {
      throw this.friendlyError(err);
    } finally {
      if (this.showProgress) process.stdout.write("\x1b[2K\r");
    }

    const toolCalls: ToolCall[] | undefined = toolAcc.size
      ? [...toolAcc.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([idx, e]) => ({
            id: e.id || `call-${Date.now()}-${idx}`,
            name: e.name,
            arguments: e.args || "{}",
          }))
      : undefined;

    return { content, toolCalls, finishReason };
  }

  private friendlyError(err: any): Error {
    const code = err?.code ?? err?.cause?.code;
    if (err?.name === "APIConnectionError" || code === "ECONNREFUSED" || code === "ENOTFOUND") {
      return new Error(
        `Could not reach the LLM server at ${this.baseURL}. Is LM Studio's local server running with the model ` +
          `"${this.model}" loaded? (${err?.message ?? code})`,
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  async chat(messages: ChatMessage[], tools?: ToolSchema[]): Promise<LLMResponse> {
    const base = this.toOpenAIMessages(messages);

    let raw = "";
    let toolCalls: ToolCall[] | undefined;
    let finishReason = "stop";

    for (let attempt = 0; attempt <= this.maxContinuations; attempt++) {
      const requestMessages =
        attempt === 0
          ? base
          : [...base, { role: "assistant", content: raw }, { role: "user", content: CONTINUE_PROMPT }];

      // Tools are only offered on the first request; a continuation must keep
      // writing text, not switch to a tool call.
      const result = await this.streamOnce(requestMessages, attempt === 0 ? tools : undefined);

      raw = attempt === 0 ? result.content : stitch(raw, result.content);
      finishReason = result.finishReason;

      if (result.toolCalls?.length) {
        // Native tool calls can't be stitched together; if their JSON arguments
        // were cut off the executor reports that to the model.
        toolCalls = result.toolCalls;
        break;
      }
      if (finishReason !== "length") break;

      if (attempt < this.maxContinuations) {
        console.log(
          pc.dim(`  (output hit the ${this.maxTokens}-token limit — continuing ${attempt + 1}/${this.maxContinuations})`),
        );
      }
    }

    const { thought, answer } = splitReasoning(raw);

    return {
      content: answer,
      reasoning: thought || undefined,
      toolCalls,
      finishReason,
    };
  }
}
