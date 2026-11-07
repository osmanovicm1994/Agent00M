# Recipe: npm workspaces with the database in `packages/db` (only when the request names it)

Use this layout ONLY when the request says so ("Prisma in packages/db", "monorepo"). Without that, the default is one app in `apps/web` with `apps/web/prisma/` (see `03-recipe-nextjs-prisma-auth.md`). Never create both layouts.

STATUS: the workspace wiring below is the standard npm-workspaces pattern, but it was NOT built end to end in the checking sandbox (the Prisma engine download was blocked there). The gates at the end are what prove it on the real machine; if one fails, read the first error line and fix that file, do not switch layouts.

## Layout
```
package.json            { "private": true, "workspaces": ["apps/*", "packages/*"], "scripts": { ... } }
.nvmrc  .gitignore  .env.example
apps/web/               the Next.js app (scaffolded here, see 12-fullstack/09-scaffolding.md)
packages/db/
  package.json          { "name": "@app/db", "private": true, "type": "module", "main": "./src/index.ts", "types": "./src/index.ts" }
  prisma/schema.prisma
  prisma.config.ts
  src/index.ts          export * from "./client"; export * from "./generated/client";
  src/client.ts         the PrismaClient singleton (same code as db.ts in recipe 03, relative import ./generated/client)
```
The schema generator: `output = "../src/generated"` (relative to `packages/db/prisma/`). Add `packages/db/src/generated/` to `.gitignore`.

## Wiring
- Root `package.json` scripts run through workspaces: `"typecheck": "npm run typecheck --workspaces --if-present"`, `"build": "npm --prefix apps/web run build"`, `"db:generate": "npm --prefix packages/db exec prisma generate"`, `"db:migrate": "npm --prefix packages/db exec prisma migrate dev"`.
- `apps/web/package.json` depends on `"@app/db": "*"`; `apps/web/next.config.ts` gets `transpilePackages: ["@app/db"]` because the package ships TypeScript source.
- Install ONCE from the repository root: `npm install` (workspaces link `@app/db` into `node_modules`). Do not run `npm install` separately inside each package.
- Prisma commands run in `packages/db` (that is where `prisma.config.ts` and `schema.prisma` are): `npm --prefix packages/db exec prisma validate`, then `generate`, then `migrate dev --name init` only when a database answers. `prisma.config.ts` uses the same fallback URL as recipe 03.
- App code imports `import { prisma } from "@app/db"`; no `@/generated/...` path exists in this layout.
- `.env` lives at the root; `prisma.config.ts` reads `DATABASE_URL` (load it with `dotenv/config` from the root: `import { config } from "dotenv"; config({ path: "../../.env" });`).

## Gates (run in this order, each must exit 0)
1. `npm ls --depth=0` at the root (no missing or invalid packages).
2. `npm --prefix packages/db exec prisma validate`, then `generate`.
3. `npm run typecheck` (the app resolves `@app/db` types after generate).
4. `npm --prefix apps/web run build`.
If step 2 cannot download the Prisma engines (no network), report it as "not verified: prisma generate could not run" and keep the schema and code.
