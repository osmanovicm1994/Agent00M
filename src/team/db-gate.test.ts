import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { composeYaml, ensureLocalDatabase, findComposeService, findPostgresApp, readDatabaseUrl } from "./db-gate";
import type { Runner } from "./verify-gate";

let root: string;

function put(rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const SCHEMA = 'datasource db {\n  provider = "postgresql"\n}\n';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "db-gate-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A runner that records commands and answers by pattern. */
function fakeRunner(answers: Array<[RegExp, number]>, calls: string[]): Runner {
  return (command) => {
    calls.push(command);
    const hit = answers.find(([re]) => re.test(command));
    return { exitCode: hit ? hit[1] : 0, timedOut: false, output: "" };
  };
}

describe("project detection", () => {
  it("finds a PostgreSQL Prisma schema and ignores other projects", () => {
    expect(findPostgresApp(root)).toBeNull();
    put("apps/web/prisma/schema.prisma", SCHEMA);
    expect(findPostgresApp(root)).toBe(path.join(root, "apps/web"));
  });

  it("reads DATABASE_URL from .env files", () => {
    put("apps/web/.env", 'DATABASE_URL="postgresql://u:p@localhost:5433/d"\n');
    expect(readDatabaseUrl(path.join(root, "apps/web"), root)).toBe("postgresql://u:p@localhost:5433/d");
  });

  it("finds the postgres service of an existing compose file", () => {
    put("docker-compose.yml", "services:\n  web:\n    image: node:22\n  database:\n    image: postgres:16\n");
    expect(findComposeService(root)).toEqual({ file: "docker-compose.yml", service: "database" });
  });

  it("writes credentials and port of DATABASE_URL into the compose file", () => {
    const yaml = composeYaml({ host: "localhost", port: 5433, user: "app", password: "secret", database: "cars" });
    expect(yaml).toContain('POSTGRES_USER: "app"');
    expect(yaml).toContain('"5433:5432"');
    expect(yaml).toContain("pg_isready -U app -d cars");
  });
});

describe("ensureLocalDatabase", () => {
  it("does nothing for a project without a PostgreSQL schema", async () => {
    const calls: string[] = [];
    const report = await ensureLocalDatabase(root, { runner: fakeRunner([], calls), probe: async () => false, pollMs: 0 });
    expect(report.status).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("leaves a remote database alone", async () => {
    put("apps/web/prisma/schema.prisma", SCHEMA);
    put("apps/web/.env", 'DATABASE_URL="postgresql://u:p@db.example.com:5432/d"\n');
    const calls: string[] = [];
    const report = await ensureLocalDatabase(root, { runner: fakeRunner([], calls), probe: async () => false, pollMs: 0 });
    expect(report.status).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("only migrates when the database already answers", async () => {
    put("apps/web/prisma/schema.prisma", SCHEMA);
    put("apps/web/.env", 'DATABASE_URL="postgresql://app:app@localhost:5432/app"\n');
    const calls: string[] = [];
    const report = await ensureLocalDatabase(root, { runner: fakeRunner([], calls), probe: async () => true, pollMs: 0 });
    expect(report.status).toBe("ready");
    expect(report.migrated).toBe(true);
    expect(calls.filter((c) => c.includes("migrate"))).toEqual(["npx prisma migrate dev --name init"]);
  });

  it("uses migrate deploy when migrations exist", async () => {
    put("apps/web/prisma/schema.prisma", SCHEMA);
    put("apps/web/prisma/migrations/20260101_init/migration.sql", "-- sql");
    put("apps/web/.env", 'DATABASE_URL="postgresql://app:app@localhost:5432/app"\n');
    const calls: string[] = [];
    await ensureLocalDatabase(root, { runner: fakeRunner([], calls), probe: async () => true, pollMs: 0 });
    expect(calls.filter((c) => c.includes("migrate"))).toEqual(["npx prisma migrate deploy"]);
  });

  it("writes the compose file and .env, starts the database and waits until it answers", async () => {
    put("apps/web/prisma/schema.prisma", SCHEMA);
    const calls: string[] = [];
    // nothing listens until `docker compose up` has run
    const probe = async (host: string): Promise<boolean> => host !== "::1" && calls.some((c) => c.includes("up -d"));
    const report = await ensureLocalDatabase(root, { runner: fakeRunner([], calls), probe, pollMs: 0 });
    expect(report.status).toBe("started");
    expect(report.migrated).toBe(true);
    expect(fs.existsSync(path.join(root, "docker-compose.yml"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "apps/web/.env"), "utf8")).toContain('DATABASE_URL="postgresql://app:app@localhost:5433/app"');
    expect(fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8")).toContain('"5433:5432"');
    expect(report.created.sort()).toEqual(["apps/web/.env", "docker-compose.yml"]);
    expect(calls.some((c) => c.includes("docker compose -f docker-compose.yml up -d db"))).toBe(true);
    expect(calls.some((c) => c.includes("pg_isready"))).toBe(true);
  });

  it("never takes the usual port 5432 for a new database, and skips ports that already answer", async () => {
    put("apps/web/prisma/schema.prisma", SCHEMA);
    const calls: string[] = [];
    const probe = async (host: string, port: number): Promise<boolean> => host !== "::1" && (port === 5433 || (port === 5434 && calls.some((c) => c.includes("up -d"))));
    const report = await ensureLocalDatabase(root, { runner: fakeRunner([], calls), probe, pollMs: 0 });
    expect(report.status).toBe("started");
    expect(fs.readFileSync(path.join(root, "apps/web/.env"), "utf8")).toContain("localhost:5434/app");
    expect(report.note).toContain("localhost:5434");
  });

  it("does not migrate into a database container of another project", async () => {
    put("apps/web/prisma/schema.prisma", SCHEMA);
    put("apps/web/.env", 'DATABASE_URL="postgresql://app:app@localhost:5432/app"\n');
    const calls: string[] = [];
    const runner: Runner = (command) => {
      calls.push(command);
      return { exitCode: 0, timedOut: false, output: command.startsWith("docker ps") ? "preobuci-postgres-1\n" : "" };
    };
    const report = await ensureLocalDatabase(root, { runner, probe: async () => true, pollMs: 0 });
    expect(report.status).toBe("failed");
    expect(report.migrated).toBeNull();
    expect(report.note).toContain("preobuci-postgres-1");
    expect(calls.some((c) => c.includes("migrate"))).toBe(false);
  });

  it("explains what to do when Docker is not running, without writing anything else", async () => {
    put("apps/web/prisma/schema.prisma", SCHEMA);
    put("apps/web/.env", 'DATABASE_URL="postgresql://app:app@localhost:5432/app"\n');
    const calls: string[] = [];
    const report = await ensureLocalDatabase(root, { runner: fakeRunner([[/docker info/, 1]], calls), probe: async () => false, pollMs: 0 });
    expect(report.status).toBe("docker-unavailable");
    expect(report.note).toContain("Docker Desktop");
    expect(fs.existsSync(path.join(root, "docker-compose.yml"))).toBe(false);
    expect(calls.some((c) => c.includes("migrate"))).toBe(false);
  });

  it("reports a failed migration but says the database itself is fine", async () => {
    put("apps/web/prisma/schema.prisma", SCHEMA);
    put("apps/web/.env", 'DATABASE_URL="postgresql://app:app@localhost:5432/app"\n');
    const report = await ensureLocalDatabase(root, { runner: fakeRunner([[/migrate/, 1]], []), probe: async () => true, pollMs: 0 });
    expect(report.status).toBe("ready");
    expect(report.migrated).toBe(false);
    expect(report.note).toContain("do not try to start the database again");
  });
});
