// src/core/ask-user.ts
//
// The ask_user tool: an engineer that needs something only the person has (a choice between two reasonable designs, a value, a
// decision that is hard to undo) stops and asks, the way a colleague would, instead of guessing and building on the guess.
//
// Pure helpers (parseAskArgs, canAskUser, formatAnswer, unattendedAnswer) are unit-tested in ask-user.test.ts. askUser() is the
// thin I/O part: the terminal and the dashboard race through control.ask(), first answer wins.
//
// Rules the agent is given (see knowledge/14-coding/06-ask-the-user.md): at most 3 questions per run, one question at a time, a
// default for every question, never ask what the files, the task or a sensible default already answer. When nobody can answer
// (unattended run, parallel run) the tool says so and the agent decides with the default and states the assumption.

import * as readline from "readline";
import pc from "picocolors";
import { control } from "./control";
import type { ToolSchema } from "../llm/types";

export const ASK_USER_TOOL = "ask_user";

export const askUserSchema: ToolSchema = {
  name: ASK_USER_TOOL,
  description:
    "Ask the person ONE short question when you need something only they can answer (a choice between designs, a value, an irreversible decision). Give a default. Do not ask what the files, the task or a sensible default already answers. Max 3 per run.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "One short, specific question" },
      options: { type: "array", items: { type: "string" }, description: "Optional. 2-4 short answers the person can pick by number" },
      default: { type: "string", description: "What you will do if they do not answer. Always give one" },
      why: { type: "string", description: "Optional. One line: why you cannot decide this yourself" },
    },
    required: ["question"],
  },
};

export interface AskSpec {
  question: string;
  options: string[];
  default?: string;
  why?: string;
}

export type ParsedAsk = { ok: true; value: AskSpec } | { ok: false; error: string };

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Validates the tool arguments. Keeps the question short so it fits a terminal line and a dashboard card. */
export function parseAskArgs(args: Record<string, unknown>): ParsedAsk {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (!question) return { ok: false, error: 'ask_user requires a "question".' };
  const rawOptions = Array.isArray(args.options) ? args.options : [];
  const options = rawOptions
    .filter((o): o is string => typeof o === "string" && o.trim() !== "")
    .map((o) => clip(o.trim(), 120))
    .slice(0, 4);
  const def = typeof args.default === "string" && args.default.trim() ? clip(args.default.trim(), 200) : undefined;
  const why = typeof args.why === "string" && args.why.trim() ? clip(args.why.trim(), 200) : undefined;
  return { ok: true, value: { question: clip(question, 400), options, default: def, why } };
}

/** The text shown to the person (terminal and dashboard). */
export function formatQuestion(spec: AskSpec): string {
  const lines = [spec.question];
  if (spec.why) lines.push(`(${spec.why})`);
  spec.options.forEach((o, i) => lines.push(`  ${i + 1}) ${o}`));
  if (spec.default) lines.push(`Press Enter for the default: ${spec.default}`);
  return lines.join("\n");
}

/** A typed number picks that option; empty means the default (or nothing); anything else is the answer as typed. */
export function resolveAnswer(raw: string, spec: AskSpec): { text: string; usedDefault: boolean } {
  const typed = raw.trim();
  if (!typed) return { text: spec.default ?? "", usedDefault: Boolean(spec.default) };
  if (/^\d+$/.test(typed)) {
    const idx = Number(typed) - 1;
    if (idx >= 0 && idx < spec.options.length) return { text: spec.options[idx], usedDefault: false };
  }
  return { text: typed, usedDefault: false };
}

/** What the model reads after the person answered. */
export function formatAnswer(raw: string, spec: AskSpec): string {
  const r = resolveAnswer(raw, spec);
  if (!r.text) {
    return "The person gave no answer and there is no default. Pick the safest reasonable option yourself, state the assumption in your final report, and continue.";
  }
  return r.usedDefault
    ? `The person accepted the default: "${r.text}". Continue with that.`
    : `The person answered: "${r.text}". Continue with that; do not ask the same thing again.`;
}

/** Returned when nobody is there to answer: the agent must not wait. */
export function unattendedAnswer(spec: AskSpec): string {
  return spec.default
    ? `Nobody can answer right now (unattended run). Continue with your default: "${spec.default}" and state this assumption in your final report.`
    : "Nobody can answer right now (unattended run). Pick the safest reasonable option yourself, state the assumption in your final report, and continue. If it cannot be decided safely, end with the NEEDS INPUT block.";
}

/** The refusal after the per-run limit. */
export function limitReached(used: number, max: number): string {
  return `TOOL ERROR: you already asked ${used} question(s) in this run (limit ${max}). Decide with the best default, state the assumption in your final report, or end with the NEEDS INPUT block if it cannot be decided safely.`;
}

export function maxQuestions(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AGENT_MAX_QUESTIONS);
  return Number.isFinite(n) && n >= 0 && env.AGENT_MAX_QUESTIONS !== undefined && env.AGENT_MAX_QUESTIONS !== "" ? Math.floor(n) : 3;
}

/** Someone can answer: a terminal, or a dashboard that started the run. AGENT_ASK=0 switches asking off. */
export function canAskUser(origin: string, isTTY: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AGENT_ASK === "0") return false;
  return origin === "dashboard" || isTTY;
}

// Questions are asked one at a time even when several tasks run in parallel.
let queue: Promise<unknown> = Promise.resolve();

function terminalAsk(prompt: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onAbort = () => {
      rl.close();
      reject(new Error("aborted"));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    rl.question(prompt, (answer) => {
      signal.removeEventListener("abort", onAbort);
      rl.close();
      // closing the interface pauses stdin; the rest of the CLI still needs it
      process.stdin.resume();
      resolve(answer);
    });
  });
}

/** Asks the person (terminal and dashboard race) and returns what they typed. Serialised. */
export function askUser(spec: AskSpec): Promise<string> {
  const run = async (): Promise<string> => {
    const text = formatQuestion(spec);
    console.log(`\n${pc.cyan(pc.bold("? The agent needs your input:"))}\n${text}`);
    const { answer } = await control.ask({ kind: "text", question: text, defaultValue: spec.default }, (signal) => terminalAsk(pc.cyan("> "), signal));
    return answer;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
