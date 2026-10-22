import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { classifyFailure } from "./error-classifier";
import { DebugInterceptor, interceptorConfigFromEnv, type DebugRequest } from "./debug-interceptor";
import { buildTriageReport, describeProject, type AttemptRecord } from "./triage";

const NPM_404 = `npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/@nestjs%2fnope - Not found
npm error 404  '@nestjs/nope@^1.0.0' is not in this registry.`;

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "triage-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("buildTriageReport", () => {
  const failure = classifyFailure("npm install", NPM_404, 1)!;
  const attempts: AttemptRecord[] = [
    { n: 1, summary: "pinned the package to ^0.9.0", filesChanged: ["package.json"], outcome: "still-fails" },
    { n: 2, summary: "no such package on the registry", filesChanged: [], outcome: "no-patch" },
  ];
  const report = buildTriageReport({
    project: { stack: "Next.js, Prisma", dirs: [".", "apps/", "apps/web/"] },
    command: "npm install",
    output: NPM_404,
    failure,
    attempts,
    limit: 5,
  });

  it("uses the required headings, in order", () => {
    const order = [
      "🚨 Project Failure & Triage Report",
      "1. System Telemetry & Architecture",
      "2. Execution Log & Blockers",
      "3. Root Cause Analysis",
      "4. Required User Intervention",
    ].map((h) => report.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("reports the stack, the folders, the attempt count and the exact error", () => {
    expect(report).toContain("Tech Stack Designed: Next.js, Prisma");
    expect(report).toContain("Target Directories Checked: ., apps/, apps/web/");
    expect(report).toContain("Total Automation Attempts: 2 / 5");
    expect(report).toContain("Failing Command: npm install");
    expect(report).toContain("npm error code E404");
  });

  it("lists every attempt and asks at most two direct questions", () => {
    expect(report).toContain("Attempt 1: patched, the command still failed");
    expect(report).toContain("Attempt 2: no safe patch found");
    const section4 = report.slice(report.indexOf("4. Required User Intervention"));
    const questions = section4.split("\n").filter((l) => /^\d+\. /.test(l));
    // the heading itself matches the pattern, so allow it plus at most two questions
    expect(questions.length).toBeGreaterThanOrEqual(2);
    expect(questions.length).toBeLessThanOrEqual(3);
  });

  it("cuts very long output to the tail", () => {
    const long = buildTriageReport({
      project: { stack: "x", dirs: ["."] },
      command: "npm test",
      output: "A".repeat(10000) + "THE-END",
      failure,
      attempts,
      limit: 5,
    });
    expect(long).toContain("THE-END");
    expect(long).toContain("earlier output cut");
    expect(long.length).toBeLessThan(6000);
  });
});

describe("describeProject", () => {
  it("detects a stack from manifests and lists folders without node_modules", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "apps", "web"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0", "@prisma/client": "6.0.0" }, devDependencies: { typescript: "5.0.0" } }));
    const facts = describeProject(root);
    expect(facts.stack).toContain("Next.js");
    expect(facts.stack).toContain("Prisma");
    expect(facts.stack).toContain("TypeScript");
    expect(facts.dirs).toContain("apps/");
    expect(facts.dirs).toContain("apps/web/");
    expect(facts.dirs.some((d) => d.startsWith("node_modules"))).toBe(false);
  });

  it("says so when nothing is recognised, and survives an unreadable folder", () => {
    expect(describeProject(tmp()).stack).toContain("not detected");
    expect(describeProject(path.join(os.tmpdir(), "does-not-exist-triage")).stack).toContain("not detected");
  });

  it("detects non-JS projects by their manifests", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "go.mod"), "module x");
    fs.writeFileSync(path.join(root, "Cargo.toml"), "[package]");
    fs.writeFileSync(path.join(root, "pubspec.yaml"), "name: x");
    const stack = describeProject(root).stack;
    expect(stack).toContain("Go");
    expect(stack).toContain("Rust");
    expect(stack).toContain("Flutter");
  });
});

