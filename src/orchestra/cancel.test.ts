import { describe, it, expect } from "vitest";
import * as os from "os";
import { OrchestraMaster, type OrchTask, type TaskRunner } from "./orchestra-master";
import { WorkspaceLocks } from "./workspace-locks";
import { DebugInterceptor } from "./debug-interceptor";
import { boundedInt } from "./env-int";
import { llmConcurrencyFromEnv } from "./llm-gate";

const task = (id: string, scope: string[], dependsOn: string[] = []): OrchTask => ({
  id,
  agent: "dev",
  title: id,
  instructions: "",
  scope,
  dependsOn,
});

// Resolves when the task is told to stop.
const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

describe("OrchestraMaster cancellation", () => {
  it("stops running tasks, skips the rest and starts nothing new", async () => {
    const started: string[] = [];
    const runner: TaskRunner = async (t, ctx) => {
      started.push(t.id);
      await untilAborted(ctx.signal);
      return { status: "interrupted", summary: "stopped", filesWritten: [], commandsRun: [] };
    };
    const external = new AbortController();
    const master = new OrchestraMaster({ runner, locks: new WorkspaceLocks(os.tmpdir()), concurrency: 2, signal: external.signal });
    const run = master.run([task("a", ["a/"]), task("b", ["b/"]), task("c", ["c/"], ["a"])]);
    setTimeout(() => external.abort(), 20);
    const res = await run;

    expect(started.sort()).toEqual(["a", "b"]);
    expect(res.outcomes.a.status).toBe("interrupted");
    expect(res.outcomes.b.status).toBe("interrupted");
    expect(res.outcomes.c.status).toBe("skipped");
    expect(res.ok).toBe(false);
  });

  it("does not start anything when the signal is already aborted", async () => {
    let calls = 0;
    const runner: TaskRunner = async () => {
      calls++;
      return { status: "done", summary: "", filesWritten: [], commandsRun: [] };
    };
    const external = new AbortController();
    external.abort();
    const master = new OrchestraMaster({ runner, locks: new WorkspaceLocks(os.tmpdir()), signal: external.signal });
    const res = await master.run([task("a", ["a/"]), task("b", ["b/"])]);
    expect(calls).toBe(0);
    expect(res.outcomes.a.status).toBe("skipped");
    expect(res.outcomes.b.status).toBe("skipped");
  });

  it("runs normally without a signal", async () => {
    const runner: TaskRunner = async () => ({ status: "done", summary: "ok", filesWritten: [], commandsRun: [] });
    const master = new OrchestraMaster({ runner, locks: new WorkspaceLocks(os.tmpdir()) });
    const res = await master.run([task("a", ["a/"]), task("b", ["b/"], ["a"])]);
    expect(res.ok).toBe(true);
  });
});

describe("auto-debug rerun eligibility", () => {
  const config = { enabled: true, maxPerRun: 3, maxPerKey: 1, escalateAfter: 1 };
  const output = "npm error code E404\nnpm error 404  '@nestjs/nope@^1.0.0' is not in this registry.";
  const event = { agentId: "api", command: "npm install", output, exitCode: 1 };
  const deps = (reruns: string[], canRerun?: (c: string) => boolean) => ({
    debug: async () => ({ patched: true, summary: "pinned a version", filesChanged: ["package.json"] }),
    rerun: async (command: string) => {
      reruns.push(command);
      return { output: "ok", exitCode: 0 };
    },
    canRerun,
  });

  it("re-runs and verifies when the command is allowed", async () => {
    const reruns: string[] = [];
    const note = await new DebugInterceptor(deps(reruns, () => true), config).handle(event);
    expect(reruns).toEqual(["npm install"]);
    expect(note).toContain("FIXED and verified");
  });

  it("does NOT re-run a command that needs approval, and says so", async () => {
    const reruns: string[] = [];
    const note = await new DebugInterceptor(deps(reruns, () => false), config).handle(event);
    expect(reruns).toEqual([]);
    expect(note).toContain("NOT re-run automatically");
    expect(note).not.toContain("FIXED and verified");
  });
});

describe("boundedInt", () => {
  it("accepts whole numbers inside the range", () => {
    expect(boundedInt("4", 2, 1, 16)).toBe(4);
  });
  it("falls back for unset, empty, text, fractions, negatives, zero and too large", () => {
    for (const bad of [undefined, "", "  ", "abc", "2.5", "-3", "0", "1000"]) expect(boundedInt(bad, 2, 1, 16)).toBe(2);
  });
  it("applies to the LLM concurrency setting", () => {
    expect(llmConcurrencyFromEnv({ AGENT_LLM_CONCURRENCY: "3" } as NodeJS.ProcessEnv)).toBe(3);
    expect(llmConcurrencyFromEnv({ AGENT_LLM_CONCURRENCY: "99" } as NodeJS.ProcessEnv)).toBe(2);
    expect(llmConcurrencyFromEnv({} as NodeJS.ProcessEnv)).toBe(2);
  });
});
