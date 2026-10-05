import OpenAI from "openai";
import pc from "picocolors";
import type {
  ChatMessage,
  ChatOptions,
  LLMProvider,
  LLMResponse,
  LLMStats,
  ToolCall,
  ToolSchema,
} from "../types";
import { getProfile, resolveNativeTools, resolveNoThink, type ModelProfile } from "../models";

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

// Rough chars-per-token for code, used only when the server reports no usage.
const CHARS_PER_TOKEN = 3.5;

// How tool results are labelled for models without a tool template (see toPlainMessages).
// Also used as a stop sequence so such a model cannot invent a tool's answer itself.
const TOOL_RESULT_PREFIX = "Tool result (";

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
  // Print a "first token / tok/s" line after every call (default: on, AI_STATS=0 turns it off).
  printStats?: boolean;
  // Force the tool protocol regardless of the model profile (used by `bench` to probe a model).
  nativeTools?: boolean;
}

interface StreamResult {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: string;
  // Absolute timestamp of the first generated token (content, reasoning or tool call).
  firstTokenAt: number | null;
  outChars: number;
  // completion_tokens as reported by the server, if it sent usage.
  usageTokens?: number;
}

// LM Studio exposes an OpenAI-compatible /v1 server, so we reuse the official
// `openai` SDK — just pointed at localhost instead of api.openai.com. The same
// class works for any other OpenAI-compatible endpoint (e.g. NVIDIA NIM).
export class LMStudioProvider implements LLMProvider {
  readonly name = "lmstudio";
  private client: OpenAI;
  private baseURL: string;
  private modelId: string;
  private profile: ModelProfile;
  private temperatureOverride?: number;
  private maxTokens: number;
  private timeoutMs: number;
  private maxContinuations: number;
  private showProgress: boolean;
  private printStats: boolean;
  private nativeOverride?: boolean;

  constructor(config: LMStudioConfig = {}) {
    this.baseURL = config.baseURL ?? process.env.AI_BASE_URL ?? "http://localhost:1234/v1";
    const apiKey = config.apiKey ?? process.env.AI_API_KEY ?? "lm-studio";
    this.modelId = config.model ?? process.env.AI_MODEL_NAME ?? "qwen2.5-coder-32b-instruct-abliterated";
    this.profile = getProfile(this.modelId);

    const envTemp = process.env.AI_TEMPERATURE;
    const parsedTemp = envTemp !== undefined && envTemp.trim() !== "" ? Number(envTemp) : NaN;
    this.temperatureOverride = config.temperature ?? (Number.isFinite(parsedTemp) ? parsedTemp : undefined);

    this.maxTokens = config.maxTokens ?? envNumber("AI_MAX_TOKENS", 8192);
    this.timeoutMs = config.timeoutMs ?? envNumber("AI_TIMEOUT_MS", 600_000);
    this.maxContinuations = config.maxContinuations ?? envNumber("AI_MAX_CONTINUATIONS", 6);
    this.showProgress = process.env.AI_STREAM_PROGRESS !== "0" && Boolean(process.stdout.isTTY);
    this.printStats = config.printStats ?? process.env.AI_STATS !== "0";
    this.nativeOverride = config.nativeTools;

    this.client = new OpenAI({ baseURL: this.baseURL, apiKey, maxRetries: 1 });
  }

  get model(): string {
    return this.modelId;
  }

  get nativeTools(): boolean {
    return this.nativeOverride ?? resolveNativeTools(this.profile);
  }

  get profileNote(): string {
    return this.profile.note;
  }

  private get temperature(): number {
    return this.temperatureOverride ?? this.profile.temperature;
  }

  /** Switch model at runtime (LM Studio loads it on the first request). */
  setModel(id: string): void {
    this.modelId = id;
    this.profile = getProfile(id);
  }

  /** Model ids currently offered by the server. */
  async listModels(): Promise<string[]> {
    try {
      const page = await this.client.models.list();
      return page.data.map((m) => m.id).sort();
    } catch (err: any) {
      throw this.friendlyError(err);
    }
  }