describe("the attempt gate", () => {
  function make(limit: number, patched = true) {
    const calls: DebugRequest[] = [];
    const interceptor = new DebugInterceptor(
      {
        async debug(req) {
          calls.push(req);
          return { patched, summary: `try ${calls.length}`, filesChanged: patched ? ["package.json"] : [] };
        },
        rerun: async () => ({ output: NPM_404, exitCode: 1 }),
        describeProject: () => ({ stack: "Node", dirs: ["."] }),
      },
      { enabled: true, maxPerRun: 30, maxPerKey: limit, escalateAfter: 2 },
    );
    return { interceptor, calls };
  }

  it("stops after exactly N attempts, hands over the report, and never runs an N+1th", async () => {
    const { interceptor, calls } = make(3);
    const e = { agentId: "backend", command: "npm install", output: NPM_404, exitCode: 1 };

    const first = await interceptor.handle(e);
    expect(first).toContain("attempt 1/3");
    expect(interceptor.takeHalt()).toBeUndefined();

    await interceptor.handle(e);
    expect(interceptor.takeHalt()).toBeUndefined();

    const third = await interceptor.handle(e);
    expect(third).toContain("AUTO-DEBUG STOP");
    const report = interceptor.takeHalt();
    expect(report).toContain("🚨 Project Failure & Triage Report");
    expect(report).toContain("Total Automation Attempts: 3 / 3");
    expect(calls).toHaveLength(3);

    // the report is handed over once, and a further failure of the same command starts no new debug run
    expect(interceptor.takeHalt()).toBeUndefined();
    expect(await interceptor.handle(e)).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("keeps the report per command, so a second agent running the same command is stopped too", async () => {
    const { interceptor } = make(1);
    const e = { agentId: "backend", command: "npm   install", output: NPM_404, exitCode: 1 };
    expect(interceptor.haltFor("npm install")).toBeUndefined();
    await interceptor.handle(e);
    expect(interceptor.takeHalt()).toContain("Project Failure & Triage Report");
    // takeHalt hands it over once; haltFor still has it, and ignores spacing differences
    expect(interceptor.haltFor("npm install")).toContain("Project Failure & Triage Report");
    expect(interceptor.haltFor("npm run build")).toBeUndefined();
  });

  it("counts attempts where the Debug Agent finds no safe patch", async () => {
    const { interceptor, calls } = make(2, false);
    const e = { agentId: "backend", command: "npm install", output: NPM_404, exitCode: 1 };
    await interceptor.handle(e);
    expect(interceptor.takeHalt()).toBeUndefined();
    const second = await interceptor.handle(e);
    expect(second).toContain("AUTO-DEBUG STOP");
    expect(interceptor.takeHalt()).toContain("Attempt 2: no safe patch found");
    expect(calls).toHaveLength(2);
  });

  it("starts a fresh count after the command was fixed and verified", async () => {
    let healed = false;
    const interceptor = new DebugInterceptor(
      {
        debug: async () => ({ patched: true, summary: "fixed it", filesChanged: ["package.json"] }),
        rerun: async () => (healed ? { output: "ok", exitCode: 0 } : { output: NPM_404, exitCode: 1 }),
      },
      { enabled: true, maxPerRun: 30, maxPerKey: 2, escalateAfter: 2 },
    );
    const e = { agentId: "backend", command: "npm install", output: NPM_404, exitCode: 1 };
    await interceptor.handle(e); // attempt 1 fails
    healed = true;
    const ok = await interceptor.handle(e); // attempt 2 verifies
    expect(ok).toContain("FIXED and verified");
    expect(interceptor.takeHalt()).toBeUndefined();
  });
});

describe("interceptorConfigFromEnv", () => {
  it("defaults to 5 attempts per command and 10 runs per session, and clamps bad values", () => {
    const d = interceptorConfigFromEnv({ AGENT_AUTO_DEBUG: "1" });
    expect(d.enabled).toBe(true);
    expect(d.maxPerKey).toBe(5);
    expect(d.maxPerRun).toBe(10);
    const bad = interceptorConfigFromEnv({ AGENT_AUTO_DEBUG: "1", AGENT_AUTO_DEBUG_ATTEMPTS: "abc", AGENT_AUTO_DEBUG_MAX: "9999" });
    expect(bad.maxPerKey).toBe(5);
    expect(bad.maxPerRun).toBe(10);
  });
  it("is off unless AGENT_AUTO_DEBUG is set", () => {
    expect(interceptorConfigFromEnv({}).enabled).toBe(false);
  });
});
