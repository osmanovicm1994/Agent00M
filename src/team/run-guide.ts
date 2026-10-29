// src/team/run-guide.ts
//
// run.md: the last thing the team writes, and only when every task of the plan finished. It tells the person exactly what to start
// and where to go: install, database (Docker and PostgreSQL when the project needs one), migrations, seed, the dev server and the
// addresses of the pages. The app may still have bugs; run.md says what the team could and could not verify.
//
// Everything in it is read from the project on disk (package.json scripts, the compose file, DATABASE_URL, the App Router folders),
// not written by the model, so a command in it is one that exists. A project without a runnable app gets no run.md.

import * as fs from "fs";
import * as path from "path";
import { candidateAppDirs } from "./scaffold-gate";
import { appRouterDir, collectRoutes, routeLabel, usesNext } from "./link-gate";
import { findComposeService, findPostgresApp, readDatabaseUrl, type DbReport } from "./db-gate";
import { summarizeChecks, type VerifyReport } from "./verify-gate";

export interface RunGuideInput {
  root: string;
  /** What the database gate reported, when it ran. */
  db: DbReport | null;
  /** The last typecheck/build run of the team, when there was one. */
  checks: VerifyReport | null;
  /** Links that still lead to a missing page ("file -> /target"). */
  deadLinks: string[];
}

export const RUN_GUIDE_FILE = "run.md";

interface AppInfo {
  dir: string;
  /** Folder relative to the workspace, "." for the root. */
  rel: string;
  scripts: Record<string, string>;
  hasPrismaSeed: boolean;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** The app to start: a Next.js folder with a dev script. */
function findApp(root: string): AppInfo | null {
  for (const dir of candidateAppDirs(root)) {
    const pkg = readJson(path.join(dir, "package.json"));
    if (!pkg || !pkg.scripts?.dev || !usesNext(dir)) continue;
    const prismaConfig = readText(path.join(dir, "prisma.config.ts"));
    return {
      dir,
      rel: path.relative(root, dir).split(path.sep).join("/") || ".",
      scripts: pkg.scripts,
      hasPrismaSeed: /\bseed\s*:/.test(prismaConfig),
    };
  }
  return null;
}

function devPort(dev: string): number {
  const m = /(?:^|\s)(?:-p|--port)[\s=]+(\d{2,5})\b/.exec(dev) ?? /\bPORT=(\d{2,5})\b/.exec(dev);
  return m ? Number(m[1]) : 3000;
}

/** Variable NAMES of the app's .env files (never the values). */
function envNames(dir: string): string[] {
  const names = new Set<string>();
  for (const f of [".env", ".env.local", ".env.example"]) {
    for (const m of readText(path.join(dir, f)).matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)) names.add(m[1]);
  }
  return [...names];
}

