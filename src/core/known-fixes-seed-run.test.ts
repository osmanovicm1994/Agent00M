import { describe, it, expect } from "vitest";
import { matchKnownFixes } from "./known-fixes";
import { isDangerousCommand } from "./command-safety";

// Output copied from a real barbershop run: the seed used names the schema does not have, and the old hint said "cannot resolve its imports".
const TS_NAMES =
  "TSError: ⨯ Unable to compile TypeScript:\n" +
  "prisma/seed.ts(140,14): error TS2551: Property 'shopSettings' does not exist on type 'PrismaClient<never, GlobalOmitConfig | undefined, DefaultArgs>'. Did you mean 'shopSetting'?\n" +
  "prisma/seed.ts(159,11): error TS2353: Object literal may only specify known properties, and 'dayOfWeek' does not exist in type 'OpeningHourWhereUniqueInput'.\n" +
  "    at createTSError (node_modules/ts-node/src/index.ts:859:12)\n" +
  "  diagnosticCodes: [ 2551, 2353 ]";

describe("known fixes: seed that runs but fails", () => {
  it("a schema name mismatch is not reported as an import problem", () => {
    const ids = matchKnownFixes("npm run db:seed", TS_NAMES).map((f) => f.id);
    expect(ids[0]).toBe("seed-schema-mismatch");
    expect(ids).not.toContain("seed-script-resolution");
  });

  it("the same errors from the project typecheck get the same fix", () => {
    const out = "prisma/seed.ts(153,11): error TS2353: Object literal may only specify known properties, and 'dayOfWeek' does not exist in type 'OpeningHourWhereUniqueInput'.";
    expect(matchKnownFixes("npm run typecheck", out)[0]?.id).toBe("seed-schema-mismatch");
  });

  it("tells the agent not to use db pull", () => {
    const steps = matchKnownFixes("npm run db:seed", TS_NAMES)[0].steps.join("\n");
    expect(steps).toMatch(/db pull/);
    expect(steps).toMatch(/migrate dev/);
  });

  it("does not claim an unrelated type error in app code", () => {
    const out = "src/lib/auth.ts(14,38): error TS2339: Property 'get' does not exist on type 'Promise<ReadonlyRequestCookies>'.";
    expect(matchKnownFixes("npm run typecheck", out).map((f) => f.id)).not.toContain("seed-schema-mismatch");
  });

  it("an env that is not loaded gets its own fix", () => {
    const a = matchKnownFixes("npm run db:seed", "Error during seeding: Error: ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD must be set in the environment");
    expect(a[0]?.id).toBe("seed-env-not-loaded");
    const b = matchKnownFixes("npm run db:seed", "Error during seeding: Error: SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string");
    expect(b[0]?.id).toBe("seed-env-not-loaded");
    expect(a[0].steps.join("\n")).toMatch(/--env-file=\.env/);
  });

  it("the Prisma 7 'instantiated without any options' error gets the adapter fix", () => {
    const out = "PrismaClientInitializationError: PrismaClient was instantiated without any options. A driver adapter is required to connect to your database.";
    expect(matchKnownFixes("npm run db:seed", out)[0]?.id).toBe("prisma7-client-ctor");
  });

  it("a real unresolved import in a seed still gets the resolution fix", () => {
    const out = "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/src/generated/prisma/client.js' imported from /app/scripts/seed.mjs";
    expect(matchKnownFixes("npm run seed", out)[0]?.id).toBe("seed-script-resolution");
  });
});

describe("command safety: prisma db pull", () => {
  it.each(["npx prisma db pull", "cd apps/web && npx prisma db pull --force"])("asks before %s", (cmd) => {
    expect(isDangerousCommand(cmd)).toBe(true);
  });
  it.each(["npx prisma generate", "npx prisma validate", "npx prisma migrate dev --name add_shop_setting"])("lets %s run", (cmd) => {
    expect(isDangerousCommand(cmd)).toBe(false);
  });
});
