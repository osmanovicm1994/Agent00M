import { describe, it, expect } from "vitest";
import { adviseBeforeRun, isSingleFileTsc } from "./toolchain-doctor";

describe("isSingleFileTsc", () => {
  it("flags tsc with a file name, with or without npx and extra flags", () => {
    expect(isSingleFileTsc("cd apps/web && npx tsc --noEmit src/app/api/listings/route.ts")).toBe(true);
    expect(isSingleFileTsc("npx tsc --noEmit --skipLibCheck src/app/admin/page.tsx 2>&1 | head -5")).toBe(true);
    expect(isSingleFileTsc("tsc index.ts")).toBe(true);
  });

  it("allows tsc over the whole project", () => {
    expect(isSingleFileTsc("cd apps/web && npx tsc --noEmit")).toBe(false);
    expect(isSingleFileTsc("npx tsc --noEmit -p apps/web")).toBe(false);
    expect(isSingleFileTsc("npx tsc -b")).toBe(false);
    expect(isSingleFileTsc("npm run typecheck")).toBe(false);
  });

  it("does not react to other commands that mention a source file", () => {
    expect(isSingleFileTsc("cat src/app/page.tsx")).toBe(false);
    expect(isSingleFileTsc("npx tsx scripts/seed.ts")).toBe(false);
  });

  it("is refused before it runs, with the command to use instead", () => {
    const advice = adviseBeforeRun("npx tsc --noEmit src/a.ts", () => undefined);
    expect(advice?.diagnosis.kind).toBe("single-file-tsc");
    expect(advice?.refuse).toContain("npm run typecheck");
  });
});
