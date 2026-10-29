// src/team/db-gate.ts
//
// "Why does the agent not start Postgres?" Nobody was told to. The planner wrote no task for it, the database engineer only
// writes the schema, and the migration then failed with P1001 ("can't reach database server") until the loop guard stopped
// the run. Seed scripts and integration tests need a running database as much as the migration does.
//
// This gate does it deterministically, in code, not by asking a small model to remember: after the database task it checks
// whether the project needs a local PostgreSQL, starts one with Docker Compose when it is not running, applies the migrations
// and returns a short note for the other agents ("the database is running, do not start or migrate it yourself").
//
// It touches nothing when the project has no PostgreSQL schema or when DATABASE_URL points to a remote host. Docker, the file
// system and the network probe are injected, so the logic is unit-tested without a real Docker.

import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { candidateAppDirs } from "./scaffold-gate";
import { shellRunner, tailOf, type Runner } from "./verify-gate";

export type DbStatus = "skipped" | "ready" | "started" | "docker-unavailable" | "failed";

export interface DbReport {
  status: DbStatus;
  /** True when migrations were applied by this gate, false when that step failed, null when it did not run. */
  migrated: boolean | null;
  /** One short paragraph for the other agents and the delivery report. */
  note: string;
  /** Files this gate created (relative to the workspace). */
  created: string[];
}

export type Probe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export interface DbGateOptions {
  runner?: Runner;
  probe?: Probe;
  /** Wait between readiness checks. Tests pass 0. */
  pollMs?: number;
  /** How long to wait for the database to accept connections. */
  readyTimeoutMs?: number;
  log?: (line: string) => void;
}

// A project's own database starts at 5433 and counts up: 5432 is where another project's (or the person's own) PostgreSQL usually
// already runs, and migrating a new schema into somebody else's database must never happen by accident.
const FIRST_PORT = 5433;
const LAST_PORT = 5440;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const COMPOSE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

