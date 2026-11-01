import { afterEach, describe, expect, it } from "vitest";
import {
  clipMiddle,
  contextWindow,
  fitConversation,
  knowledgeScale,
  allocateFirstRequest,
  learnCharsPerToken,
  learnWindow,
  messagesChars,
  promptBudgetTokens,
  resetContextLearning,
  charsPerToken,
} from "./context-fit";
import { ContextOverflowError, isContextOverflowText, parseContextNumbers } from "../llm/context-error";
import type { ChatMessage } from "../llm/types";

afterEach(() => resetContextLearning());

const msg = (role: ChatMessage["role"], n: number, ch = "x"): ChatMessage => ({ role, content: ch.repeat(n) });

describe("context window and budget", () => {
  it("assumes 32768 unless told, and never more than the server admitted", () => {
    expect(contextWindow({})).toBe(32768);
    expect(contextWindow({ AGENT_CONTEXT_WINDOW: "65536" } as any)).toBe(65536);
    expect(contextWindow({ AGENT_CONTEXT_WINDOW: "abc" } as any)).toBe(32768);
    learnWindow(30720);
    expect(contextWindow({})).toBe(30720);
    expect(contextWindow({ AGENT_CONTEXT_WINDOW: "65536" } as any)).toBe(30720);
    expect(contextWindow({ AGENT_CONTEXT_WINDOW: "16384" } as any)).toBe(16384);
  });

  it("keeps room for the reply", () => {
    expect(promptBudgetTokens(30720, 8192)).toBe(30720 - 4096 - 512);
    expect(promptBudgetTokens(30720, 2000)).toBe(30720 - 2000 - 512);
    expect(promptBudgetTokens(1000, 8192)).toBe(4096);
  });

  it("learns characters per token from real measurements, within sane bounds", () => {
    expect(charsPerToken()).toBeCloseTo(3.2);
    learnCharsPerToken(100000, 25000); // 4.0
    expect(charsPerToken()).toBeCloseTo(4.0);
    learnCharsPerToken(100000, 100); // too few tokens: ignored
    expect(charsPerToken()).toBeCloseTo(4.0);
    learnCharsPerToken(100000, 10000); // 10 -> capped at 5, averaged with 4.0
    expect(charsPerToken()).toBeCloseTo(4.5);
  });
});

describe("clipMiddle", () => {
  it("leaves short text alone and keeps both ends of long text", () => {
    expect(clipMiddle("short", 100)).toBe("short");
    const out = clipMiddle(`START${"m".repeat(5000)}END`, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.startsWith("START")).toBe(true);
    expect(out.endsWith("END")).toBe(true);
    expect(out).toContain("characters left out");
  });
});

describe("fitConversation", () => {
  const convo = (): ChatMessage[] => [
    msg("system", 40000, "s"),
    msg("user", 30000, "u"),
    msg("assistant", 3000, "a"),
    msg("tool", 20000, "t"),
    msg("assistant", 2000, "b"),
    msg("tool", 15000, "c"),
    msg("assistant", 500, "d"),
    msg("tool", 500, "e"),
    msg("assistant", 500, "f"),
    msg("tool", 500, "g"),
    msg("user", 500, "h"),
  ];

  it("does nothing when the prompt already fits", () => {
    const m = convo();
    const r = fitConversation(m, 500000);
    expect(r.elided).toBe(0);
    expect(r.clippedSystem || r.clippedFirstUser).toBe(false);
  });

  it("drops old bulky history first and keeps the newest turns whole", () => {
    const m = convo();
    const total = messagesChars(m);
    const r = fitConversation(m, total - 30000);
    expect(r.elided).toBeGreaterThan(0);
    expect(r.clippedSystem).toBe(false);
    expect(m[3].content).toContain("elided");
    expect(m[m.length - 1].content).toBe("h".repeat(500));
    expect(r.stillOver).toBe(false);
    expect(messagesChars(m)).toBeLessThanOrEqual(total - 30000);
  });

  it("then cuts the middle of the system prompt, then of the first user message", () => {
    const m = convo();
    const r1 = fitConversation(m, 52000);
    expect(r1.clippedSystem).toBe(true);
    expect(m[0].content).toContain("left out");
    expect(m[0].content.startsWith("sss")).toBe(true);
    expect(m[0].content.endsWith("sss")).toBe(true);

    const m2 = convo();
    const r2 = fitConversation(m2, 20000);
    expect(r2.clippedSystem).toBe(true);
    expect(r2.clippedFirstUser).toBe(true);
    expect(messagesChars(m2)).toBeLessThanOrEqual(20000);
  });

  it("reports when nothing more can be cut", () => {
    const m: ChatMessage[] = [msg("system", 20000), msg("user", 20000)];
    const r = fitConversation(m, 3000);
    expect(r.stillOver).toBe(true);
    expect(m[0].content.length).toBeGreaterThanOrEqual(9000);
  });

  it("cuts history down to 75% in one pass, so the next turns do not change the start of the prompt again", () => {
    const m = convo();
    const budget = messagesChars(m) - 5000; // only slightly over
    const r1 = fitConversation(m, budget);
    expect(r1.elided).toBeGreaterThan(0);
    expect(messagesChars(m)).toBeLessThanOrEqual(budget * 0.75 + 100);
    // three more turns with bulky tool output: nothing is elided again until the budget is reached
    for (let i = 0; i < 3; i++) {
      m.push(msg("assistant", 600, "z"), msg("tool", 3000, "y"));
      expect(fitConversation(m, budget).elided).toBe(0);
    }
  });

  it("counts the tools payload as part of the request", () => {
    const m = convo();
    const total = messagesChars(m);
    const r = fitConversation(m, total, 20000);
    expect(r.elided).toBeGreaterThan(0);
  });
});

