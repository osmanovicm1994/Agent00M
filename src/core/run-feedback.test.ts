import { describe, it, expect } from "vitest";
import { errorSignature, isCodeFile, RepeatTracker, repeatNote, summarizeFailures, REPEAT_LIMIT } from "./run-feedback";

describe("errorSignature", () => {
  it("gives the same signature for the same error at another line, path or time", () => {
    const a = "src/a.ts(12,5): error TS2304: Cannot find name 'foo'.";
    const b = "src/deep/b.ts(99,1): error TS2304: Cannot find name 'foo'.";
    expect(errorSignature(a)).toBe(errorSignature(b));
  });

  it("keeps different error codes apart", () => {
    expect(errorSignature("x.ts(1,1): error TS2304: boom")).not.toBe(errorSignature("x.ts(1,1): error TS2551: boom"));
  });

  it("skips noise before the error and ignores ANSI colors", () => {
    const out = "\u001b[31mstarting...\u001b[0m\n> build\nError: connect ECONNREFUSED 127.0.0.1:5432\n    at x";
    expect(errorSignature(out)).toContain("econnrefused");
  });

  it("falls back to the last line and handles empty output", () => {
    expect(errorSignature("one\ntwo")).toBe("two");
    expect(errorSignature("")).toBe("");
  });
});

describe("RepeatTracker", () => {
  it("counts per signature and ignores empty ones", () => {
    const t = new RepeatTracker();
    expect(t.record("a")).toBe(1);
    expect(t.record("a")).toBe(2);
    expect(t.record("b")).toBe(1);
    expect(t.record("")).toBe(0);
    expect(t.record("a")).toBe(REPEAT_LIMIT);
    expect(repeatNote(3)).toContain("3 times");
  });
});

describe("summarizeFailures", () => {
  const out = [
    " ✓ src/a.test.ts (4 tests) 5ms",
    " ❯ src/b.test.ts (3 tests | 1 failed) 6ms",
    "     × gives the reasoning core 5ms",
    "AssertionError: expected 'x' to contain 'y'",
    "AssertionError: expected 'x' to contain 'y'",
    " Test Files  1 failed | 1 passed (2)",
  ].join("\n");

  it("keeps the failing lines once each and drops the passing ones", () => {
    const s = summarizeFailures(out);
    expect(s).toContain("AssertionError");
    expect(s.match(/AssertionError/g)?.length).toBe(1);
    expect(s).not.toContain("a.test.ts (4 tests)");
  });

  it("caps the number of lines and returns empty when nothing failed", () => {
    const many = Array.from({ length: 50 }, (_, i) => `error: problem number ${i}`).join("\n");
    expect(summarizeFailures(many, 5).split("\n")).toHaveLength(5);
    expect(summarizeFailures("all good\nbuilt in 2s")).toBe("");
  });
});

describe("isCodeFile", () => {
  it("is true for source and schema files, false for docs and json", () => {
    for (const f of ["src/a.ts", "app/page.tsx", "Program.cs", "schema.prisma", "x.sql", "a.css"]) expect(isCodeFile(f)).toBe(true);
    for (const f of ["README.md", "package.json", "notes.txt", ".env.example"]) expect(isCodeFile(f)).toBe(false);
  });
});