export const tcpProbe: Probe = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** The folder with a Prisma schema whose datasource is PostgreSQL, or null. */
export function findPostgresApp(root: string): string | null {
  for (const dir of candidateAppDirs(root)) {
    const schema = read(path.join(dir, "prisma", "schema.prisma"));
    if (/datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(postgresql|postgres)"/s.test(schema)) return dir;
  }
  return null;
}

/** DATABASE_URL from .env.local / .env of the app or the workspace root (the code may read them; the agents may not). */
export function readDatabaseUrl(appDir: string, root: string): string | null {
  for (const dir of [appDir, root]) {
    for (const name of [".env.local", ".env"]) {
      const m = /^\s*DATABASE_URL\s*=\s*["']?([^"'\r\n#]+?)["']?\s*(?:#.*)?$/m.exec(read(path.join(dir, name)));
      if (m) return m[1].trim();
    }
  }
  return null;
}

interface DbTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

function parseTarget(url: string): DbTarget | null {
  try {
    const u = new URL(url);
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    return {
      host: u.hostname,
      port: Number(u.port) || 5432,
      user: decodeURIComponent(u.username) || "postgres",
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, "") || "postgres",
    };
  } catch {
    return null;
  }
}

/** The compose file of the workspace and the name of its PostgreSQL service, when it has one. */
export function findComposeService(root: string): { file: string; service: string | null } | null {
  for (const name of COMPOSE_NAMES) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    let service: string | null = null;
    let current: string | null = null;
    for (const line of read(file).split("\n")) {
      const s = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (s) current = s[1];
      else if (current && /^\s+image:\s*["']?(postgres|postgis\/postgis|pgvector\/pgvector)/i.test(line)) {
        service = current;
        break;
      }
    }
    return { file: name, service };
  }
  return null;
}

/** The compose file the gate writes when there is none. Credentials and port come from DATABASE_URL, so both always agree. */
export function composeYaml(t: DbTarget): string {
  const q = (s: string): string => JSON.stringify(s);
  return [
    "# Local development database. Started by the team agent; stop it with: docker compose stop db",
    "services:",
    "  db:",
    "    image: postgres:17-alpine",
    "    environment:",
    `      POSTGRES_USER: ${q(t.user)}`,
    `      POSTGRES_PASSWORD: ${q(t.password)}`,
    `      POSTGRES_DB: ${q(t.database)}`,
    "    ports:",
    `      - "${t.port}:5432"`,
    "    volumes:",
    "      - pgdata:/var/lib/postgresql/data",
    "    healthcheck:",
    `      test: ["CMD-SHELL", ${q(`pg_isready -U ${t.user} -d ${t.database}`)}]`,
    "      interval: 5s",
    "      timeout: 3s",
    "      retries: 10",
    "volumes:",
    "  pgdata:",
    "",
  ].join("\n");
}

function hasMigrations(appDir: string): boolean {
  const dir = path.join(appDir, "prisma", "migrations");
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "migration.sql")));
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function ensureGitignore(root: string, entry: string): void {
  const file = path.join(root, ".gitignore");
  const text = read(file);
  if (text.split("\n").some((l) => l.trim() === entry)) return;
  try {
    fs.writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${entry}\n`);
  } catch {
    // a missing .gitignore entry is not worth stopping for
  }
}

const skipped = (note: string): DbReport => ({ status: "skipped", migrated: null, note, created: [] });

/**
 * Makes sure a local PostgreSQL is running for the project and its migrations are applied. Never throws.
 * Safe to call again: a database that already answers is left alone and only missing migrations are applied.
 */
export async function ensureLocalDatabase(root: string, opts: DbGateOptions = {}): Promise<DbReport> {
  if (process.env.AGENT_TEAM_DB === "0") return skipped("the database gate is switched off (AGENT_TEAM_DB=0)");
  const run = opts.runner ?? shellRunner;
  const probe = opts.probe ?? tcpProbe;
  const log = opts.log ?? (() => {});
  const pollMs = opts.pollMs ?? 2000;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
  const rel = (f: string): string => path.relative(root, f).split(path.sep).join("/");
  const created: string[] = [];

  try {
    const appDir = findPostgresApp(root);
    if (!appDir) return skipped("the project has no PostgreSQL Prisma schema yet");

    // Docker Desktop may listen on IPv6 only (`*:postgresql` in lsof): try both loopback addresses before deciding nothing answers.
    const answersOn = async (port: number): Promise<boolean> => (await probe("127.0.0.1", port, 1500)) || (await probe("::1", port, 1500));

    let url = readDatabaseUrl(appDir, root);
    if (!url) {
      // No URL yet: pick the first free port from 5433 and write the URL to the app's .env, so migrate and the app use the same one.
      let port = FIRST_PORT;
      while (port < LAST_PORT && (await answersOn(port))) port++;
      url = `postgresql://app:app@localhost:${port}/app`;
      const envFile = path.join(appDir, ".env");
      fs.writeFileSync(envFile, `${read(envFile)}${read(envFile) && !read(envFile).endsWith("\n") ? "\n" : ""}DATABASE_URL="${url}"\n`);
      ensureGitignore(root, ".env");
      created.push(rel(envFile));
      log(`wrote DATABASE_URL (local development) to ${rel(envFile)}`);
    }
    const target = parseTarget(url);
    if (!target) return skipped("DATABASE_URL is not a PostgreSQL URL");
    if (!LOCAL_HOSTS.has(target.host)) return skipped(`DATABASE_URL points to ${target.host}, not to this computer: the team does not start or change a remote database`);

    const where = `${target.host}:${target.port}`;
    let started = false;

    const answers = (): Promise<boolean> => answersOn(target.port);

    if (!(await answers())) {
      // 1. Docker must answer.
      const info = await run('docker info --format "{{.ServerVersion}}"', root, 30_000);
      if (info.exitCode !== 0) {
        return {
          status: "docker-unavailable",
          migrated: null,
          created,
          note:
            `No database answers at ${where} and Docker is not running (${tailOf(info.output, 200).split("\n").pop() || "docker info failed"}). ` +
            "Start Docker Desktop (wait until it says it is running), then run /tasks resume. Do NOT run migrate or seed until then: they need the database.",
        };
      }

      // 2. A compose file with a PostgreSQL service: the existing one, else the one written here.
      let compose = findComposeService(root);
      if (!compose) {
        const file = path.join(root, "docker-compose.yml");
        fs.writeFileSync(file, composeYaml(target));
        created.push(rel(file));
        log("wrote docker-compose.yml with a db service");
        compose = { file: "docker-compose.yml", service: "db" };
      }
      if (!compose.service) {
        return {
          status: "failed",
          migrated: null,
          created,
          note: `${compose.file} exists but has no PostgreSQL service, so the team did not change it. Add a postgres service or start your own database at ${where}.`,
        };
      }

      // 3. Start it and wait until it accepts connections.
      const up = await run(`docker compose -f ${compose.file} up -d ${compose.service}`, root, 300_000);
      if (up.exitCode !== 0) {
        return {
          status: "failed",
          migrated: null,
          created,
          note: `docker compose could not start the database: ${tailOf(up.output, 600)}`,
        };
      }
      started = true;
      const deadline = Date.now() + readyTimeoutMs;
      let ready = false;
      for (;;) {
        const r = await run(`docker compose -f ${compose.file} exec -T ${compose.service} pg_isready -U ${target.user} -d ${target.database}`, root, 20_000);
        if (r.exitCode === 0 && (await answers())) {
          ready = true;
          break;
        }
        if (Date.now() >= deadline) break;
        await sleep(pollMs);
      }
      if (!ready) {
        return {
          status: "failed",
          migrated: null,
          created,
          note: `The database container started but did not accept connections within ${Math.round(readyTimeoutMs / 1000)}s (port ${target.port} may be used by another program: check with lsof -i :${target.port}).`,
        };
      }
    }

    // A database that was already answering may belong to ANOTHER project (a container of someone else's compose project on the same
    // port). Migrating this schema into it would change that project's data, so it is only used when the person allows it.
    if (!started && process.env.AGENT_TEAM_DB_ALLOW_FOREIGN !== "1") {
      const owner = await run(`docker ps --filter publish=${target.port} --format "{{.Names}}"`, root, 20_000);
      const names = owner.exitCode === 0 ? owner.output.split("\n").map((s) => s.trim()).filter(Boolean) : [];
      const project = path.basename(root).toLowerCase().replace(/[^a-z0-9_-]/g, "");
      if (names.length > 0 && !names.some((n) => n.startsWith(`${project}-`))) {
        return {
          status: "failed",
          migrated: null,
          created,
          note:
            `Port ${target.port} is used by the container ${names[0]}, which does not belong to this project, so the team did not migrate into it. ` +
            `Change the port in DATABASE_URL (apps/web/.env, for example to ${FIRST_PORT}) and run /tasks resume: the team then starts its own database. ` +
            "If you really want to use that database, set AGENT_TEAM_DB_ALLOW_FOREIGN=1.",
        };
      }
    }

    // 4. Migrations: existing ones are applied; with none, the first one is created from the schema.

    const command = hasMigrations(appDir) ? "npx prisma migrate deploy" : "npx prisma migrate dev --name init";
    const mig = await run(command, appDir, 180_000);
    if (mig.exitCode !== 0) {
      return {
        status: started ? "started" : "ready",
        migrated: false,
        created,
        note:
          `Local PostgreSQL is running at ${where}, but \`${command}\` failed: ${tailOf(mig.output, 700)}\n` +
          "The database itself is fine: fix the schema or the migration, do not try to start the database again.",
      };
    }
    return {
      status: started ? "started" : "ready",
      migrated: true,
      created,
      note: `Local PostgreSQL is running at ${where} and the migrations are applied (\`${command}\`). Do not start the database or run migrate init yourself; run \`npx prisma migrate dev --name <change>\` only when you change the schema.`,
    };
  } catch (err: any) {
    return { status: "failed", migrated: null, created, note: `the database gate stopped unexpectedly: ${String(err?.message ?? err).slice(0, 300)}` };
  }
}
