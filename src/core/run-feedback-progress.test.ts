import { describe, it, expect } from "vitest";
import { checkOutputFailed, countErrorLines, digestTypeErrors, isMaskedCheck, progressSignature, MASKED_CHECK_NOTE } from "./run-feedback";
import { isInspectCommand } from "./stall-guard";
import { matchKnownFixes } from "./known-fixes";

const TYPECHECK = [
  ".next/types/validator.ts(181,31): error TS2344: Type 'typeof import(\"/x/src/app/api/users/route\")' does not satisfy the constraint 'RouteHandlerConfig<\"/api/users\">'.",
  "  Types of property 'PUT' are incompatible.",
  "src/app/api/users/route.ts(22,23): error TS2323: Cannot redeclare exported variable 'GET'.",
  "src/app/api/users/route.ts(144,9): error TS2322: Type 'string | undefined' is not assignable to type 'string'.",
  "src/app/users/page.tsx(12,38): error TS2304: Cannot find name 'User'.",
  "src/lib/prisma.ts(3,23): error TS2554: Expected 1 arguments, but got 0.",
].join("\n");

describe("progressSignature", () => {
  it("is the same for the same output and changes when the number of errors falls", () => {
    const fewer = TYPECHECK.split("\n").slice(0, 4).join("\n");
    expect(progressSignature(TYPECHECK)).toBe(progressSignature(TYPECHECK));
    expect(progressSignature(TYPECHECK)).not.toBe(progressSignature(fewer));
    expect(countErrorLines(TYPECHECK)).toBe(5);
  });

  it("is empty for empty output", () => {
    expect(progressSignature("")).toBe("");
  });
});

describe("isMaskedCheck", () => {
  it("flags checks whose exit code belongs to a pipe, `|| echo` or $(...)", () => {
    expect(isMaskedCheck("npm run build 2>&1 | tail -5")).toBe(true);
    expect(isMaskedCheck("npm run typecheck 2>&1 | grep -E \"(error|Error)\" | wc -l")).toBe(true);
    expect(isMaskedCheck("echo \"Build: $(npm run build 2>&1 | tail -5 | grep -i error || echo 'PASSED')\"")).toBe(true);
    expect(isMaskedCheck("npm run lint; echo done")).toBe(true);
  });

  it("does not flag a plain check, pipefail, or a command that is no check", () => {
    expect(isMaskedCheck("npm run typecheck")).toBe(false);
    expect(isMaskedCheck("npm run build && echo ok")).toBe(false);
    expect(isMaskedCheck("set -o pipefail; npm run build | tail -5")).toBe(false);
    expect(isMaskedCheck("ls src | head")).toBe(false);
  });

  it("explains why exit 0 proves nothing", () => {
    expect(MASKED_CHECK_NOTE).toContain("does NOT count as verification");
  });
});

describe("checkOutputFailed", () => {
  it("sees a real failure in a masked check and ignores the word 'error' used as a label", () => {
    expect(checkOutputFailed(TYPECHECK)).toBe(true);
    expect(checkOutputFailed("> Build error occurred\nError: Turbopack build failed")).toBe(true);
    expect(checkOutputFailed("Typecheck: 0\nLinting: PASSED\nBuild: PASSED")).toBe(false);
    expect(checkOutputFailed("Tests: 1 passed, 1 total")).toBe(false);
  });
});

describe("an echo that runs a build inside $(...) is not an inspect command", () => {
  it("is false with a substitution or backticks, still true for a plain echo", () => {
    expect(isInspectCommand("echo \"Build: $(npm run build)\"")).toBe(false);
    expect(isInspectCommand("echo `npm run build`")).toBe(false);
    expect(isInspectCommand("echo \"Task execution complete\"")).toBe(true);
  });
});

describe("digestTypeErrors", () => {
  it("lists the files, puts the files the run changed first and flags generated .next errors", () => {
    const digest = digestTypeErrors(TYPECHECK, ["src/app/api/users/route.ts"]);
    expect(digest).toContain("5 errors in 4 files");
    expect(digest.indexOf("Files YOU changed")).toBeGreaterThan(-1);
    expect(digest).toContain("src/app/api/users/route.ts (2)");
    expect(digest).toContain("never edit .next");
    expect(digest).toContain("src/lib/prisma.ts:3 TS2554");
  });

  it("stays silent for a small or single-file output", () => {
    expect(digestTypeErrors("src/a.ts(1,1): error TS2304: x\nsrc/a.ts(2,1): error TS2304: y")).toBe("");
    expect(digestTypeErrors("all good")).toBe("");
  });
});

describe("known fixes from the route.ts loop", () => {
  const ids = (out: string) => matchKnownFixes("npm run typecheck", out, 10).map((f) => f.id);

  it("explains the route handler shape for RouteHandlerConfig and duplicate GET errors", () => {
    expect(ids(TYPECHECK)).toContain("next-route-handler-shape");
    expect(ids("src/app/api/users/route.ts(35,23): error TS2323: Cannot redeclare exported variable 'GET'.")).toContain("next-route-handler-shape");
  });

  it("explains the next-auth session types, the Prisma 7 client arguments and the model type import", () => {
    expect(ids("src/lib/auth/session.ts(24,27): error TS2339: Property 'role' does not exist on type 'AdapterUser | User'.")).toContain("next-auth-session-types");
    expect(ids("src/lib/prisma.ts(3,23): error TS2554: Expected 1 arguments, but got 0.")).toContain("prisma7-client-args-missing");
    expect(ids("src/lib/api-client.ts(2,10): error TS2305: Module '\"@/generated/prisma/models/User\"' has no exported member 'User'.")).toContain("prisma-model-type-import");
  });

  it("explains the generated .js import and the Zod 4 issues property", () => {
    expect(ids("Error: Module not found: Can't resolve './enums.js'")).toContain("prisma-generated-js-extension");
    expect(ids("src/app/api/users/route.ts(127,54): error TS2339: Property 'errors' does not exist on type 'ZodError<unknown>'.")).toContain("zod-v4-issues");
  });

  it("does not turn the missing PrismaClient export into a model import problem", () => {
    expect(ids("error TS2305: Module '\"@prisma/client\"' has no exported member 'PrismaClient'.")).not.toContain("prisma-model-type-import");
  });
});
