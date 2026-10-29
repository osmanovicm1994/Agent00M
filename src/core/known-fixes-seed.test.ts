import { describe, it, expect } from "vitest";
import { matchKnownFixes } from "./known-fixes";

describe("known fixes: seed script and @types/node", () => {
  it("recognises a seed script that cannot resolve its imports, before the generic prisma client rule", () => {
    const output =
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/src/generated/prisma/client.js' imported from /app/scripts/seed.mjs";
    const ids = matchKnownFixes("cd apps/web && npm run seed", output).map((f) => f.id);
    expect(ids[0]).toBe("seed-script-resolution");
  });

  it("recognises the alias error of ts-node", () => {
    const ids = matchKnownFixes("npx ts-node src/lib/seed.ts", "Error: Cannot find package '@/lib' imported from seed.ts").map((f) => f.id);
    expect(ids).toContain("seed-script-resolution");
  });

  it("does not claim a module error of another command", () => {
    const ids = matchKnownFixes("npm run build", "Error [ERR_MODULE_NOT_FOUND]: Cannot find module './x.js'").map((f) => f.id);
    expect(ids).not.toContain("seed-script-resolution");
  });

  it("tells how to fix vitest wanting a newer @types/node", () => {
    const output = [
      "npm error code ERESOLVE",
      "npm error Could not resolve dependency:",
      'npm error peerOptional @types/node@"^22.0.0 || >=24.0.0" from vitest@5.0.5',
    ].join("\n");
    const ids = matchKnownFixes("npm install bcryptjs", output).map((f) => f.id);
    expect(ids[0]).toBe("types-node-peer");
  });
});