/** Emails written into the seed script, so the person knows which accounts to try. Passwords are left in the script. */
function seedAccounts(app: AppInfo, root: string): { file: string; emails: string[] } | null {
  const candidates = ["prisma/seed.ts", "prisma/seed.js", "prisma/seed.mjs", "src/lib/seed.ts", "scripts/seed.ts", "scripts/seed.mjs", "seed.ts"];
  for (const c of candidates) {
    const file = path.join(app.dir, c);
    if (!fs.existsSync(file)) continue;
    const emails = [...new Set([...readText(file).matchAll(/["'`]([\w.+-]+@[\w-]+(?:\.[\w-]+)+)["'`]/g)].map((m) => m[1]))].slice(0, 6);
    return { file: path.relative(root, file).split(path.sep).join("/"), emails };
  }
  return null;
}

const code = (lines: string[]): string => "```bash\n" + lines.join("\n") + "\n```";

/** The contents of run.md, or null when there is no runnable app. Pure: reads the project, writes nothing. */
export function buildRunGuide(input: RunGuideInput): string | null {
  const { root } = input;
  const app = findApp(root);
  if (!app) return null;

  const cd = (): string[] => (app.rel === "." ? [] : [`cd ${app.rel}`]);
  const dbApp = findPostgresApp(root);
  const needsDb = dbApp !== null;
  const compose = needsDb ? findComposeService(root) : null;
  const url = needsDb && dbApp ? readDatabaseUrl(dbApp, root) : null;
  const dbPort = url ? /:(\d{2,5})\//.exec(url)?.[1] : undefined;
  const migrations = (() => {
    try {
      return fs.readdirSync(path.join(app.dir, "prisma", "migrations"), { withFileTypes: true }).some((e) => e.isDirectory());
    } catch {
      return false;
    }
  })();
  const seedCommand = app.scripts.seed ? "npm run seed" : app.hasPrismaSeed ? "npx prisma db seed" : null;
  const port = devPort(String(app.scripts.dev));
  const seed = seedAccounts(app, root);

  const out: string[] = [];
  out.push("# How to run this project", "");
  out.push("Written by the team agent after all planned tasks finished. The app can still contain bugs: the section \"What was verified\" says what was checked.", "");

  // 1. Requirements
  out.push("## 1. Before you start", "");
  out.push("- Node.js and npm (the same major version the project was built with; `node -v`).");
  if (needsDb) out.push("- Docker Desktop, started and running (`docker info` must print a version), because the app needs a PostgreSQL database.");
  out.push("");

  // 2. Install
  out.push("## 2. Install", "", code([...cd(), "npm install"]), "");

  // 3. Environment
  const names = envNames(app.dir);
  if (names.length > 0) {
    out.push("## 3. Environment variables", "");
    out.push(`The file \`${app.rel === "." ? "" : `${app.rel}/`}.env\` (or \`.env.local\`) holds: ${names.map((n) => `\`${n}\``).join(", ")}. It is not committed. If it is missing, copy \`.env.example\` and fill in the values.`, "");
  }

  // 4. Database
  let step = names.length > 0 ? 4 : 3;
  if (needsDb && dbApp) {
    out.push(`## ${step}. Database (PostgreSQL in Docker)`, "");
    if (compose?.service) {
      out.push(`From the project folder${dbPort ? ` (the database listens on port ${dbPort})` : ""}:`, "");
      out.push(code([`docker compose -f ${compose.file} up -d ${compose.service}`, `docker compose -f ${compose.file} ps   # wait until the service is "healthy"`]), "");
    } else {
      out.push("There is no compose file with a PostgreSQL service in the project. Start a PostgreSQL that matches `DATABASE_URL`, then continue.", "");
    }
    const dbCd = path.relative(root, dbApp).split(path.sep).join("/");
    out.push("Create the tables:", "");
    out.push(code([...(dbCd ? [`cd ${dbCd}`] : []), "npx prisma generate", migrations ? "npx prisma migrate deploy" : "npx prisma migrate dev --name init"]), "");
    out.push("Stop the database when you are done: `docker compose stop` (never `docker compose down -v`: it deletes the data).", "");
    step++;
  }

  // 5. Seed
  if (seedCommand) {
    out.push(`## ${step}. Test data`, "", code([...cd(), seedCommand]), "");
    if (seed && seed.emails.length > 0) out.push(`The seed script \`${seed.file}\` creates accounts for: ${seed.emails.map((e) => `\`${e}\``).join(", ")}. The passwords are in that file.`, "");
    else if (seed) out.push(`The data is defined in \`${seed.file}\`.`, "");
    step++;
  } else if (needsDb) {
    out.push(`## ${step}. Test data`, "", "The project has no seed command (no `seed` script in package.json). The database starts empty.", "");
    step++;
  }

  // 6. Start
  out.push(`## ${step}. Start the app`, "", code([...cd(), "npm run dev"]), "", `Then open http://localhost:${port}`, "");
  step++;

  // 7. Pages
  const appDir = appRouterDir(app.dir);
  if (appDir) {
    const routes = collectRoutes(appDir).map(routeLabel);
    const pages = routes.filter((r) => r !== "/api" && !r.startsWith("/api/"));
    const api = routes.filter((r) => r === "/api" || r.startsWith("/api/"));
    if (pages.length > 0) {
      out.push(`## ${step}. Where to go`, "");
      for (const p of pages) out.push(`- http://localhost:${port}${p === "/" ? "" : p}`);
      out.push("");
      const admin = pages.filter((p) => /^\/(admin|dashboard)(\/|$)/.test(p));
      if (admin.length > 0) out.push(`Staff screens (not meant to be linked from the public pages): ${admin.map((p) => `\`${p}\``).join(", ")}. Sign in with an admin account first.`, "");
      if (api.length > 0) out.push(`API routes: ${api.map((r) => `\`${r}\``).join(", ")}.`, "");
      step++;
    }
  }

  // 8. Checks
  const checkLines: string[] = [];
  if (app.scripts.typecheck) checkLines.push("npm run typecheck");
  if (app.scripts.test) checkLines.push("npm test");
  if (app.scripts.build) checkLines.push("npm run build");
  if (checkLines.length > 0) out.push(`## ${step}. Checks`, "", code([...cd(), ...checkLines]), "");

  // Honest status
  out.push("## What was verified", "");
  if (input.checks) out.push(`- Project checks when this file was written: ${summarizeChecks(input.checks)}.`);
  else out.push("- No typecheck or build was run by the team.");
  if (input.db && input.db.status !== "skipped") out.push(`- Database: ${input.db.note}`);
  if (input.deadLinks.length > 0) out.push(`- Links that still lead to a missing page: ${input.deadLinks.slice(0, 8).join("; ")}.`);
  out.push("- Nothing here replaces trying the app yourself: click through the pages above and report what fails.", "");

  return out.join("\n");
}

/** Writes run.md at the workspace root. Returns the relative file name, or null when there was nothing to write or the write failed. */
export function writeRunGuide(input: RunGuideInput): string | null {
  try {
    const text = buildRunGuide(input);
    if (!text) return null;
    fs.writeFileSync(path.join(input.root, RUN_GUIDE_FILE), text);
    return RUN_GUIDE_FILE;
  } catch {
    return null;
  }
}
