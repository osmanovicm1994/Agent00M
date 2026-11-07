import { describe, expect, it } from "vitest";
import { KNOWN_FIX_SHOW_LIMIT, formatKnownFixes, knownFixStopText, matchKnownFixes } from "./known-fixes";

const ids = (command: string, output: string) => matchKnownFixes(command, output).map((f) => f.id);

describe("known fixes from a real run", () => {
  it("recognises # comments in schema.prisma", () => {
    const out = [
      "Error code: P1012",
      "error: Error validating: This line is not a valid field or attribute definition.",
      "  -->  prisma/schema.prisma:34",
      "   | ",
      "33 |   sellerAddress    String",
      "34 |   sellerIdCardNo   String   # Broj licne karte",
    ].join("\n");
    expect(ids("npx prisma validate", out)).toEqual(["prisma-hash-comment"]);
    const text = formatKnownFixes(matchKnownFixes("npx prisma validate", out));
    expect(text).toContain("//");
    expect(text).toContain("WHOLE schema.prisma");
  });

  it("does not blame comments for other P1012 errors", () => {
    const out = "Error code: P1012\nerror: Error validating model \"Agreement\": The index definition refers to the unknown fields: chassisNumber.";
    expect(ids("npx prisma validate", out)).toEqual([]);
  });

  it("recognises the Prisma 7 datasource url error and gives the exact config", () => {
    const out = "error: The datasource property `url` is no longer supported in schema files. Move connection URLs for Migrate to `prisma.config.ts`";
    const fixes = matchKnownFixes("cd apps/web && npx prisma validate", out);
    expect(fixes[0].id).toBe("prisma7-datasource-url");
    const text = formatKnownFixes(fixes);
    expect(text).toContain('from "prisma/config"');
    expect(text).toContain("process.env.DATABASE_URL ??");
    expect(text).toContain("@prisma/adapter-pg");
  });

  it("recognises a wrong defineConfig import", () => {
    expect(ids("npx prisma validate", "Error: Cannot find module 'prisma/lib/cli'")).toEqual(["prisma-config-import"]);
    expect(ids("tsc", "prisma.config.ts(1,10): error TS2305: Module '\"prisma\"' has no exported member 'defineConfig'.")).toEqual(["prisma-config-import"]);
  });

  it("recognises the hookform resolvers conflict from the log, then falls back to the general rule", () => {
    const out = [
      "npm error code ERESOLVE",
      "npm error Could not resolve dependency:",
      "npm error peerOptional effect@\"^4.0.0\" from @hookform/resolvers@6.0.0",
    ].join("\n");
    const cmd = "cd apps/web && npm install @prisma/client next-auth zod react-hook-form @hookform/resolvers";
    expect(ids(cmd, out)[0]).toBe("hookform-resolvers-peer");
    // Already on v5 and still conflicting: the v5 advice would loop, so the general rule answers.
    expect(ids("npm install @hookform/resolvers@5", out)).toEqual(["npm-eresolve"]);
  });

  it("explains a general ERESOLVE with the conflicting line", () => {
    const out = "npm error code ERESOLVE\nnpm error Could not resolve dependency:\nnpm error peer react@\"^18\" from some-lib@1.0.0";
    const [fix] = matchKnownFixes("npm install some-lib", out);
    expect(fix.id).toBe("npm-eresolve");
    expect(formatKnownFixes([fix])).toContain("peer react");
    expect(formatKnownFixes([fix])).toContain("--legacy-peer-deps");
    expect(formatKnownFixes([fix])).toContain("Never --force");
  });

  it("recognises create-next-app name and folder problems", () => {
    expect(ids("npx create-next-app .", 'Could not create a project called "Kupoprodaja" because of npm naming restrictions:\n * name can no longer contain capital letters')).toEqual(["scaffold-name"]);
    expect(ids("npx create-next-app apps/web", "The application path is not writable, please check folder permissions")).toEqual(["scaffold-not-writable"]);
  });

  it("recognises Next build problems", () => {
    expect(ids("npm run build", "Failed to fetch Geist from Google Fonts.")).toEqual(["next-google-fonts"]);
    expect(ids("npm run build", "Error: Route \"/dyn\": Next.js encountered uncached or runtime data during prerendering.")).toEqual(["next-prerender-dynamic"]);
  });

  it("recognises database, script and port problems", () => {
    expect(ids("npx prisma migrate dev", "Error: P1001: Can't reach database server at `localhost:5432`")).toEqual(["db-unreachable"]);
    expect(ids("npm run dev:api", 'npm error Missing script: "dev:api"')).toEqual(["missing-script"]);
    const [port] = matchKnownFixes("npm run dev", "Error: listen EADDRINUSE: address already in use :::3000");
    expect(port.id).toBe("port-in-use");
    expect(port.title).toContain("3000");
  });

  it("recognises the missing environment variable in the Prisma config", () => {
    expect(ids("npx prisma generate", "Failed to load config file. PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL.")).toEqual(["prisma-env-missing"]);
  });

  it("recognises a client that was never generated", () => {
    expect(ids("npm run build", "Module '\"@prisma/client\"' has no exported member 'PrismaClient'.")).toEqual(["prisma-client-missing"]);
    expect(ids("node x.js", "Error: @prisma/client did not initialize yet. Please run \"prisma generate\"")).toEqual(["prisma-client-missing"]);
  });

  it("returns nothing for unknown output and caps the number of fixes", () => {
    expect(matchKnownFixes("ls", "nothing special")).toEqual([]);
    const both = "Cannot find module 'prisma/config'\nCannot resolve environment variable: DATABASE_URL\nP1001";
    expect(matchKnownFixes("x", both, 2)).toHaveLength(2);
  });
});

describe("stop text", () => {
  it("is written for the person and repeats the steps", () => {
    const [fix] = matchKnownFixes("npx prisma validate", "error: The datasource property `url` is no longer supported");
    const text = knownFixStopText(fix, "npx prisma validate");
    expect(text).toContain(String(KNOWN_FIX_SHOW_LIMIT));
    expect(text).toContain("What to do");
    expect(text).toContain("prisma.config.ts");
  });
});
