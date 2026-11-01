// src/llm/context-error.ts
//
// The model server refused a request because the prompt is larger than the context window it loaded the model with.
// A typed error (instead of only a message) lets the executor learn the real window from the server's own numbers,
// trim the prompt to fit and try again, instead of ending the whole run.

export class ContextOverflowError extends Error {
  readonly name = "ContextOverflowError";

  constructor(
    message: string,
    /** Tokens in the prompt, as the server counted them (undefined when the message did not say). */
    readonly promptTokens?: number,
    /** The context window the model was loaded with, in tokens (undefined when the message did not say). */
    readonly contextTokens?: number,
  ) {
    super(message);
  }
}

/** True when a server error text means "the prompt does not fit the context window". */
export function isContextOverflowText(text: string): boolean {
  return /exceeds? the available context size|context (length|size).*(exceed|too)|n_ctx|context length of only|greater than the context length/i.test(text);
}

/** Reads the two numbers out of the server's text, for example "(33307 tokens) ... (30720 tokens)". */
export function parseContextNumbers(text: string): { promptTokens?: number; contextTokens?: number } {
  const num = (m: RegExpMatchArray | null, i = 1): number | undefined => (m ? Number(m[i]) : undefined);
  const all = [...text.matchAll(/\((\d+) tokens\)/g)].map((m) => Number(m[1]));
  const prompt = num(text.match(/n_prompt_tokens\D+(\d+)/)) ?? (all.length >= 2 ? Math.max(all[0], all[1]) : all[0]);
  const ctx = num(text.match(/n_ctx\D+(\d+)/)) ?? num(text.match(/context length of only (\d+)/i)) ?? (all.length >= 2 ? Math.min(all[0], all[1]) : undefined);
  return { promptTokens: prompt, contextTokens: ctx };
}
