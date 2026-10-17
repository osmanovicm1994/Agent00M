import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import {
  agentOutcome,
  compareRuns,
  parseAgentOutput,
  renderComparison,
  renderMarkdown,
  selectSlices,
  summarize,
  tailOf,
  vacuousChecks,
  validateSpec,
  type RunResult,
  type SliceResult,
  type Spec,
} from "./fullstack-bench";

const spec: Spec = {
  name: "t",
  version: 1,
  slices: ["a", "b", "c", "d"].map((id) => ({
    id,
    title: `slice ${id}`,
    task: `do the thing for slice ${id} please`,
    accept: [{ label: "file exists", cmd: "test -f x" }],
  })),
};

const slice = (id: string, oks: boolean[], extra: Partial<SliceResult> = {}): SliceResult => ({
  id,
  title: id,
  agentExit: 0,
  agentMs: 60000,
  timedOut: false,
  steps: 5,
  filesWritten: 2,
  acceptance: oks.map((ok, i) => ({ label: `c${i}`, ok, ms: 1, tail: ok ? "" : "boom" })),
  ...extra,
});

const run = (slices: SliceResult[]): RunResult => ({
  startedAt: "2026-01-01T00:00:00Z",
  mode: "full",
  workspace: "/tmp/ws",
  model: "qwen",
  specName: "t",
  specVersion: 1,
  slices,
});

describe("validateSpec", () => {
  it("accepts a good spec and a predeploy entry", () => {
    expect(validateSpec(spec)).toEqual([]);
    const withPre = { ...spec, slices: [{ ...spec.slices[0], accept: [{ label: "deploy", predeploy: true }] }] };
    expect(validateSpec(withPre)).toEqual([]);
  });

  it("reports duplicate slice ids, duplicate labels and bad shapes", () => {
    const dup = { ...spec, slices: [spec.slices[0], spec.slices[0]] };
    expect(validateSpec(dup).join("\n")).toContain("duplicate slice id: a");
    const labels = { ...spec, slices: [{ ...spec.slices[0], accept: [spec.slices[0].accept[0], spec.slices[0].accept[0]] }] };
    expect(validateSpec(labels).join("\n")).toContain("duplicate acceptance label");
    expect(validateSpec({ name: "x" }).length).toBeGreaterThan(0);
    expect(validateSpec({ ...spec, slices: [{ ...spec.slices[0], id: "Bad Id" }] }).length).toBeGreaterThan(0);
  });
});

describe("the shipped spec", () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "bench", "fullstack", "spec.json"), "utf8"));

  it("is valid", () => {
    expect(validateSpec(real)).toEqual([]);
  });

  it("has slices in the intended order, each needing a presence check (no negative-only acceptance)", () => {
    const ids = real.slices.map((s: { id: string }) => s.id);
    expect(ids[0]).toBe("scaffold");
    expect(ids.indexOf("auth-jwt")).toBeLessThan(ids.indexOf("auth-guard"));
    expect(ids.indexOf("design-system")).toBeLessThan(ids.indexOf("login-page"));
    for (const s of real.slices) {
      for (const a of s.accept) {
        if (typeof a.cmd === "string" && /(^|&&\s*)!\s*grep/.test(a.cmd)) {
          // a `! grep` is only meaningful after something proved the code it guards exists
          const before = a.cmd.slice(0, a.cmd.search(/!\s*grep/));
          expect(before, `${s.id}: ${a.label}`).toMatch(/test -[df]|grep -[A-Za-z]*q/);
        }
      }
    }
  });
});

