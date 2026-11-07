import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildRunGuide, writeRunGuide, RUN_GUIDE_FILE } from "./run-guide";
import type { DbReport } from "./db-gate";
import type { VerifyReport } from "./verify-gate";

let root: string;

function put(rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const PKG = JSON.stringify({
  dependencies: { next: "16.0.0" },
  scripts: { dev: "next dev", build: "next build", typecheck: "tsc --noEmit", seed: "tsx prisma/seed.ts" },
});

function fullProject(): void {
  put("apps/web/package.json", PKG);
  put("apps/web/prisma/schema.prisma", 'datasource db {\n  provider = "postgresql"\n}\n');
  put("apps/web/prisma/migrations/20260101_init/migration.sql", "-- sql");
  put("apps/web/prisma/seed.ts", 'const admin = { email: "admin@example.com", password: "secret" };');
  put("apps/web/.env", 'DATABASE_URL="postgresql://app:app@localhost:5433/app"\nSESSION_SECRET=abc\n');
  put("docker-compose.yml", "services:\n  db:\n    image: postgres:17-alpine\n");
  put("apps/web/src/app/page.tsx", "export default () => null;");
  put("apps/web/src/app/listings/page.tsx", "export default () => null;");
  put("apps/web/src/app/admin/page.tsx", "export default () => null;");
  put("apps/web/src/app/api/listings/route.ts", "export async function GET() {}");
}

const noInput = (): { root: string; db: DbReport | null; checks: VerifyReport | null; deadLinks: string[] } => ({ root, db: null, checks: null, deadLinks: [] });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "run-guide-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("buildRunGuide", () => {
  it("returns null when the project has no runnable app", () => {
    expect(buildRunGuide(noInput())).toBeNull();
    put("apps/web/package.json", JSON.stringify({ dependencies: { next: "16" }, scripts: { build: "next build" } }));
    expect(buildRunGuide(noInput())).toBeNull();
  });

  it("lists install, database, migration, seed, start and pages in order, with commands that exist", () => {
    fullProject();
    const md = buildRunGuide(noInput())!;
    const at = (s: string): number => md.indexOf(s);
    expect(at("npm install")).toBeGreaterThan(-1);
    expect(at("docker compose -f docker-compose.yml up -d db")).toBeGreaterThan(at("npm install"));
    expect(at("npx prisma migrate deploy")).toBeGreaterThan(at("docker compose"));
    expect(at("npm run seed")).toBeGreaterThan(at("npx prisma migrate deploy"));
    expect(at("npm run dev")).toBeGreaterThan(at("npm run seed"));
    expect(md).toContain("cd apps/web");
    expect(md).toContain("http://localhost:3000");
    expect(md).toContain("http://localhost:3000/listings");
    expect(md).toContain("`/api/listings`");
    expect(md).toContain("Docker Desktop");
    expect(md).toContain("port 5433");
  });

  it("names the staff screens and the seeded accounts, but never prints a password or an env value", () => {
    fullProject();
    const md = buildRunGuide(noInput())!;
    expect(md).toContain("`/admin`");
    expect(md).toContain("admin@example.com");
    expect(md).not.toContain("secret");
    expect(md).not.toContain("abc");
    expect(md).toContain("`SESSION_SECRET`");
  });

  it("leaves out the database steps for a project without PostgreSQL", () => {
    put("apps/web/package.json", JSON.stringify({ dependencies: { next: "16" }, scripts: { dev: "next dev -p 4000" } }));
    put("apps/web/src/app/page.tsx", "export default () => null;");
    const md = buildRunGuide(noInput())!;
    expect(md).not.toContain("docker");
    expect(md).not.toContain("prisma");
    expect(md).toContain("http://localhost:4000");
  });

  it("says plainly what was not verified", () => {
    fullProject();
    const checks: VerifyReport = {
      ok: false,
      results: [{ dir: "apps/web", command: "npm run typecheck", ok: false, exitCode: 2, timedOut: false, output: "" }],
    };
    const md = buildRunGuide({ ...noInput(), checks, deadLinks: ["apps/web/src/app/page.tsx -> /nowhere"] })!;
    expect(md).toContain("FAILED");
    expect(md).toContain("/nowhere");
  });
});

describe("writeRunGuide", () => {
  it("writes run.md at the workspace root", () => {
    fullProject();
    expect(writeRunGuide(noInput())).toBe(RUN_GUIDE_FILE);
    expect(fs.readFileSync(path.join(root, RUN_GUIDE_FILE), "utf8")).toContain("# How to run this project");
  });

  it("writes nothing without a runnable app", () => {
    expect(writeRunGuide(noInput())).toBeNull();
    expect(fs.existsSync(path.join(root, RUN_GUIDE_FILE))).toBe(false);
  });
});
