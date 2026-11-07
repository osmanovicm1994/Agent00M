# Known failures and their fixes (apply the fix, run the failing command ONCE)

The agent also attaches these automatically as "knownFix" when it recognises the output. A known fix is applied directly: no investigation, no listing of node_modules. If the same fix does not work after one retry, stop and report the exact error.

| Output contains | Cause | Fix |
| --- | --- | --- |
| `P1012` + "not a valid field or attribute definition" with a `#` comment on the line | `#` is not a comment in schema.prisma | Rewrite the whole schema file with `//` comments |
| "datasource property `url` is no longer supported" | Prisma 7 moved the URL out of the schema | Delete the `url` line from `datasource db`; create `prisma.config.ts` (recipe 03 section 1); pass the pg adapter to `new PrismaClient` |
| `Cannot find module 'prisma/...'`, or `defineConfig` not exported | wrong import path for the config | `import { defineConfig } from "prisma/config"` and `npm install -D prisma@7` in that app |
| "Cannot resolve environment variable: DATABASE_URL" | `env()` throws when unset | In `prisma.config.ts` use `process.env.DATABASE_URL ?? "postgresql://user:password@localhost:5432/app"` |
| `@prisma/client did not initialize yet`, no exported member `PrismaClient` | client not generated, or Prisma 7 import path | `npx prisma generate` in the folder with `schema.prisma`; Prisma 7: import from the generated `output` folder (`@/generated/prisma/client`), not `@prisma/client` |
| `P1001` / "Can't reach database server" / `ECONNREFUSED ...:5432` | no database running or wrong `DATABASE_URL` | Do not repeat migrate. `docker compose up -d db` if a compose file exists, else report "need a running Postgres and DATABASE_URL". `validate` and `generate` still work |
| `ERESOLVE` mentioning `@hookform/resolvers@6` or `effect@^4` | resolvers v6 optional-peer conflict | `npm install @hookform/resolvers@5` |
| `E404` for `@types/<name>` | that package ships its own types (zod, bcryptjs, jose, pdf-lib, next-auth, react-hook-form) | Install the command again without any `@types/<name>` entry; never guess a version |
| `ERESOLVE` mentioning `next-auth` and `peer next@` | next-auth older than 4.24.15 does not accept Next 16 | `npm install next-auth@4.24.15` |
| `PrismaClient needs to be constructed...` / `requires either "adapter"` | Prisma 7 client built without an adapter | `new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })` (recipe 03) |
| any other `ERESOLVE` | peer ranges disagree | Read the "Could not resolve dependency" lines; install the version the peer asks for. If an optional peer is the only conflict, rerun ONCE with `--legacy-peer-deps`. Never `--force` |
| `Could not create a project called "X" because of npm naming restrictions` | capital letters or spaces in the folder name | Scaffold into a lowercase folder (`apps/web`), not `.` inside a capitalised folder |
| "application path is not writable" | parent folder missing | `mkdir -p apps` first |
| `Failed to fetch ... from Google Fonts` | build is offline | Remove `next/font/google`; use a system font stack or `next/font/local` |
| "uncached or runtime data during prerendering" (Next 16) | data read outside `<Suspense>` with `cacheComponents` on | Move the data read into its own async component and wrap it in `<Suspense fallback={...}>` |
| `Missing script: "x"` | script not in that package.json | Read `package.json` scripts; run the right one or add it; check you are in the right folder (`npm --prefix apps/web run x`) |
| `EADDRINUSE :3000` | port taken | `lsof -i :3000`, tell the person who owns it; use another port (`PORT=3001`) instead of killing |
| `npm error engine Unsupported engine` / `EBADENGINE` | Node too old for a package | Not fixable in code: the diagnosis block gives the exact command for the person |
| `spawn uvx ENOENT` (MCP fetch server) | `uv` not installed | Harmless: web_fetch built into the agent still works. Person can `brew install uv` |

## Stop rules
- Same error text twice after a fix: the fix was wrong or incomplete. Re-read the FIRST error line, check the one file it names, then change something different. Do not list node_modules.
- Three failed attempts on one command: write what you tried, the first error line and what is needed (a value, a tool, a decision), and end.