describe("selectSlices", () => {
  it("applies --from, --only and --max, and rejects unknown ids", () => {
    expect(selectSlices(spec).map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
    expect(selectSlices(spec, { from: "c" }).map((s) => s.id)).toEqual(["c", "d"]);
    expect(selectSlices(spec, { only: ["b", "d"] }).map((s) => s.id)).toEqual(["b", "d"]);
    expect(selectSlices(spec, { from: "b", max: 2 }).map((s) => s.id)).toEqual(["b", "c"]);
    expect(() => selectSlices(spec, { only: ["zzz"] })).toThrow(/Unknown slice id/);
  });
});

describe("parseAgentOutput", () => {
  it("reads the step count and the file list, ignoring colour codes", () => {
    const out = "\x1b[32m\n✔ Task completed successfully (7 step(s) taken)\x1b[39m\nFiles written this session:\n  - a.ts\n  - b/c.ts\n";
    expect(parseAgentOutput(out)).toEqual({ steps: 7, filesWritten: 2 });
  });
  it("reads the file count from the run command's summary", () => {
    const out = "\n(12 step(s) taken)\n\nSummary:\n  Files written (4):\n    - a.ts\n    - b.ts\n";
    expect(parseAgentOutput(out)).toEqual({ steps: 12, filesWritten: 4 });
  });
  it("returns nulls when the run printed neither", () => {
    expect(parseAgentOutput("Execution error: boom")).toEqual({ steps: null, filesWritten: null });
  });
});

describe("agentOutcome", () => {
  const base = { steps: 10, timedOut: false, exit: 0, maxSteps: 50 };
  it("separates finished, cut off, no summary, crashed and timeout", () => {
    expect(agentOutcome(base)).toBe("finished");
    expect(agentOutcome({ ...base, steps: 50 })).toBe("step-limit");
    expect(agentOutcome({ ...base, steps: null })).toBe("no-summary");
    expect(agentOutcome({ ...base, exit: 1 })).toBe("crashed");
    expect(agentOutcome({ ...base, timedOut: true, exit: null })).toBe("timeout");
  });
});

describe("tailOf", () => {
  it("keeps the last lines and caps the characters", () => {
    expect(tailOf("1\n2\n3\n4", 2)).toBe("3\n4");
    expect(tailOf("x".repeat(2000), 5, 100)).toHaveLength(100);
  });
});

describe("summarize", () => {
  it("counts the unbroken streak, first failure and checks", () => {
    const s = summarize(run([slice("a", [true]), slice("b", [true, true]), slice("c", [true, false]), slice("d", [true])]));
    expect(s).toMatchObject({ slices: 4, passed: 3, streak: 2, firstFailure: "c", checksPassed: 5, checksTotal: 6 });
  });
  it("a slice with no checks never counts as passed", () => {
    expect(summarize(run([slice("a", [])])).passed).toBe(0);
  });
  it("sums agent minutes and timeouts", () => {
    const s = summarize(run([slice("a", [true], { agentMs: 90000 }), slice("b", [false], { agentMs: 30000, timedOut: true })]));
    expect(s.agentMinutes).toBe(2);
    expect(s.timedOut).toBe(1);
  });
});

describe("vacuousChecks", () => {
  it("lists checks that passed on a workspace where nothing should pass", () => {
    expect(vacuousChecks(run([slice("a", [false, true]), slice("b", [false])]))).toEqual(["a: c1"]);
  });
});

describe("renderMarkdown", () => {
  it("shows a table, the headline and only the failed checks", () => {
    const md = renderMarkdown(run([slice("a", [true]), slice("b", [true, false])]));
    expect(md).toContain("Slices passed: 1/2");
    expect(md).toContain("| a | PASS | 1/1 |");
    expect(md).toContain("| b | FAIL | 1/2 |");
    expect(md).toContain("### b: b");
    expect(md).not.toContain("### a:");
    expect(md).toContain("boom");
  });
  it("marks a slice whose agent was not run with a dash", () => {
    expect(renderMarkdown(run([slice("a", [true], { agentExit: null })]))).toContain("| a | PASS | 1/1 | - |");
  });
});

describe("compareRuns", () => {
  const before = run([slice("a", [true]), slice("b", [false]), slice("c", [true]), slice("old", [true])]);
  const after = run([slice("a", [true]), slice("b", [true]), slice("c", [false]), slice("new", [true])]);

  it("sorts slices into improved, regressed and unchanged, and flags slices only in one run", () => {
    const c = compareRuns(before, after);
    expect(c.improved).toEqual(["b"]);
    expect(c.regressed).toEqual(["c"]);
    expect(c.unchanged).toBe(1);
    expect(c.onlyIn).toEqual({ before: ["old"], after: ["new"] });
  });

  it("renders a table and warns about the sample size", () => {
    const text = renderComparison(compareRuns(before, after));
    expect(text).toContain("| Slices passed | 3/4 | 3/4 |");
    expect(text).toContain("Improved: b");
    expect(text).toContain("Regressed: c");
    expect(text).toContain("noise");
  });
});
