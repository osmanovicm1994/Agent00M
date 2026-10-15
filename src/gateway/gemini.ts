// src/gateway/gemini.ts
//
// Thin wrapper around the official @google/genai SDK that turns "system instruction + user
// content" into a validated TriagePlan, with the failure handling a CLI needs:
//  - model fallback chain (model ids get retired; a 404 moves on to the next candidate),
//  - one retry for timeouts, 429 and 5xx,
//  - a retry without the response schema if the API rejects it,
//  - a hard timeout through AbortController,
//  - strict validation of the JSON that comes back.
//
// The SDK is loaded lazily with a native dynamic import. Why:
//  - the agent still starts when triage is off and the package is not installed,
//  - the package is ESM-first and this project compiles to CommonJS with moduleResolution "node",
//    so a static import would not resolve its types and a compiled import() becomes require().

import { buildSystemInstruction, type AgentInfo } from "./instruction";
import { buildResponseSchema, planSchema, type TriagePlan } from "./types";

export class TriageError extends Error {
  constructor(
    message: string,
    /** True when retrying or trying another model cannot help (bad key, no SDK). */
    readonly fatal = false,
  ) {
    super(message);
    this.name = "TriageError";
  }
}

// Minimal structural types for the parts of the SDK we use (the real types are not imported).
interface GenAIClient {
  models: {
    generateContent(request: unknown): Promise<{ text?: string; candidates?: Array<{ groundingMetadata?: any }> }>;
    list(request?: unknown): Promise<AsyncIterable<{ name?: string; supportedActions?: string[] }>>;
  };
}

// A real dynamic import(): TypeScript would otherwise compile it to require() under CommonJS.
const nativeImport = new Function("specifier", "return import(specifier)") as unknown as (specifier: string) => Promise<any>;

/**
 * Candidate models, best first. Override with GEMINI_MODEL (and GEMINI_FALLBACK_MODELS, comma separated).
 * Model ids are retired over time: `npm run triage:models` lists what your key can use.
 */
// gemini-2.5-flash answers 404 "no longer available to new users", so it is not in the default chain.
// Several ids because each model is overloaded (503) at different times; "-latest" aliases survive retirements.
// Order: the one that answered reliably in testing first; the newest ones are often overloaded.
export const DEFAULT_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.8-flash",
  "gemini-flash-latest",
];

/**
 * Optional limit on the model's hidden reasoning, the main cause of slow answers.
 *  - GEMINI_THINKING_LEVEL=minimal|low|medium|high  (Gemini 3.x)
 *  - GEMINI_THINKING_BUDGET=<tokens>                (Gemini 2.5 style; 0 = off)
 * Unset = the model's default. If the API rejects the setting, unset it.
 */
function thinkingConfig(): Record<string, unknown> {
  const level = process.env.GEMINI_THINKING_LEVEL?.trim().toLowerCase();
  if (level) return { thinkingConfig: { thinkingLevel: level } };
  const budget = process.env.GEMINI_THINKING_BUDGET?.trim();
  if (budget && Number.isFinite(Number(budget))) return { thinkingConfig: { thinkingBudget: Number(budget) } };
  return {};
}

export function resolveModels(): string[] {
  const primary = process.env.GEMINI_MODEL?.trim();
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const chain = primary ? [primary, ...(fallbacks.length ? fallbacks : DEFAULT_MODELS)] : fallbacks.length ? fallbacks : DEFAULT_MODELS;
  return [...new Set(chain)];
}

type ErrorKind = "fatal" | "model" | "schema" | "transient" | "timeout" | "parse" | "unknown";

function classify(err: any): ErrorKind {
  const status: number | undefined = typeof err?.status === "number" ? err.status : typeof err?.code === "number" ? err.code : undefined;
  const msg = String(err?.message ?? err);

  if (err?.name === "TriageParseError" || err?.name === "ZodError" || err instanceof SyntaxError) return "parse";
  if (err?.name === "TriageTimeout") return "timeout";
  if (err?.name === "AbortError" || /\baborted\b|timed? ?out|ETIMEDOUT|ECONNRESET|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(msg)) return "transient";
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i.test(msg)) return "fatal";
  if (status === 404 || /\bnot found\b|no longer available|not supported for generateContent|has been deprecated|is not available/i.test(msg)) return "model";
  if (status === 400 && /schema|responseJsonSchema|response_json_schema|responseSchema|unknown name|mime/i.test(msg)) return "schema";
  if (status === 429 || (status !== undefined && status >= 500) || /RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded/i.test(msg)) return "transient";
  return "unknown";
}

