// Deploy path for a Docker + VPS setup (Next.js web, NestJS api, Caddy in front, database on Neon).
//
//  - deploy_template: standard files the agent adapts and writes with write_file (Dockerfiles, compose, Caddyfile,
//    CI workflow, .dockerignore). Small local models write these from memory unevenly; a reviewed starting point is safer.
//  - predeploy_check: read-only FACTS about the project's deploy files. It cannot build an image or reach a server, so
//    it never says "ready to deploy"; it lists what is wrong or missing and what it did not verify.
//
// Both are pure functions of the files in the workspace (no network, no commands), unit-tested in deploy.test.ts.

import * as fs from "fs";
import * as path from "path";
import type { ToolSchema } from "../llm/types";

// ---------------------------------------------------------------------------
// Templates (arrays of lines: GitHub's ${{ }} would clash with template literals)
// ---------------------------------------------------------------------------

interface Template {
  file: string;
  notes: string;
  lines: string[];
}

const TEMPLATES: Record<string, Template> = {
  "next-dockerfile": {
    file: "web/Dockerfile",
    notes:
      "Needs `output: 'standalone'` in next.config and a public/ folder (delete the public COPY line if there is none). NEXT_PUBLIC_* values are baked in at build time: pass them as build args. " +
      "If the lockfile is pnpm or yarn, change the install step. In a monorepo set the build context to the repo root and adjust the COPY paths.",
    lines: [
      "# syntax=docker/dockerfile:1",
      "FROM node:22-alpine AS deps",
      "WORKDIR /app",
      "COPY package.json package-lock.json ./",
      "RUN npm ci",
      "",
      "FROM node:22-alpine AS build",
      "WORKDIR /app",
      "COPY --from=deps /app/node_modules ./node_modules",
      "COPY . .",
      "ARG NEXT_PUBLIC_API_URL",
      "ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL",
      "RUN npm run build",
      "",
      "FROM node:22-alpine AS run",
      "WORKDIR /app",
      "ENV NODE_ENV=production",
      "ENV PORT=3000",
      "ENV HOSTNAME=0.0.0.0",
      "COPY --from=build /app/public ./public",
      "COPY --from=build --chown=node:node /app/.next/standalone ./",
      "COPY --from=build --chown=node:node /app/.next/static ./.next/static",
      "USER node",
      "EXPOSE 3000",
      "HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1",
      'CMD ["node", "server.js"]',
    ],
  },
  "nest-dockerfile": {
    file: "api/Dockerfile",
    notes:
      "Check the entry path: it is dist/main.js for a default Nest build, dist/src/main.js when tsconfig has no rootDir. Add a GET /health route (a Nest controller returning ok) for the healthcheck. " +
      "Prisma: uncomment the two Prisma lines. Run migrations as a separate one-off step (`prisma migrate deploy` from the build stage or CI), never on every container start.",
    lines: [
      "# syntax=docker/dockerfile:1",
      "FROM node:22-alpine AS build",
      "WORKDIR /app",
      "COPY package.json package-lock.json ./",
      "RUN npm ci",
      "COPY . .",
      "# Prisma only: RUN npx prisma generate",
      "RUN npm run build",
      "RUN npm prune --omit=dev",
      "",
      "FROM node:22-alpine AS run",
      "WORKDIR /app",
      "ENV NODE_ENV=production",
      "ENV PORT=4000",
      "COPY --from=build --chown=node:node /app/node_modules ./node_modules",
      "COPY --from=build --chown=node:node /app/dist ./dist",
      "COPY --from=build --chown=node:node /app/package.json ./",
      "# Prisma only: COPY --from=build --chown=node:node /app/prisma ./prisma",
      "USER node",
      "EXPOSE 4000",
      "HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:4000/health >/dev/null || exit 1",
      'CMD ["node", "dist/main.js"]',
    ],
  },
  compose: {
    file: "docker-compose.yml",
    notes:
      "Secrets live in api/.env and web/.env on the server (not in git, not in this file). DATABASE_URL points at Neon (pooled URL for the app). Replace example.com. " +
      "Only caddy publishes ports; web and api are reachable inside the compose network.",
    lines: [
      "services:",
      "  web:",
      "    build:",
      "      context: ./web",
      "      args:",
      "        NEXT_PUBLIC_API_URL: https://api.example.com",
      "    restart: unless-stopped",
      "    env_file: ./web/.env",
      "    expose:",
      '      - "3000"',
      "",
      "  api:",
      "    build:",
      "      context: ./api",
      "    restart: unless-stopped",
      "    env_file: ./api/.env",
      "    expose:",
      '      - "4000"',
      "",
      "  caddy:",
      "    image: caddy:2-alpine",
      "    restart: unless-stopped",
      "    ports:",
      '      - "80:80"',
      '      - "443:443"',
      "    volumes:",
      "      - ./Caddyfile:/etc/caddy/Caddyfile:ro",
      "      - caddy_data:/data",
      "      - caddy_config:/config",
      "    depends_on:",
      "      web:",
      "        condition: service_healthy",
      "      api:",
      "        condition: service_healthy",
      "",
      "volumes:",
      "  caddy_data:",
      "  caddy_config:",
    ],
  },
  caddyfile: {
    file: "Caddyfile",
    notes: "Caddy gets and renews TLS certificates itself once the DNS records of both names point at the server and ports 80 and 443 are open. Replace example.com.",
    lines: ["example.com {", "\treverse_proxy web:3000", "}", "", "api.example.com {", "\treverse_proxy api:4000", "}"],
  },
  "ci-workflow": {
    file: ".github/workflows/ci.yml",
    notes: "Runs typecheck, lint, tests and build for each app folder on every push and pull request. Scripts that do not exist are skipped (--if-present). Add an e2e job once Playwright tests exist.",
    lines: [
      "name: ci",
      "on:",
      "  push:",
      "    branches: [main]",
      "  pull_request:",
      "",
      "permissions:",
      "  contents: read",
      "",
      "jobs:",
      "  verify:",
      "    runs-on: ubuntu-latest",
      "    strategy:",
      "      fail-fast: false",
      "      matrix:",
      "        dir: [web, api]",
      "    defaults:",
      "      run:",
      "        working-directory: ${{ matrix.dir }}",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 22",
      "          cache: npm",
      "          cache-dependency-path: ${{ matrix.dir }}/package-lock.json",
      "      - run: npm ci",
      "      - run: npm run typecheck --if-present",
      "      - run: npm run lint --if-present",
      "      - run: npm test --if-present",
      "      - run: npm run build --if-present",
    ],
  },
  dockerignore: {
    file: ".dockerignore",
    notes: "Place one in every folder that is a Docker build context (web/ and api/).",
    lines: ["node_modules", ".git", ".next", "dist", "coverage", ".env", ".env.*", "!.env.example", "*.log", ".agent", "Dockerfile*", "docker-compose*.yml"],
  },
};

