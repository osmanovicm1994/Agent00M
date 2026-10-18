import { describe, it, expect } from "vitest";
import { buildDebugTask, buildTaskPrompt, extractContract, makeCommandInterceptor, parseDebugOutcome } from "./wire";
import { classifyFailure } from "./error-classifier";
import type { LLMProvider } from "../llm/types";

describe("parseDebugOutcome", () => {
  it("counts a patch only when the agent says PATCHED and wrote files", () => {
    const ok = parseDebugOutcome("checked\nPATCHED: pinned @nestjs/core to 10.4.0", ["apps/api/package.json"]);
    expect(ok.patched).toBe(true);
    expect(ok.summary).toBe("pinned @nestjs/core to 10.4.0");
    expect(ok.filesChanged).toEqual(["apps/api/package.json"]);
  });
  it("does not count PATCHED without any file written", () => {
    expect(parseDebugOutcome("PATCHED: it was fine", []).patched).toBe(false);
  });
  it("does not count NOT PATCHED even when files were written", () => {
    const r = parseDebugOutcome("NOT PATCHED: need the tsconfig", ["a.ts"]);
    expect(r.patched).toBe(false);
    expect(r.summary).toBe("need the tsconfig");
  });
  it("copes with a message without a marker", () => {
    const r = parseDebugOutcome("I looked at it.", ["a.ts"]);
    expect(r.patched).toBe(false);
    expect(r.summary).toContain("looked");
  });
});

describe("buildDebugTask", () => {
  it("carries the command, the exact output and the hint", () => {
    const output = "npm error code E404\nnpm error 404  '@nestjs/nope@^1.0.0' is not in this registry.";
    const failure = classifyFailure("npm install", output, 1)!;
    const text = buildDebugTask({ agentId: "api", failure, command: "npm install", output });
    expect(text).toContain("Command: npm install");
    expect(text).toContain("is not in this registry");
    expect(text).toContain(failure.hint);
    expect(text).toContain("PATCHED:");
  });
});

describe("buildTaskPrompt", () => {
  const task = { id: "api", agent: "api", title: "Build users API", instructions: "Do it.", scope: ["apps/api/"], dependsOn: [], publishes: "api-contract" };
  const ctx = { contractsText: "### schema (v1, by db)\nUser(id)", digest: () => "", task, board: {} as never, locks: {} as never, signal: new AbortController().signal };
  it("names the scope, the contracts it must follow and asks for its own contract", () => {
    const p = buildTaskPrompt(task, ctx);
    expect(p).toContain("apps/api/");
    expect(p).toContain("User(id)");
    expect(p).toContain("CONTRACT:");
  });
  it("marks a task without scope as read-only", () => {
    expect(buildTaskPrompt({ ...task, scope: [], publishes: undefined }, { ...ctx, contractsText: "" })).toContain("read-only");
  });
});

describe("extractContract", () => {
  it("takes the text after the last CONTRACT: heading", () => {
    expect(extractContract("done\nCONTRACT:\nPOST /users {email}", "api")).toEqual({ name: "api", body: "POST /users {email}" });
  });
  it("returns undefined without a heading or body", () => {
    expect(extractContract("done", "api")).toBeUndefined();
    expect(extractContract("CONTRACT:   ", "api")).toBeUndefined();
  });
});

describe("makeCommandInterceptor", () => {
  const llm = {} as LLMProvider;
  const off = { enabled: false, maxPerRun: 3, maxPerKey: 1, escalateAfter: 2 };
  const on = { ...off, enabled: true };
  const failure = { agentId: "dev", command: "npm install", output: "x", exitCode: 1 };

  it("returns no hook when auto-debug is off", () => {
    expect(makeCommandInterceptor({ llm, workspaceRoot: ".", mayRun: () => true, config: off })).toBeUndefined();
  });
  it("does nothing when auto mode is not on", async () => {
    const hook = makeCommandInterceptor({ llm, workspaceRoot: ".", mayRun: () => false, config: on })!;
    expect(await hook(failure)).toBeNull();
  });
  it("leaves the debug agent's own failures alone", async () => {
    const hook = makeCommandInterceptor({ llm, workspaceRoot: ".", mayRun: () => true, config: on })!;
    expect(await hook({ ...failure, agentId: "debug", output: "npm error code E404\nnpm error 404  'x@1' is not in this registry." })).toBeNull();
  });
  it("gives a note without a debug run for a failure no patch can fix", async () => {
    const hook = makeCommandInterceptor({ llm, workspaceRoot: ".", mayRun: () => true, config: on, log: () => {} })!;
    const r = await hook({ ...failure, output: "getaddrinfo ENOTFOUND registry.npmjs.org" });
    expect(r?.note).toContain("AUTO-DEBUG NOTE");
    expect(r?.verified).toBe(false);
  });
});
