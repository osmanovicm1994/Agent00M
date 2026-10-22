import { describe, it, expect } from "vitest";
import { applyEvidence, isComplete, lacksEvidence, mustWriteFiles } from "./evidence";

describe("evidence for team tasks", () => {
  it("expects files from builders only", () => {
    for (const r of ["dev", "api", "db", "design"]) expect(mustWriteFiles(r)).toBe(true);
    for (const r of ["infra", "debug", "qa", "ux", "safety"]) expect(mustWriteFiles(r)).toBe(false);
  });

  it("turns a builder 'done' without files into 'incomplete'", () => {
    expect(applyEvidence("dev", "done", [])).toBe("incomplete");
    expect(applyEvidence("design", "done", [])).toBe("incomplete");
    expect(applyEvidence("dev", "done", ["src/a.ts"])).toBe("done");
  });

  it("leaves other roles and other statuses alone", () => {
    expect(applyEvidence("qa", "done", [])).toBe("done");
    expect(applyEvidence("infra", "done", [])).toBe("done");
    expect(applyEvidence("dev", "interrupted", [])).toBe("interrupted");
    expect(applyEvidence("dev", "skipped", [])).toBe("skipped");
    expect(lacksEvidence("api", [])).toBe(true);
  });

  it("calls a run complete only when everything is done and safety is not failed or unknown", () => {
    const done = ["done", "done"] as const;
    expect(isComplete({ statuses: done, interrupted: false, safety: "PASS" })).toBe(true);
    expect(isComplete({ statuses: done, interrupted: false, safety: "NOT_RUN" })).toBe(true);
    expect(isComplete({ statuses: done, interrupted: false, safety: "UNKNOWN" })).toBe(false);
    expect(isComplete({ statuses: done, interrupted: false, safety: "FAIL" })).toBe(false);
    expect(isComplete({ statuses: ["done", "incomplete"], interrupted: false, safety: "PASS" })).toBe(false);
    expect(isComplete({ statuses: done, interrupted: true, safety: "PASS" })).toBe(false);
    expect(isComplete({ statuses: [], interrupted: false, safety: "PASS" })).toBe(false);
  });
});