export const DEPLOY_TEMPLATE_NAMES = Object.keys(TEMPLATES);

export function runDeployTemplate(args: Record<string, unknown>): string {
  const name = String(args.name ?? "").trim().toLowerCase();
  const t = TEMPLATES[name];
  if (!t) return `TOOL ERROR: unknown template "${name}". Available: ${DEPLOY_TEMPLATE_NAMES.join(", ")}.`;
  return `Template ${name} (suggested path: ${t.file})\nAdapt to this project, then write it with write_file.\nNotes: ${t.notes}\n\n${t.lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// predeploy_check
// ---------------------------------------------------------------------------

export type CheckLevel = "pass" | "fail" | "warn";
export interface CheckResult {
  level: CheckLevel;
  id: string;
  message: string;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".agent", "uupm"]);

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// Folders that hold the apps of a monorepo: apps/web, apps/api, packages/x, services/x.
const MONOREPO_PARENTS = new Set(["apps", "packages", "services"]);

function subDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return []; // unreadable folder
  }
}

/** The root, its direct sub-folders, and the apps inside apps/, packages/ and services/; without dependency and build folders. */
function appDirs(root: string): string[] {
  const dirs = [root];
  for (const d of subDirs(root)) {
    dirs.push(d);
    if (MONOREPO_PARENTS.has(path.basename(d))) dirs.push(...subDirs(d));
  }
  return dirs;
}

function filesIn(dir: string, test: (name: string) => boolean): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && test(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

const SECRET_RES: [RegExp, string][] = [
  // No leading \b: POSTGRES_PASSWORD has no word boundary before PASSWORD. Values that start with $ (references) never match.
  [/(password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?[A-Za-z0-9/+_.\-]{8,}/i, "a literal credential"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/$]+:[^\s@/$]{3,}@/i, "a connection string with a password"],
  [/\b(AKIA[0-9A-Z]{16}|sk_live_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{20,})/, "a provider key"],
];

export function checkDeployReadiness(root: string): CheckResult[] {
  const out: CheckResult[] = [];
  const add = (level: CheckLevel, id: string, message: string) => out.push({ level, id, message });
  const rel = (f: string) => path.relative(root, f) || ".";
  const dirs = appDirs(root);

  const dockerfiles = dirs.flatMap((d) => filesIn(d, (n) => /^Dockerfile(\..+)?$/.test(n)));
  const composeFiles = dirs.slice(0, 1).flatMap((d) => filesIn(d, (n) => /^(docker-)?compose(\..+)?\.ya?ml$/.test(n)));
  const workflows = filesIn(path.join(root, ".github", "workflows"), (n) => /\.ya?ml$/.test(n));

  // Dockerfiles
  if (dockerfiles.length === 0) add("fail", "dockerfile", "No Dockerfile found in the project root or its app folders.");
  for (const f of dockerfiles) {
    const text = readText(f) ?? "";
    const name = rel(f);
    if (!/^USER\s+(?!root\b)\S+/im.test(text)) add("fail", "non-root", `${name}: the final image runs as root (no USER instruction).`);
    else add("pass", "non-root", `${name}: runs as a non-root user.`);
    const stages = new Set<string>();
    const loose: string[] = [];
    for (const l of text.split("\n")) {
      const m = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(l.trim());
      if (!m) continue;
      const image = m[1];
      const isEarlierStage = stages.has(image.toLowerCase());
      if (m[2]) stages.add(m[2].toLowerCase());
      if (isEarlierStage || image === "scratch" || image.startsWith("$") || image.includes("@")) continue;
      if (image.endsWith(":latest") || !image.includes(":")) loose.push(image);
    }
    if (loose.length) add("warn", "pinned-base", `${name}: base image without a version tag or with :latest (${loose.join(", ")}). Pin a major version, for example node:22-alpine.`);
    if (!/^HEALTHCHECK\s/im.test(text)) add("warn", "healthcheck", `${name}: no HEALTHCHECK (compose cannot wait for it, restarts cannot detect a hung process).`);
  }

  // .dockerignore next to each Dockerfile
  for (const dir of new Set(dockerfiles.map((f) => path.dirname(f)))) {
    const text = readText(path.join(dir, ".dockerignore"));
    const name = rel(path.join(dir, ".dockerignore"));
    if (text === null) add("fail", "dockerignore", `${name} is missing: node_modules, .git and .env would be copied into the image.`);
    else if (!/^node_modules\b/m.test(text) || !/^\.env\b/m.test(text)) add("fail", "dockerignore", `${name} must list node_modules and .env.`);
    else add("pass", "dockerignore", `${name} excludes node_modules and .env.`);
  }

  // Secrets in committed deploy files
  const scan = [...dockerfiles, ...composeFiles, ...workflows];
  const hits: string[] = [];
  for (const f of scan) {
    (readText(f) ?? "").split("\n").forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      for (const [re, what] of SECRET_RES) if (re.test(line)) hits.push(`${rel(f)}:${i + 1} (${what})`);
    });
  }
  if (hits.length) add("fail", "secrets", `Possible secrets in deploy files: ${hits.slice(0, 6).join("; ")}. Use env_file or CI secrets; the values are not shown here.`);
  else if (scan.length) add("pass", "secrets", "No literal credentials found in Dockerfiles, compose files or workflows.");

  // git hygiene
  const gitignore = readText(path.join(root, ".gitignore"));
  if (gitignore === null) add("warn", "gitignore", ".gitignore is missing.");
  else if (!/^\.env(\*|\.\*|\.local)?\s*$/m.test(gitignore)) add("fail", "gitignore-env", ".gitignore does not ignore .env files.");
  else add("pass", "gitignore-env", ".gitignore ignores .env files.");
  const hasExample = dirs.some((d) => fs.existsSync(path.join(d, ".env.example")));
  add(hasExample ? "pass" : "warn", "env-example", hasExample ? ".env.example documents the variables." : "No .env.example: list every required variable (names only) so the server can be set up.");

  // Compose
  if (composeFiles.length) {
    const text = composeFiles.map((f) => readText(f) ?? "").join("\n");
    add(/restart:\s*(unless-stopped|always|on-failure)/.test(text) ? "pass" : "warn", "restart", "compose restart policy " + (/restart:\s*(unless-stopped|always|on-failure)/.test(text) ? "is set." : "is missing: a crashed container stays down."));
    const published = (text.match(/^\s+-\s*["']?\d+:\d+["']?/gm) ?? []).length;
    if (/\b(5432|3306|6379|27017)\s*:/.test(text)) add("fail", "db-port", "A database port is published to the host: do not expose databases on a VPS.");
    else add("pass", "db-port", `No database port published (${published} published port mapping(s) in total).`);
  }

  // Next.js standalone output
  const usesNext = dirs.some((d) => /"next"\s*:/.test(readText(path.join(d, "package.json")) ?? ""));
  if (usesNext && dockerfiles.some((f) => /\.next\/standalone/.test(readText(f) ?? ""))) {
    const ok = dirs.some((d) => filesIn(d, (n) => /^next\.config\.(js|mjs|ts|cjs)$/.test(n)).some((f) => /standalone/.test(readText(f) ?? "")));
    add(ok ? "pass" : "fail", "next-standalone", ok ? "next.config sets output: 'standalone'." : "The Dockerfile copies .next/standalone but next.config does not set output: 'standalone': the build will not produce it.");
  }

  // CI
  if (workflows.length === 0) add("warn", "ci", "No GitHub Actions workflow in .github/workflows.");
  else {
    const text = workflows.map((f) => readText(f) ?? "").join("\n");
    const runsChecks = /\b(npm|pnpm|yarn)\s+(run\s+)?(test|typecheck|lint|build)\b/.test(text);
    add(runsChecks ? "pass" : "warn", "ci", runsChecks ? "A workflow runs tests, typecheck, lint or build." : "Workflows exist but none runs tests, typecheck, lint or build.");
  }
  return out;
}

export function runPredeployCheck(workspaceRoot: string): string {
  const results = checkDeployReadiness(workspaceRoot);
  const fails = results.filter((r) => r.level === "fail").length;
  const warns = results.filter((r) => r.level === "warn").length;
  const lines = results.map((r) => `${r.level.toUpperCase().padEnd(4)} ${r.id}: ${r.message}`);
  return [
    ...lines,
    "",
    `${fails} failed, ${warns} warning(s), ${results.filter((r) => r.level === "pass").length} passed.`,
    "NOT verified by this check: that the images build, that containers start and answer the healthcheck, DNS and TLS, firewall, database migrations on the server, backups, and secret values on the server.",
  ].join("\n");
}

export const deployToolSchemas: ToolSchema[] = [
  {
    name: "deploy_template",
    description: `Return a reviewed starting file for a Docker + VPS deploy (${DEPLOY_TEMPLATE_NAMES.join(", ")}). Read-only: adapt it to the project and write it with write_file.`,
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: `One of: ${DEPLOY_TEMPLATE_NAMES.join(", ")}` } },
      required: ["name"],
    },
  },
  {
    name: "predeploy_check",
    description:
      "Read-only facts about the project's deploy files: non-root user, .dockerignore, secrets in committed files, healthchecks, restart policy, published database ports, Next standalone output, CI. " +
      "Run it before saying the project is ready to deploy and fix every FAIL. It does not build images or reach a server, so report what it did not verify.",
    parameters: { type: "object", properties: {} },
  },
];
