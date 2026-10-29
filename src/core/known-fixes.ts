// src/core/known-fixes.ts
//
// Failures the agent has met before, with the exact fix. Matching is a pure function of the command and its output,
// so a known failure costs zero model calls: the fix is attached to the tool result and the agent applies it, instead of
// starting a debug run that spends tens of calls rediscovering it. The knowledge file 13-delivery/05-known-fixes.md
// lists the same cases for the model.
//
// Order matters: specific rules come before general ones. At most `max` fixes are returned.

export interface KnownFix {
  id: string;
  title: string;
  steps: string[];
}

interface Rule {
  id: string;
  test(command: string, output: string): boolean;
  fix(output: string): Omit<KnownFix, "id">;
}

const PRISMA_CONFIG_SNIPPET =
  'import "dotenv/config";\n' +
  'import { defineConfig } from "prisma/config";\n' +
  "export default defineConfig({\n" +
  '  schema: "prisma/schema.prisma",\n' +
  '  migrations: { path: "prisma/migrations" },\n' +
  '  datasource: { url: process.env.DATABASE_URL ?? "postgresql://user:password@localhost:5432/app" },\n' +
  "});";

function dependencyConflict(output: string): string {
  const m = /Could not resolve dependency:\s*\n(?:npm (?:error|ERR!)\s*)?([^\n]*)/i.exec(output);
  return m ? m[1].trim() : "";
}

// Packages that ship their own TypeScript types: an @types/<name> package for them does not exist or is an empty stub.
export const SELF_TYPED_PACKAGES = ["zod", "bcryptjs", "jose", "pdf-lib", "next-auth", "@prisma/client", "date-fns", "react-hook-form", "@hookform/resolvers"];

