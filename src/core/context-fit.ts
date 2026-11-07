// src/core/context-fit.ts
//
// Keeps one request inside the context window the model server loaded the model with. The window is a fact of the
// server (LM Studio "Context Length"), not of the agent; when the prompt is larger the server refuses it and the whole
// run used to end. This module is pure (no model calls, no I/O): it measures the prompt, and trims it in a fixed
// order of importance:
//   1. old tool outputs and old assistant messages (they can be fetched again),
//   2. the middle of the system prompt (the knowledge standards; the rules at both ends stay),
//   3. the middle of the first user message (project tree, task, assignment; head and tail stay).
// Nothing is dropped silently: every cut leaves a marker that says so.

import type { ChatMessage } from "../llm/types";

/** Window assumed until the server says otherwise (AGENT_CONTEXT_WINDOW, or learned from a refusal). */
export const DEFAULT_WINDOW = 32768;
/** Characters per token used for planning. Code and JSON run near 3; this errs on the safe side. */
export const DEFAULT_CHARS_PER_TOKEN = 3.2;

let learnedWindow: number | undefined;
let learnedCharsPerToken: number | undefined;

/** Called when the server named the window it really has. */
export function learnWindow(tokens: number | undefined): void {
  if (tokens && Number.isFinite(tokens) && tokens >= 2048) learnedWindow = Math.floor(tokens);
}

/** Called with a real measurement: `chars` of prompt were `tokens` tokens for the server. */
export function learnCharsPerToken(chars: number, tokens: number | undefined): void {
  if (!tokens || tokens < 500 || chars < 1500) return;
  const sample = Math.min(5, Math.max(2, chars / tokens));
  learnedCharsPerToken = learnedCharsPerToken ? 0.5 * learnedCharsPerToken + 0.5 * sample : sample;
}

export function charsPerToken(): number {
  return learnedCharsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
}

/** Forgets what was learned (tests). */
export function resetContextLearning(): void {
  learnedWindow = undefined;
  learnedCharsPerToken = undefined;
}

/** The window in tokens: what the user said (AGENT_CONTEXT_WINDOW), never more than the server has admitted to. */
export function contextWindow(env: NodeJS.ProcessEnv = process.env): number {
  const said = Number(env.AGENT_CONTEXT_WINDOW);
  const base = Number.isFinite(said) && said >= 2048 ? Math.floor(said) : DEFAULT_WINDOW;
  return learnedWindow ? Math.min(base, learnedWindow) : base;
}

/** Tokens the prompt may use: the window minus room for the reply (up to 4096) and a small margin. */
export function promptBudgetTokens(window: number, maxOutputTokens: number): number {
  const reserve = Math.min(Math.max(maxOutputTokens, 1024), 4096) + 512;
  return Math.max(4096, window - reserve);
}

export const estimateTokens = (chars: number, cpt = charsPerToken()): number => Math.ceil(chars / cpt);

export function messagesChars(messages: readonly Pick<ChatMessage, "content">[]): number {
  return messages.reduce((n, m) => n + m.content.length, 0);
}

/** Keeps the start and the end of a text and says how much was left out of the middle. */
export function clipMiddle(text: string, maxChars: number, headShare = 0.6): string {
  if (text.length <= maxChars) return text;
  const marker = (n: number) => `\n\n[… ${n} characters left out here to fit the model's context window …]\n\n`;
  const room = Math.max(200, maxChars - marker(text.length).length);
  const head = Math.floor(room * headShare);
  const tail = room - head;
  return `${text.slice(0, head)}${marker(text.length - head - tail)}${text.slice(text.length - tail)}`;
}

export interface FitReport {
  before: number;
  after: number;
  elided: number;
  clippedSystem: boolean;
  clippedFirstUser: boolean;
  /** True when the prompt is still larger than the budget after everything that may be cut was cut. */
  stillOver: boolean;
}

const MIN_SYSTEM_CHARS = 9000;
const MIN_USER_CHARS = 5000;