describe("knowledgeScale", () => {
  it("is 1 when everything fits and shrinks to a floor otherwise", () => {
    expect(knowledgeScale(80000, 30000, 25000)).toBe(1);
    expect(knowledgeScale(50000, 38000, 25000)).toBeCloseTo(0.48);
    expect(knowledgeScale(30000, 40000, 25000)).toBe(0.15);
    expect(knowledgeScale(30000, 10000, 0)).toBe(1);
  });
});

describe("allocateFirstRequest", () => {
  it("leaves everything alone when the standards fit", () => {
    expect(allocateFirstRequest(90000, 30000, 20000, 25000)).toEqual({ userMaxChars: null, share: 1 });
    expect(allocateFirstRequest(90000, 30000, 20000, 0)).toEqual({ userMaxChars: null, share: 1 });
  });

  it("gives the standards a share without cutting the task when that is enough", () => {
    const r = allocateFirstRequest(70000, 30000, 20000, 25000);
    expect(r.userMaxChars).toBeNull();
    expect(r.share).toBeCloseTo(0.8);
  });

  it("keeps at least 40% of the standards by shortening the task text, never below its minimum", () => {
    // room for knowledge is only 5000 of the 25000 wanted: the floor needs 10000, so the task text gives up 5000
    const r = allocateFirstRequest(60000, 30000, 25000, 25000);
    expect(r.userMaxChars).toBe(20000);
    expect(r.share).toBeCloseTo(0.4);
    const tight = allocateFirstRequest(40000, 30000, 12000, 25000);
    expect(tight.userMaxChars).toBe(8000);
    expect(tight.share).toBeCloseTo(0.4);
  });
});

describe("ContextOverflowError", () => {
  const TEXT = "The number of tokens to keep from the initial prompt (33307 tokens) is greater than the context length (30720 tokens)";
  it("recognises the server's refusal and reads both numbers", () => {
    expect(isContextOverflowText(TEXT)).toBe(true);
    expect(isContextOverflowText("connection refused")).toBe(false);
    expect(parseContextNumbers(TEXT)).toEqual({ promptTokens: 33307, contextTokens: 30720 });
    expect(parseContextNumbers("n_prompt_tokens: 40000, n_ctx: 32768")).toEqual({ promptTokens: 40000, contextTokens: 32768 });
    expect(parseContextNumbers("context overflow")).toEqual({ promptTokens: undefined, contextTokens: undefined });
  });
  it("carries the numbers", () => {
    const e = new ContextOverflowError("x", 33307, 30720);
    expect(e).toBeInstanceOf(Error);
    expect(e.promptTokens).toBe(33307);
    expect(e.contextTokens).toBe(30720);
  });
});
