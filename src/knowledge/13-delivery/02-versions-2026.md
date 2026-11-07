# Known-good versions and install commands (checked on npm, October 2026)

These were checked with `npm view` and a real scaffold. Registries move: for anything not listed run `npm view <pkg> version engines.node peerDependencies` once, then install with an explicit major. If the installed project already uses other majors, keep them.

## Runtime
| Tool | Needs Node |
| --- | --- |
| next 16.4, create-next-app 16 | >=20.9 |
| prisma 7, @prisma/client 7 | ^20.19 or ^22.12 or >=24 |
| vitest 5 | ^22.12 or ^24 or >=26 |
| @playwright/test 1.64 | >=20 |
| npm 12 | ^22.22.2 or ^24.15 or >=26 (and it turns dependency install scripts off by default) |
Choose an even-numbered LTS (22 or 24). Use the person's Node if it satisfies the table; never upgrade Node or npm yourself. Write `.nvmrc` with the major.

## Pins that matter
| Package | Install as | Why |
| --- | --- | --- |
| next, react, react-dom | what `create-next-app@16` writes (next 16.4.x, react 19.3.x) | do not retype versions |
| prisma | `npm install -D prisma@7` | the `latest` tag is currently an 8.0 release candidate |
| @prisma/client, @prisma/adapter-pg, pg, dotenv | `npm install @prisma/client@7 @prisma/adapter-pg@7 pg dotenv` | Prisma 7 needs the pg driver adapter |
| zod | `zod` (4.x) | `z.email()`, `parsed.error.issues` |
| react-hook-form | `react-hook-form` (7.x) | |
| @hookform/resolvers | `@hookform/resolvers@5` | v6 fails with ERESOLVE (optional peer `effect@^4`); v5 installs clean |
| jose, bcryptjs, server-only | `jose bcryptjs server-only` (jose 6, bcryptjs 3 with built-in types) | session cookie + password hash, no native build |
| next-auth | `next-auth@4.24.15` when the spec asks for NextAuth/Auth.js (recipe 06); 4.24.7 and older refuse Next 16; 5 is still a beta | otherwise use the session recipe (03) |
| `@types/*` | NEVER for zod, bcryptjs, jose, pdf-lib, next-auth, react-hook-form: they ship their own types (`@types/bcryptjs` is a 404) | `@types/node`, `@types/react`, `@types/react-dom` come from the scaffold |
| PDF output | no PDF library by default: print stylesheet (`print:` classes + `@page`) and the browser's print-to-PDF | add `pdf-lib` only if the spec needs a generated file |
| typescript, eslint | keep what the scaffold wrote (typescript ^5, eslint ^9) | `latest` is a newer major (7 and 10) that plugins may not support yet |
| tailwindcss | keep the scaffold's (4.x via `@tailwindcss/turbopack`) | no `tailwind.config.js`, no postcss file; styles start with `@import "tailwindcss";` |
| @playwright/test | `npm install -D @playwright/test` then `npx playwright install chromium` | |

## Scaffold and install, in this order
1. `mkdir -p apps` then `npx --yes create-next-app@16 apps/web --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --disable-git --yes`
   - Folder name must be lowercase (the name comes from the folder). Flags checked with `--help`: `--use-npm` (not `--package-manager`), `--disable-git` (not `--no-git`), `--yes`.
   - The scaffold writes `AGENTS.md` and keeps offline docs in `node_modules/next/dist/docs/`; read those instead of guessing an API.
2. One install: `npm --prefix apps/web install @prisma/client@7 @prisma/adapter-pg@7 pg dotenv zod react-hook-form @hookform/resolvers@5 jose bcryptjs server-only` and `npm --prefix apps/web install -D prisma@7 @playwright/test`.
3. Scripts in `apps/web/package.json`: `"typecheck": "tsc --noEmit"`, `"lint": "eslint"`, `"test": "vitest run"` (add `vitest` as a dev dependency) , plus the scaffold's `dev`, `build`, `start`.
4. `npm --prefix apps/web run typecheck && npm --prefix apps/web run build` BEFORE adding features.

## Next.js 16 facts that break builds
- `next.config.ts` from the scaffold has `cacheComponents: true`: reading `cookies()`, `headers()`, `params`, `searchParams`, `fetch` or the database outside `<Suspense>` fails `next build` ("uncached or runtime data during prerendering"). Put the data-reading code in its own async component and wrap it in `<Suspense fallback={...}>` (see the recipe). Escape hatch for a whole route: `export const instant = false`.
- `params` and `searchParams` are Promises: `const { id } = await params`. `cookies()` and `headers()` are async.
- `middleware.ts` is now `proxy.ts` exporting `proxy(request)`. Check sessions in server code, not only in the proxy.
- `next lint` is gone: the script is plain `eslint`. Fonts from Google need network at build: offline use a system font stack or `next/font/local`.