/**
 * Brings `messages` (in place) under `budgetChars`. `extraChars` is what the request carries besides the messages
 * (the tools payload). Messages 0 (system) and 1 (first user message) are the only ones clipped; every other cut is an
 * old bulky tool or assistant message that is replaced by a one-line note.
 *
 * History is cut down to `historyTarget` (75%) of the budget in ONE pass, not to the last character: the model server
 * can only reuse its cached prompt up to the first message that changed, so trimming a little on every turn would make it
 * read the whole prompt again every turn (a 30k-token prompt is a minute and a half of waiting on a local machine).
 */
export function fitConversation(messages: ChatMessage[], budgetChars: number, extraChars = 0, historyTarget = 0.75): FitReport {
  const before = messagesChars(messages) + extraChars;
  const report: FitReport = { before, after: before, elided: 0, clippedSystem: false, clippedFirstUser: false, stillOver: false };
  let total = before;
  if (total <= budgetChars) return report;

  const historyGoal = Math.floor(budgetChars * Math.min(1, Math.max(0.3, historyTarget)));
  const elide = (protectedTail: number, minLen: number): void => {
    for (let i = 2; i < messages.length - protectedTail && total > historyGoal; i++) {
      const m = messages[i];
      if ((m.role === "tool" || m.role === "assistant") && m.content.length > minLen) {
        const was = m.content.length;
        m.content =
          m.role === "tool"
            ? `[older tool output elided (${was} chars) — call the tool again if you still need it]`
            : `[older assistant message elided (${was} chars)]`;
        total -= was - m.content.length;
        report.elided++;
      }
    }
  };
  elide(6, 400);
  elide(2, 150);

  if (total > budgetChars && messages[0]?.role === "system") {
    const was = messages[0].content.length;
    const target = Math.max(MIN_SYSTEM_CHARS, was - (total - budgetChars));
    if (target < was) {
      messages[0].content = clipMiddle(messages[0].content, target, 0.7);
      total -= was - messages[0].content.length;
      report.clippedSystem = true;
    }
  }
  if (total > budgetChars && messages[1]?.role === "user") {
    const was = messages[1].content.length;
    const target = Math.max(MIN_USER_CHARS, was - (total - budgetChars));
    if (target < was) {
      messages[1].content = clipMiddle(messages[1].content, target, 0.7);
      total -= was - messages[1].content.length;
      report.clippedFirstUser = true;
    }
  }
  report.after = total;
  report.stillOver = total > budgetChars;
  return report;
}

/**
 * How much of the knowledge standards fits: 1 = all of it, down to `floor`. `fixedChars` is everything else that goes into
 * the first request (rules, role text, tools payload, the task and its assignment).
 */
export function knowledgeScale(budgetChars: number, fixedChars: number, wantedKnowledgeChars: number, floor = 0.15): number {
  if (wantedKnowledgeChars <= 0) return 1;
  const room = budgetChars - fixedChars;
  return Math.min(1, Math.max(floor, room / wantedKnowledgeChars));
}

/**
 * Splits the first request of a run between the task text and the standards. The standards (versions, recipes, exact
 * commands) are what saves a build from guessing, so they keep at least `floor` of what they want; the first user message
 * (tree, task, assignment) gives up the difference, from its middle, down to `minUserChars`.
 * `otherFixedChars` is everything else: rules, role text, project rules, the tools payload.
 */
export function allocateFirstRequest(
  budgetChars: number,
  otherFixedChars: number,
  userChars: number,
  wantedKnowledgeChars: number,
  floor = 0.4,
  minUserChars = 8000,
): { userMaxChars: number | null; share: number } {
  if (wantedKnowledgeChars <= 0) return { userMaxChars: null, share: 1 };
  const room = budgetChars - otherFixedChars - userChars;
  const wantedFloor = wantedKnowledgeChars * floor;
  let userMax: number | null = null;
  let userNow = userChars;
  if (room < wantedFloor) {
    const target = Math.max(minUserChars, userChars - Math.ceil(wantedFloor - room));
    if (target < userChars) {
      userMax = target;
      userNow = target;
    }
  }
  const share = Math.min(1, Math.max(floor, (budgetChars - otherFixedChars - userNow) / wantedKnowledgeChars));
  return { userMaxChars: userMax, share };
}