const RULES: Rule[] = [
  {
    id: "prisma-hash-comment",
    test: (_c, o) => /P1012|not a valid field or attribute definition/.test(o) && /^\s*\d+\s*\|[^\n]*\s#/m.test(o),
    fix: () => ({
      title: "schema.prisma uses # comments",
      steps: [
        "In schema.prisma a comment starts with // (or /// for documentation). # is not a comment.",
        "Rewrite the WHOLE schema.prisma in one write_file with every # comment changed to //. Do not edit line by line.",
        "Then run: npx prisma validate (once).",
      ],
    }),
  },
  {
    id: "prisma7-datasource-url",
    test: (_c, o) => /datasource property `?url`? is no longer supported/i.test(o),
    fix: () => ({
      title: "Prisma 7: the database URL moved out of schema.prisma",
      steps: [
        'Delete the line  url = env("DATABASE_URL")  from the datasource block in schema.prisma (keep provider = "postgresql").',
        "Create prisma.config.ts next to package.json with exactly:\n" + PRISMA_CONFIG_SNIPPET,
        "Make sure prisma 7 and dotenv are installed in that app: npm install -D prisma@7 && npm install dotenv @prisma/client@7 @prisma/adapter-pg@7 pg",
        'Create the client with the adapter: import { PrismaPg } from "@prisma/adapter-pg"; new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) }). Import PrismaClient from the generator output folder, not from @prisma/client.',
        "Then: npx prisma validate && npx prisma generate",
      ],
    }),
  },
  {
    id: "prisma-config-import",
    test: (_c, o) => /Cannot find module 'prisma(\/[^']*)?'|no exported member '?defineConfig'?|'"prisma"' has no exported member/.test(o),
    fix: () => ({
      title: "Wrong import for the Prisma config",
      steps: [
        'The only valid import is: import { defineConfig } from "prisma/config"  (also exports env). Not "prisma", not "prisma/lib/cli", not "@prisma/client".',
        "The prisma package must be installed in the same app folder: npm install -D prisma@7",
        "Rewrite prisma.config.ts with the exact content:\n" + PRISMA_CONFIG_SNIPPET,
      ],
    }),
  },
  {
    id: "prisma-env-missing",
    test: (_c, o) => /Cannot resolve environment variable:?\s*DATABASE_URL/i.test(o),
    fix: () => ({
      title: "env() throws when DATABASE_URL is not set",
      steps: [
        'In prisma.config.ts replace env("DATABASE_URL") with: process.env.DATABASE_URL ?? "postgresql://user:password@localhost:5432/app"',
        "validate and generate then work without a .env file. migrate needs the real URL from the person.",
      ],
    }),
  },
  {
    id: "seed-script-resolution",
    // A seed script that cannot find its imports: ts-node does not read the "@/" alias, a .mjs file cannot import a .ts client, and a
    // path written from the wrong folder resolves to nothing. Must come before prisma-client-missing, whose advice does not fit here.
    test: (c, o) => /\bseed\b/i.test(c) && /ERR_MODULE_NOT_FOUND|Cannot find package '@\/|Cannot find module [^\n]*seed|TSError|Unknown file extension|ts-node/i.test(o),
    fix: () => ({
      title: "The seed script cannot resolve its imports",
      steps: [
        "Do not use ts-node and do not write the seed as .mjs/.js: the Prisma 7 client in src/generated/prisma is TypeScript. Use tsx: npm install -D tsx (add --legacy-peer-deps only if npm reports ERESOLVE).",
        "Put the script at prisma/seed.ts (next to schema.prisma) and import with a RELATIVE path from that file, without a file extension: import { PrismaClient } from \"../src/generated/prisma/client\". A relative path is resolved from the folder of the script, not from where you run the command.",
        'Create the client with the adapter: import { PrismaPg } from "@prisma/adapter-pg"; new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) }). Hash passwords with bcryptjs directly in the script; do not import app code that uses the "@/" alias or "server-only".',
        'package.json: "seed": "tsx prisma/seed.ts" (and in prisma.config.ts: migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" }). Load .env with: import "dotenv/config" as the first line.',
        "Run it once. If it fails with P1001 the database is not running: that is an environment problem, report it (see db-unreachable) instead of rewriting the script.",
      ],
    }),
  },
  {
    id: "prisma-client-missing",
    test: (_c, o) => /@prisma\/client did not initialize yet|has no exported member '?PrismaClient'?|Cannot find module '[^']*generated\/prisma[^']*'/.test(o),
    fix: () => ({
      title: "Prisma client not generated (or imported from the wrong place)",
      steps: [
        "Run npx prisma generate in the folder that contains schema.prisma (or prisma.config.ts).",
        "Prisma 7 (generator provider = prisma-client with an output folder): import PrismaClient from that output folder, for example @/generated/prisma/client. Prisma 6 and older import it from @prisma/client.",
      ],
    }),
  },
  {
    id: "db-unreachable",
    test: (_c, o) => /\bP1001\b|Can't reach database server|ECONNREFUSED[^\n]*:5432/.test(o),
    fix: () => ({
      title: "No database is answering",
      steps: [
        "Do NOT run migrate again. The schema, validate and generate do not need a database.",
        "In team mode the team starts the local database itself (docker-compose.yml, docker compose up, migrate) right after the database task: do not write a compose file or start Postgres yourself, and do not rewrite the schema because of this error. A note starting with 'Team (database)' in your assignment tells you whether it is running.",
        "Outside team mode: if a docker-compose.yml with a db service exists and Docker works: docker compose up -d db, then docker compose ps until it is healthy, then migrate once.",
        'Otherwise end this step with: "migration not applied: need a running PostgreSQL and a real DATABASE_URL" (add: start Docker Desktop and run /tasks resume).',
      ],
    }),
  },
  {
    id: "hookform-resolvers-peer",
    test: (c, o) => /ERESOLVE/.test(o) && /@hookform\/resolvers/.test(o) && /npm (install|i|add)\b/.test(c) && !/@hookform\/resolvers@5/.test(c),
    fix: () => ({
      title: "@hookform/resolvers v6 cannot be resolved with its optional peers",
      steps: [
        "Install version 5 instead: npm install @hookform/resolvers@5 (the same command with @hookform/resolvers@5 in place of @hookform/resolvers). It installs cleanly and supports zod.",
        "Do not use --force. Do not remove other packages.",
      ],
    }),
  },
  {
    id: "types-package-404",
    test: (c, o) => /\bE404\b|404 Not Found/i.test(o) && /@types\/[\w.-]+/.test(o) && /npm (install|i|add)\b/.test(c),
    fix: (o) => {
      const m = /(@types\/[\w.-]+)/.exec(o);
      const name = m ? m[1] : "@types/<name>";
      return {
        title: `${name} does not exist on the npm registry`,
        steps: [
          `Do not install ${name}. Many packages ship their own types: ${SELF_TYPED_PACKAGES.join(", ")}.`,
          "Run the same install command again WITHOUT any @types/<name> entry for those packages, then npx tsc --noEmit.",
          "If a package really has no types, check once with: npm view @types/<name> version. Never guess a version.",
        ],
      };
    },
  },
  {
    id: "next-auth-peer-next16",
    test: (_c, o) => /ERESOLVE/.test(o) && /next-auth/.test(o) && /peer next@/i.test(o),
    fix: () => ({
      title: "This next-auth version does not accept Next 16 as a peer",
      steps: [
        "Install next-auth@4.24.15 (its peer range includes next ^16). Older 4.24.x releases stop at next ^15.",
        "Command: npm install next-auth@4.24.15. Do not use --force, do not downgrade Next, do not switch to next-auth@beta unless the request asks for Auth.js v5.",
      ],
    }),
  },
  {
    id: "prisma7-client-ctor",
    test: (_c, o) => /PrismaClient needs to be constructed|requires either "adapter" or "accelerateUrl"|engine type "client" requires/i.test(o),
    fix: () => ({
      title: "Prisma 7: the client needs a driver adapter",
      steps: [
        'Create the client with the adapter: import { PrismaPg } from "@prisma/adapter-pg"; new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) }).',
        "Import PrismaClient from the generator output folder (for example @/generated/prisma/client), keep ONE client file, and make sure @prisma/adapter-pg@7 and pg are installed in that app.",
      ],
    }),
  },
  {
    id: "types-node-peer",
    test: (_c, o) => /ERESOLVE/.test(o) && /peerOptional @types\/node@/.test(o),
    fix: () => ({
      title: "A package (for example vitest 5) needs a newer @types/node than the project has",
      steps: [
        "Update the cause instead of forcing every install: npm install -D @types/node@^24 (use the major that matches `node -v`, at least 22). Do not downgrade the package that asked for it.",
        "Then repeat the original command once. If it still reports ERESOLVE, create apps/web/.npmrc containing legacy-peer-deps=true so later installs by every agent work.",
      ],
    }),
  },
  {
    id: "npm-eresolve",
    test: (_c, o) => /ERESOLVE/.test(o),
    fix: (o) => {
      const dep = dependencyConflict(o);
      return {
        title: "npm cannot resolve the peer dependencies",
        steps: [
          (dep ? `The conflict: ${dep}. ` : "") + 'Read the lines "Found:" and "Could not resolve dependency:" once.',
          "If a package asks for a different major of something you chose, install the major it asks for (npm view <pkg> version peerDependencies).",
          "If only an OPTIONAL peer (peerOptional) conflicts, run the same command ONCE more with --legacy-peer-deps. Never --force.",
          "If the same conflict returns, stop and report the packages involved.",
        ],
      };
    },
  },
  {
    id: "scaffold-name",
    test: (_c, o) => /Could not create a project called "[^"]+" because of npm naming restrictions/.test(o),
    fix: (o) => {
      const m = /project called "([^"]+)"/.exec(o);
      return {
        title: "The folder name is not a valid npm package name",
        steps: [
          `The scaffolder takes the name from the target folder${m ? ` ("${m[1]}")` : ""}. npm names are lowercase, no spaces.`,
          "Scaffold into a new lowercase folder: mkdir -p apps && npx --yes create-next-app@16 apps/web ... (do not scaffold into . inside a capitalised folder).",
        ],
      };
    },
  },
  {
    id: "scaffold-not-writable",
    test: (_c, o) => /application path is not writable/i.test(o),
    fix: () => ({
      title: "The parent folder does not exist",
      steps: ["Run mkdir -p apps (the parent of the target), then the scaffold command again. Do not create apps/web yourself."],
    }),
  },
  {
    id: "next-google-fonts",
    test: (_c, o) => /Failed to fetch [^\n]* from Google Fonts|next\/font: error/.test(o),
    fix: () => ({
      title: "The build is offline and next/font/google cannot download the font",
      steps: [
        "Remove the next/font/google import from src/app/layout.tsx and the font class names that use it.",
        "Use a system font stack in globals.css (font-family: system-ui, sans-serif) or next/font/local with a font file in the project.",
      ],
    }),
  },
  {
    id: "next-prerender-dynamic",
    test: (_c, o) => /uncached or runtime data during prerendering|blocking-prerender-dynamic/.test(o),
    fix: () => ({
      title: "Next 16 Cache Components: data is read outside <Suspense>",
      steps: [
        "Move the code that reads cookies(), headers(), params, searchParams, fetch or the database into its own async component.",
        "Render it inside the page as <Suspense fallback={<p>Loading...</p>}><ThatComponent /></Suspense> (import Suspense from react).",
        "Only if the whole route must block: export const instant = false in that page file.",
      ],
    }),
  },
  {
    id: "missing-script",
    test: (_c, o) => /Missing script: "?[^"\n]+"?/.test(o),
    fix: (o) => {
      const m = /Missing script: "?([^"\n]+)"?/.exec(o);
      return {
        title: `package.json has no script "${m ? m[1] : "?"}" in that folder`,
        steps: [
          "Read the scripts block of the package.json in the folder the command ran in. Use the real script name, or add the script.",
          "In a monorepo run it from the project root with npm --prefix apps/<name> run <script>.",
        ],
      };
    },
  },
  {
    id: "port-in-use",
    test: (_c, o) => /EADDRINUSE|address already in use/i.test(o),
    fix: (o) => {
      const m = /:(\d{2,5})\b/.exec(o.slice(o.search(/EADDRINUSE|address already in use/i)));
      const port = m ? m[1] : "PORT";
      return {
        title: `Port ${port} is already taken`,
        steps: [
          `Find the owner: lsof -i :${port} (read-only). Tell the person what it is; do not kill a process you did not start.`,
          `Start your server on another port (for example PORT=3001) or ask the person to stop the other one.`,
        ],
      };
    },
  },
];

