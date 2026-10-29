import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { checkFixTask, checksFor, failureText, runChecks, summarizeChecks, type Runner } from "./verify-gate";

let root: string;

function put(rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-gate-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const pass: Runner = () => ({ exitCode: 0, timedOut: false, output: "ok" });

describe("checksFor", () => {
  it("uses the typecheck script and the build script", () => {
    put("apps/web/package.json", JSON.stringify({ scripts: { typecheck: "tsc --noEmit", build: "next build" } }));
    expect(checksFor(path.join(root, "apps/web"), true)).toEqual(["npm run typecheck", "npm run build"]);
    expect(checksFor(path.join(root, "apps/web"), false)).toEqual(["npm run typecheck"]);
  });

  it("falls back to tsc over the tsconfig when there is no typecheck script", () => {
    put("apps/web/package.json", JSON.stringify({ devDependencies: { typescript: "5" } }));
    put("apps/web/tsconfig.json", "{}");
    expect(checksFor(path.join(root, "apps/web"), true)).toEqual(["npx --no-install tsc --noEmit"]);
  });

  it("runs nothing for a folder without scripts or typescript", () => {
    put("apps/web/package.json", JSON.stringify({ name: "x" }));
    expect(checksFor(path.join(root, "apps/web"), true)).toEqual([]);
  });
});

describe("runChecks", () => {
  it("reports success when every check exits 0", async () => {
    put("apps/web/package.json", JSON.stringify({ scripts: { typecheck: "x", build: "y" } }));
    const report = await runChecks(root, { runner: pass });
    expect(report.ok).toBe(true);
    expect(report.results.map((r) => r.command)).toEqual(["npm run typecheck", "npm run build"]);
    expect(summarizeChecks(report)).toContain("passed (exit 0)");
  });

  it("does not run the build when the typecheck failed, and keeps the error text", async () => {
    put("apps/web/package.json", JSON.stringify({ scripts: { typecheck: "x", build: "y" } }));
    const calls: string[] = [];
    const runner: Runner = (command) => {
      calls.push(command);
      return { exitCode: 2, timedOut: false, output: "src/a.ts(1,1): error TS2307: Cannot find module" };
    };
    const report = await runChecks(root, { runner });
    expect(calls).toEqual(["npm run typecheck"]);
    expect(report.ok).toBe(false);
    expect(failureText(report)).toContain("TS2307");
    expect(checkFixTask(report)).toContain("FAIL");
  });

  it("counts a timeout as a failure", async () => {
    put("apps/web/package.json", JSON.stringify({ scripts: { typecheck: "x" } }));
    const report = await runChecks(root, { runner: () => ({ exitCode: null, timedOut: true, output: "" }) });
    expect(report.ok).toBe(false);
    expect(summarizeChecks(report)).toContain("timed out");
  });

  it("is ok and says so when there is nothing to run", async () => {
    const report = await runChecks(root, { runner: pass });
    expect(report.ok).toBe(true);
    expect(summarizeChecks(report)).toContain("nothing was run");
  });
});