  // Qwen3 hybrid models: a "/no_think" soft switch in the (stable) system
  // message turns thinking off without touching the rest of the prefix.
  private withModeHints(messages: ChatMessage[]): ChatMessage[] {
    if (!resolveNoThink(this.profile)) return messages;
    const idx = messages.findIndex((m) => m.role === "system");
    if (idx === -1) return messages;
    const copy = messages.slice();
    copy[idx] = { ...copy[idx], content: `${copy[idx].content}\n\n/no_think` };
    return copy;
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

  // For models without a tool template: flatten the history to plain text.
  // Strict chat templates (Mistral/Codestral, Phi) reject the `tool` role and
  // assistant `tool_calls`, and require user/assistant alternation, so tool
  // results become user text and consecutive same-role messages are merged.
  private toPlainMessages(messages: ChatMessage[]): any[] {
    const names = new Map<string, string>();
    for (const m of messages) for (const tc of m.toolCalls ?? []) names.set(tc.id, tc.name);

    const out: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
    const push = (role: "system" | "user" | "assistant", content: string) => {
      const last = out[out.length - 1];
      if (last && last.role === role && role !== "system") last.content += `\n\n${content}`;
      else out.push({ role, content });
    };

    const describeCall = (tc: ToolCall): string => {
      let detail = "";
      try {
        const a = JSON.parse(tc.arguments);
        if (typeof a?.path === "string") detail = ` ${a.path}`;
      } catch {
        // arguments not JSON; name only
      }
      return `[called ${tc.name}${detail}]`;
    };

    for (const m of messages) {
      if (m.role === "tool") {
        push("user", `${TOOL_RESULT_PREFIX}${names.get(m.toolCallId ?? "") ?? "tool"}):\n${m.content}`);
      } else if (m.role === "assistant") {
        let content = m.content;
        if (!content.trim() && m.toolCalls?.length) content = m.toolCalls.map(describeCall).join("\n");
        push("assistant", content || "(no output)");
      } else {
        push(m.role, m.content);
      }
    }
    return out;
  }

  // One streamed completion. Streaming keeps the connection alive for long
  // generations, lets us show progress, and gives us a real time-to-first-token.
  private async streamOnce(messages: any[], tools?: ToolSchema[], options: ChatOptions = {}): Promise<StreamResult> {
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
          model: this.modelId,
          messages,
          temperature: options.temperature ?? this.temperature,
          max_tokens: options.maxTokens ?? this.maxTokens,
          tools: openaiTools,
          // Models without a tool template sometimes keep writing and invent the tool's answer.
          stop: this.nativeTools ? undefined : [`\n${TOOL_RESULT_PREFIX}`],
          stream: true,
        } as any,
        { timeout: this.timeoutMs },
      )) as unknown as AsyncIterable<any>;
    } catch (err: any) {
      throw this.friendlyError(err);
    }

    let content = "";
    let finishReason = "stop";
    let firstTokenAt: number | null = null;
    let outChars = 0;
    let usageTokens: number | undefined;
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let lastTick = 0;

    const mark = (chars: number) => {
      if (firstTokenAt === null) firstTokenAt = Date.now();
      outChars += chars;
    };

    try {
      for await (const chunk of stream) {
        if (typeof chunk.usage?.completion_tokens === "number") usageTokens = chunk.usage.completion_tokens;

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;

        // Separate reasoning stream (LM Studio can split <think> into reasoning_content).
        if (delta?.reasoning_content) mark(String(delta.reasoning_content).length);

        if (delta?.content) {
          content += delta.content;
          mark(delta.content.length);
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
            if (tc.function?.arguments) {
              entry.args += tc.function.arguments;
              mark(tc.function.arguments.length);
            } else {
              mark(0);
            }
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

    return { content, toolCalls, finishReason, firstTokenAt, outChars, usageTokens };
  }

  private friendlyError(err: any): Error {
    const code = err?.code ?? err?.cause?.code;
    if (err?.name === "APIConnectionError" || code === "ECONNREFUSED" || code === "ENOTFOUND") {
      return new Error(
        `Could not reach the LLM server at ${this.baseURL}. Is LM Studio's local server running with the model ` +
          `"${this.modelId}" loaded? (${err?.message ?? code})`,
      );
    }
    const text = String(err?.message ?? err);
    if (/exceeds? the available context size|context (length|size).*(exceed|too)|n_ctx/i.test(text)) {
      const used = text.match(/\((\d+) tokens\)/)?.[1] ?? text.match(/n_prompt_tokens\D+(\d+)/)?.[1];
      const limit = text.match(/n_ctx\D+(\d+)/)?.[1] ?? text.match(/\((\d+) tokens\)\s*\D*?(\d+) tokens/)?.[2];
      return new Error(
        `The prompt${used ? ` (${used} tokens)` : ""} does not fit the context window LM Studio loaded the model with` +
          `${limit ? ` (${limit} tokens)` : ""}. Fix: in LM Studio unload the model and reload it with "Context Length" ` +
          `at 32768 (16384 minimum); the agent cannot change this from outside. ` +
          `Alternatively lower AGENT_CONTEXT_CHARS and AGENT_SKILL_CHARS in your .env file.`,
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private logStats(stats: LLMStats): void {
    if (!this.printStats || stats.outTokens < 8) return;
    const approx = stats.estimated ? "~" : "";
    const speed = stats.tokPerSec > 0 ? ` · ${approx}${stats.tokPerSec.toFixed(1)} tok/s` : "";
    console.log(
      pc.dim(
        `  ⏱ first token ${(stats.ttftMs / 1000).toFixed(1)}s · ${approx}${stats.outTokens} tokens in ${(stats.totalMs / 1000).toFixed(1)}s${speed}`,
      ),
    );
  }

  async chat(messages: ChatMessage[], tools?: ToolSchema[], options: ChatOptions = {}): Promise<LLMResponse> {
    const hinted = this.withModeHints(messages);
    const base = this.nativeTools ? this.toOpenAIMessages(hinted) : this.toPlainMessages(hinted);
    // Models without a tool template get no `tools` payload at all: it saves
    // prompt tokens on every turn and avoids template errors.
    const useTools = this.nativeTools ? tools : undefined;

    const t0 = Date.now();
    let ttftAt: number | null = null;
    let outChars = 0;
    let usageTotal = 0;
    let usageSeen = false;

    let raw = "";
    let toolCalls: ToolCall[] | undefined;
    let finishReason = "stop";

    // An explicit maxTokens (router, bench) means a deliberately short answer: never continue it.
    const maxContinuations = options.maxTokens !== undefined ? 0 : this.maxContinuations;

    for (let attempt = 0; attempt <= maxContinuations; attempt++) {
      const requestMessages =
        attempt === 0
          ? base
          : [...base, { role: "assistant", content: raw }, { role: "user", content: CONTINUE_PROMPT }];

      // Tools are only offered on the first request; a continuation must keep
      // writing text, not switch to a tool call.
      const result = await this.streamOnce(requestMessages, attempt === 0 ? useTools : undefined, options);

      if (ttftAt === null && result.firstTokenAt !== null) ttftAt = result.firstTokenAt;
      outChars += result.outChars;
      if (result.usageTokens !== undefined) {
        usageSeen = true;
        usageTotal += result.usageTokens;
      }

      raw = attempt === 0 ? result.content : stitch(raw, result.content);
      finishReason = result.finishReason;

      if (result.toolCalls?.length) {
        // Native tool calls can't be stitched together; if their JSON arguments
        // were cut off the executor reports that to the model.
        toolCalls = result.toolCalls;
        break;
      }
      if (finishReason !== "length") break;

      if (attempt < maxContinuations) {
        console.log(
          pc.dim(`  (output hit the ${this.maxTokens}-token limit — continuing ${attempt + 1}/${maxContinuations})`),
        );
      }
    }

    const end = Date.now();
    const totalMs = end - t0;
    const ttftMs = (ttftAt ?? end) - t0;
    const outTokens = usageSeen ? usageTotal : Math.round(outChars / CHARS_PER_TOKEN);
    const genMs = Math.max(1, totalMs - ttftMs);
    const stats: LLMStats = {
      ttftMs,
      totalMs,
      outTokens,
      tokPerSec: outTokens >= 8 ? outTokens / (genMs / 1000) : 0,
      estimated: !usageSeen,
    };
    this.logStats(stats);

    const { thought, answer } = splitReasoning(raw);

    return {
      content: answer,
      reasoning: thought || undefined,
      toolCalls,
      finishReason,
      stats,
    };
  }
}