/** The known fixes that match a failed command's output, best first. */
export function matchKnownFixes(command: string, output: string, max = 2): KnownFix[] {
  const found: KnownFix[] = [];
  for (const rule of RULES) {
    if (found.length >= max) break;
    let hit = false;
    try {
      hit = rule.test(command, output);
    } catch {
      hit = false;
    }
    if (hit) found.push({ id: rule.id, ...rule.fix(output) });
  }
  return found;
}

/** Text for the tool result: short, numbered, imperative. */
export function formatKnownFixes(fixes: KnownFix[]): string {
  return fixes
    .map((f) => `KNOWN FIX (${f.id}): ${f.title}\n${f.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`)
    .join("\n\n");
}

/**
 * How often one known fix may be shown in a run before the agent is told to stop. The recipe is exact: if the same
 * failure comes back after it was applied twice, the cause is something else and more tries only cost tokens.
 */
export const KNOWN_FIX_SHOW_LIMIT = 3;

export function knownFixStopText(fix: KnownFix, command: string): string {
  return (
    `I stopped because the same known problem came back ${KNOWN_FIX_SHOW_LIMIT} times: ${fix.title}.\n` +
    `Command: ${command}\n` +
    "The standard fix was shown to the agent each time but the error did not go away, so something specific to this project differs from the usual case.\n" +
    "What to do:\n" +
    fix.steps.map((s, i) => `${i + 1}. ${s}`).join("\n") +
    "\nIf you did all of that and it still fails, send me the first error line and the file it names."
  );
}
