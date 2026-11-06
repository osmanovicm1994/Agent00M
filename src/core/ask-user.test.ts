import { describe, expect, it } from "vitest";
import { canAskUser, formatAnswer, formatQuestion, limitReached, maxQuestions, parseAskArgs, resolveAnswer, unattendedAnswer } from "./ask-user";

const spec = (over: Record<string, unknown> = {}) => {
  const p = parseAskArgs({ question: "Which database?", options: ["SQLite", "Postgres"], default: "Postgres", ...over });
  if (!p.ok) throw new Error(p.error);
  return p.value;
};

describe("ask_user helpers", () => {
  it("requires a question and keeps at most 4 short options", () => {
    expect(parseAskArgs({}).ok).toBe(false);
    expect(parseAskArgs({ question: "  " }).ok).toBe(false);
    const p = parseAskArgs({ question: "q", options: ["a", "", "b", "c", "d", "e", 5] });
    expect(p.ok && p.value.options).toEqual(["a", "b", "c", "d"]);
  });

  it("shows the question, the numbered options and the default", () => {
    const t = formatQuestion(spec({ why: "the spec does not say" }));
    expect(t).toContain("Which database?");
    expect(t).toContain("(the spec does not say)");
    expect(t).toContain("1) SQLite");
    expect(t).toContain("2) Postgres");
    expect(t).toContain("Press Enter for the default: Postgres");
  });

  it("maps a number to the option, empty to the default, other text as typed", () => {
    const s = spec();
    expect(resolveAnswer("1", s)).toEqual({ text: "SQLite", usedDefault: false });
    expect(resolveAnswer("", s)).toEqual({ text: "Postgres", usedDefault: true });
    expect(resolveAnswer("9", s).text).toBe("9");
    expect(resolveAnswer("  MySQL ", s).text).toBe("MySQL");
  });

  it("tells the model what to do for every outcome", () => {
    const s = spec();
    expect(formatAnswer("2", s)).toContain('answered: "Postgres"');
    expect(formatAnswer("", s)).toContain("accepted the default");
    expect(formatAnswer("", spec({ default: undefined }))).toContain("no default");
    expect(unattendedAnswer(s)).toContain('default: "Postgres"');
    expect(unattendedAnswer(spec({ default: undefined }))).toContain("NEEDS INPUT");
    expect(limitReached(3, 3)).toMatch(/^TOOL ERROR/);
  });

  it("asks only when someone can answer, and AGENT_ASK=0 switches it off", () => {
    expect(canAskUser("terminal", true, {})).toBe(true);
    expect(canAskUser("terminal", false, {})).toBe(false);
    expect(canAskUser("dashboard", false, {})).toBe(true);
    expect(canAskUser("terminal", true, { AGENT_ASK: "0" })).toBe(false);
  });

  it("limits questions per run (default 3, AGENT_MAX_QUESTIONS overrides, 0 allowed)", () => {
    expect(maxQuestions({})).toBe(3);
    expect(maxQuestions({ AGENT_MAX_QUESTIONS: "5" })).toBe(5);
    expect(maxQuestions({ AGENT_MAX_QUESTIONS: "0" })).toBe(0);
    expect(maxQuestions({ AGENT_MAX_QUESTIONS: "x" })).toBe(3);
  });
});