function parseError(message: string): Error {
  const e = new Error(message);
  e.name = "TriageParseError";
  return e;
}

/** Accepts plain JSON or JSON wrapped in a Markdown fence, then validates the shape. */
export function parsePlan(raw: string): TriagePlan {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw parseError("Gemini returned no JSON object");
  return planSchema.parse(JSON.parse(cleaned.slice(start, end + 1)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Google Search grounding quota ---------------------------------------------------------------------------
// Grounding with Google Search is billed separately from plain generation. On the free tier the allowance for the
// Gemini 3.x models is a small monthly pool shared by all of them; once it is used up every grounded request answers
// 429 RESOURCE_EXHAUSTED while ordinary requests keep working. Remember that for a while instead of failing again and
// again, and let the callers degrade (the research stage continues without Google Search; web_search says why it
// cannot search and the agent stops retrying).
let groundingBlockedUntil = 0;
let groundingBlockReason = "";

export const QUOTA_HINT =
  "Google Search grounding quota or rate limit reached (HTTP 429). On the free tier the Gemini 3.x models share one small monthly allowance for " +
  "Google Search; check the usage in Google AI Studio (Rate limits) or enable billing. Plain Gemini requests still work.";

export function isQuotaError(err: any): boolean {
  const status: number | undefined = typeof err?.status === "number" ? err.status : typeof err?.code === "number" ? err.code : undefined;
  return status === 429 || /RESOURCE_EXHAUSTED|exceeded your current quota|quota exceeded/i.test(String(err?.message ?? err));
}

export function blockGrounding(reason: string): void {
  const ms = Number(process.env.AGENT_GROUNDING_BLOCK_MS) || 5 * 60_000;
  groundingBlockedUntil = Date.now() + ms;
  groundingBlockReason = reason.slice(0, 400);
}

export function groundingStatus(): { blocked: boolean; secondsLeft: number; reason: string } {
  const left = groundingBlockedUntil - Date.now();
  return left > 0 ? { blocked: true, secondsLeft: Math.ceil(left / 1000), reason: groundingBlockReason } : { blocked: false, secondsLeft: 0, reason: "" };
}

export class GeminiTriageClient {
  private client?: GenAIClient;
  private activeModel?: string;
  private schemaSupported = true;
  private readonly models: string[];
  private readonly timeoutMs: number;

  constructor(opts: { models?: string[]; timeoutMs?: number } = {}) {
    this.models = opts.models ?? resolveModels();
    this.timeoutMs = opts.timeoutMs ?? (Number(process.env.AGENT_TRIAGE_TIMEOUT_MS) || 60_000);
  }

  /** The SDK reads GEMINI_API_KEY by itself; GOOGLE_API_KEY is accepted too. */
  static resolveApiKey(): string | undefined {
    return process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || undefined;
  }

  private async getClient(): Promise<GenAIClient> {
    if (this.client) return this.client;
    const apiKey = GeminiTriageClient.resolveApiKey();
    if (!apiKey) throw new TriageError("GEMINI_API_KEY is not set", true);

    let sdk: any;
    try {
      sdk = await nativeImport("@google/genai");
    } catch (err: any) {
      throw new TriageError(`The @google/genai package could not be loaded (${err?.message ?? err}). Run: npm install @google/genai`, true);
    }
    this.client = new sdk.GoogleGenAI({ apiKey }) as GenAIClient;
    return this.client;
  }

  private async callOnce(
    client: GenAIClient,
    model: string,
    systemInstruction: string,
    userContent: string,
    schema?: Record<string, unknown>,
  ): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await client.models.generateContent({
        model,
        contents: userContent,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          ...(schema ? { responseJsonSchema: schema } : {}),
          // Room for the model's own reasoning plus the plan; a plan cut off mid-JSON is useless.
          maxOutputTokens: 8192,
          ...thinkingConfig(),
          abortSignal: controller.signal,
        },
      });
      return response.text ?? "";
    } catch (err: any) {
      if (timedOut) {
        const e = new Error(
          `no answer within ${Math.round(this.timeoutMs / 1000)}s (raise AGENT_TRIAGE_TIMEOUT_MS, check your network/proxy, or run: npm run triage:models -- --test)`,
        );
        e.name = "TriageTimeout";
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Returns a validated plan, or throws TriageError describing why no model could produce one. */
  async generatePlan(userContent: string, toolNames: string[], agents: AgentInfo[]): Promise<{ plan: TriagePlan; model: string }> {
    const client = await this.getClient();
    const systemInstruction = buildSystemInstruction(agents);
    const schema = buildResponseSchema(
      toolNames,
      agents.map((a) => a.id),
    );

    const order = this.activeModel ? [this.activeModel, ...this.models.filter((m) => m !== this.activeModel)] : this.models;
    let lastError = "no attempt was made";

    for (const model of order) {
      let attempts = 0;
      while (attempts < 3) {
        attempts++;
        try {
          const raw = await this.callOnce(client, model, systemInstruction, userContent, this.schemaSupported ? schema : undefined);
          const plan = parsePlan(raw);
          this.activeModel = model;
          return { plan, model };
        } catch (err: any) {
          const message = String(err?.message ?? err).split("\n")[0].slice(0, 300);
          lastError = `${model}: ${message}`;
          const kind = classify(err);

          if (kind === "fatal") throw new TriageError(`Gemini rejected the request (${message}). Check GEMINI_API_KEY and that the API is enabled for it.`, true);
          if (kind === "model" || kind === "timeout") break; // retired, unavailable or too slow: next candidate (no second wait)
          if (kind === "schema" && this.schemaSupported) {
            // The API did not accept the response schema: ask again with the JSON instruction only.
            this.schemaSupported = false;
            attempts--;
            continue;
          }
          if (kind === "transient" && attempts < 3) {
            // 503 "high demand" spikes are usually short: back off 2s, then 4s.
            await sleep(2000 * attempts);
            continue;
          }
          if (kind === "parse" && attempts < 2) continue;
          if (kind === "unknown") throw new TriageError(message);
          break; // out of retries for this model
        }
      }
    }
    throw new TriageError(`No Gemini model produced a usable plan (tried ${order.join(", ")}). Last error: ${lastError}`);
  }

  /**
   * One free-form Gemini answer (text or JSON) through the model chain. Used for the team's lead roles
   * (Project Manager, UX): thinking steps that need no repository access.
   */
  async generateText(systemInstruction: string, userContent: string, opts: { json?: boolean; maxTokens?: number } = {}): Promise<{ text: string; model: string }> {
    const client = await this.getClient();
    const order = this.activeModel ? [this.activeModel, ...this.models.filter((m) => m !== this.activeModel)] : this.models;
    let lastError = "no attempt was made";

    for (const model of order) {
      let attempts = 0;
      while (attempts < 2) {
        attempts++;
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, this.timeoutMs);
        try {
          const response = await client.models.generateContent({
            model,
            contents: userContent,
            config: {
              systemInstruction,
              ...(opts.json ? { responseMimeType: "application/json" } : {}),
              maxOutputTokens: opts.maxTokens ?? 8192,
              ...thinkingConfig(),
              abortSignal: controller.signal,
            },
          });
          const text = (response.text ?? "").trim();
          if (!text) throw new Error("empty answer");
          this.activeModel = model;
          return { text, model };
        } catch (err: any) {
          const message = timedOut ? "no answer in time" : String(err?.message ?? err).split("\n")[0].slice(0, 300);
          lastError = `${model}: ${message}`;
          const kind = timedOut ? "timeout" : classify(err);
          if (kind === "fatal") throw new TriageError(`Gemini rejected the request (${message}). Check GEMINI_API_KEY.`, true);
          if (kind === "transient" && attempts < 2) {
            await sleep(2000);
            continue;
          }
          break; // next model
        } finally {
          clearTimeout(timer);
        }
      }
    }
    throw new TriageError(`No Gemini model answered (tried ${order.join(", ")}). Last error: ${lastError}`);
  }

  /**
   * Web search through Gemini's built-in Google Search grounding: returns the pages Google found for `query`
   * (title, URL, and the sentence of the answer each page supports). Needs only the existing GEMINI_API_KEY.
   * The URLs are Google redirect links; the caller resolves them.
   */
  async groundedSearch(query: string): Promise<{ sources: Array<{ title: string; url: string; snippet: string }>; model: string }> {
    const client = await this.getClient();
    const order = this.activeModel ? [this.activeModel, ...this.models.filter((m) => m !== this.activeModel)] : this.models;
    const timeoutMs = Math.min(this.timeoutMs, 25_000);
    const paused = groundingStatus();
    if (paused.blocked) throw new TriageError(`Google Search grounding is paused for another ${paused.secondsLeft}s. ${paused.reason}`);
    const errors: string[] = [];
    const quotaLimit = Math.min(2, order.length);
    let quotaHits = 0;
    let lastError = "no attempt was made";

    for (const model of order) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const response = await client.models.generateContent({
          model,
          contents: `Search the web for: ${query}\nName the most relevant, authoritative pages (official documentation first) and say in one sentence what each one explains.`,
          config: { tools: [{ googleSearch: {} }], maxOutputTokens: 2048, ...thinkingConfig(), abortSignal: controller.signal },
        });
        const meta = response.candidates?.[0]?.groundingMetadata;
        const chunks: any[] = meta?.groundingChunks ?? [];
        const supports: any[] = meta?.groundingSupports ?? [];
        const sources: Array<{ title: string; url: string; snippet: string }> = [];
        chunks.forEach((c, i) => {
          const web = c?.web;
          if (!web?.uri) return;
          const snippet = supports
            .filter((s) => (s?.groundingChunkIndices ?? []).includes(i))
            .map((s) => String(s?.segment?.text ?? "").trim())
            .filter(Boolean)
            .join(" ")
            .slice(0, 400);
          sources.push({ title: String(web.title ?? web.uri), url: String(web.uri), snippet });
        });
        if (!sources.length) throw new Error("Gemini returned no web sources for this query");
        this.activeModel = model;
        return { sources, model };
      } catch (err: any) {
        const message = timedOut ? "no answer in time" : String(err?.message ?? err).split("\n")[0].slice(0, 300);
        lastError = `${model}: ${message}`;
        if (!errors.includes(message)) errors.push(message);
        if (!timedOut && classify(err) === "fatal") throw new TriageError(`Gemini rejected the request (${message}). Check GEMINI_API_KEY.`, true);
        if (!timedOut && isQuotaError(err) && ++quotaHits >= quotaLimit) {
          // Out of quota on two models in a row: the allowance is shared, so more tries only waste time.
          blockGrounding(`${QUOTA_HINT} (${message})`);
          break;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    if (quotaHits >= quotaLimit) throw new TriageError(`${QUOTA_HINT} Details: ${errors.slice(0, 2).join(" | ")}`);
    throw new TriageError(`Gemini search failed (tried ${order.join(", ")}). Errors: ${errors.slice(0, 3).join(" | ") || lastError}`);
  }

  /**
   * Free-text answer about one image (used by `/image` to turn a screenshot or mockup into a design brief).
   * Tries the model chain; overloaded, slow or retired models are skipped.
   */
  async describeImage(systemInstruction: string, prompt: string, mimeType: string, base64: string): Promise<{ text: string; model: string }> {
    const client = await this.getClient();
    const order = this.activeModel ? [this.activeModel, ...this.models.filter((m) => m !== this.activeModel)] : this.models;
    let lastError = "no attempt was made";

    for (const model of order) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs * 2);
      try {
        const response = await client.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }],
          config: { systemInstruction, maxOutputTokens: 4096, ...thinkingConfig(), abortSignal: controller.signal },
        });
        const text = (response.text ?? "").trim();
        if (!text) throw new Error("empty answer");
        this.activeModel = model;
        return { text, model };
      } catch (err: any) {
        const message = controller.signal.aborted ? "no answer in time" : String(err?.message ?? err).split("\n")[0].slice(0, 300);
        lastError = `${model}: ${message}`;
        if (!controller.signal.aborted && classify(err) === "fatal") {
          throw new TriageError(`Gemini rejected the request (${message}). Check GEMINI_API_KEY.`, true);
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw new TriageError(`No Gemini model could read the image (tried ${order.join(", ")}). Last error: ${lastError}`);
  }

  /**
   * The research stage (see src/research): one Gemini call that may search Google (grounding) while it works out what the
   * request really is. Grounding cannot be combined with a JSON response mode on every model, so with grounding the answer
   * is free text that the caller parses; without grounding the JSON mode is used instead.
   * Returns the answer plus the pages and search queries Google used (the page links are Google redirect links).
   */
  async research(
    systemInstruction: string,
    userContent: string,
    opts: { grounding?: boolean; maxTokens?: number } = {},
  ): Promise<{ text: string; sources: Array<{ title: string; url: string }>; queries: string[]; model: string; grounded: boolean; note?: string }> {
    const client = await this.getClient();
    const order = this.activeModel ? [this.activeModel, ...this.models.filter((m) => m !== this.activeModel)] : this.models;
    let grounded = opts.grounding !== false;
    let note: string | undefined;
    if (grounded && groundingStatus().blocked) {
      grounded = false;
      note = "Google Search grounding is paused (quota reached): this brief comes from the model's own knowledge, not from a search.";
    }
    const timeoutMs = Number(process.env.AGENT_RESEARCH_TIMEOUT_MS) || this.timeoutMs;
    let lastError = "no attempt was made";

    for (const model of order) {
      let attempts = 0;
      while (attempts < 2) {
        attempts++;
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        try {
          const response = await client.models.generateContent({
            model,
            contents: userContent,
            config: {
              systemInstruction,
              ...(grounded ? { tools: [{ googleSearch: {} }] } : { responseMimeType: "application/json" }),
              maxOutputTokens: opts.maxTokens ?? 8192,
              ...thinkingConfig(),
              abortSignal: controller.signal,
            },
          });
          const text = (response.text ?? "").trim();
          if (!text) throw new Error("empty answer");

          const meta = response.candidates?.[0]?.groundingMetadata;
          const seen = new Set<string>();
          const sources: Array<{ title: string; url: string }> = [];
          for (const chunk of (meta?.groundingChunks ?? []) as any[]) {
            const web = chunk?.web;
            if (!web?.uri || seen.has(String(web.uri))) continue;
            seen.add(String(web.uri));
            sources.push({ title: String(web.title ?? web.uri), url: String(web.uri) });
          }
          const queries = ((meta?.webSearchQueries ?? []) as unknown[]).map((q) => String(q)).filter(Boolean);

          this.activeModel = model;
          return { text, sources, queries, model, grounded, note };
        } catch (err: any) {
          const message = timedOut ? "no answer in time" : String(err?.message ?? err).split("\n")[0].slice(0, 300);
          lastError = `${model}: ${message}`;
          if (grounded && !timedOut && isQuotaError(err)) {
            // The Google Search allowance is used up: carry on with the same model WITHOUT searching instead of failing the stage.
            blockGrounding(`${QUOTA_HINT} (${message})`);
            grounded = false;
            note = "Google Search grounding quota reached (HTTP 429): this brief comes from the model's own knowledge, not from a search.";
            attempts--;
            continue;
          }
          const kind = timedOut ? "timeout" : classify(err);
          if (kind === "fatal") throw new TriageError(`Gemini rejected the request (${message}). Check GEMINI_API_KEY and that the API is enabled for it.`, true);
          if (kind === "transient" && attempts < 2) {
            await sleep(2000);
            continue;
          }
          break; // retired, too slow or out of retries: next model
        } finally {
          clearTimeout(timer);
        }
      }
    }
    throw new TriageError(`No Gemini model finished the research step (tried ${order.join(", ")}). Last error: ${lastError}`);
  }

  /** Tiny real request per model: tells you which ids work and how long they take (for `triage-models --test`). */
  async ping(model: string, timeoutMs = 30_000): Promise<{ ok: boolean; ms: number; detail: string }> {
    const client = await this.getClient();
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await client.models.generateContent({
        model,
        contents: "Reply with the single word: ready",
        config: { maxOutputTokens: 256, ...thinkingConfig(), abortSignal: controller.signal },
      });
      return { ok: true, ms: Date.now() - started, detail: String(res.text ?? "").trim().slice(0, 40) };
    } catch (err: any) {
      const detail = controller.signal.aborted ? `no answer within ${timeoutMs / 1000}s` : String(err?.message ?? err).split("\n")[0].slice(0, 200);
      return { ok: false, ms: Date.now() - started, detail };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Model ids the key can call generateContent on (for `triage-models`). */
  async listModels(): Promise<string[]> {
    const client = await this.getClient();
    const pager = await client.models.list();
    const ids: string[] = [];
    for await (const m of pager) {
      if (m.supportedActions && !m.supportedActions.includes("generateContent")) continue;
      if (m.name) ids.push(m.name.replace(/^models\//, ""));
    }
    return ids.sort();
  }
}
