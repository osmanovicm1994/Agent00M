# Project rules (copy to the root of your project as AGENTS.md and edit)

The agent reads this file on every task (first ~3500 characters), so prompts do not have to repeat the stack.

## Stack
- Web: Next.js (App Router), TypeScript, Tailwind CSS. Folder: `apps/web`.
- API: NestJS, TypeScript. Folder: `apps/api`. Custom JWT auth (no Auth0/Clerk/Supabase).
- Database: PostgreSQL on Neon, Prisma. Files: Cloudflare R2 (presigned uploads).
- Deploy: Docker + docker compose + Caddy on a VPS. CI: GitHub Actions.
- Tests: unit tests next to the code, Playwright for e2e in `apps/web/e2e`.

## Layout and commands
- Each app has its own `package.json` and lockfile (no npm workspaces). Use `npm --prefix apps/<app> ...` from the project root.
- Verify with: `npm --prefix apps/api run build`, `npm --prefix apps/api test`, `npm --prefix apps/web run build`.
- Root scripts: `dev:api`, `dev:web`, `build`, `test`.

## Rules
- Secrets never go into code, logs or git. Names and placeholders only in `.env.example`.
- No tokens in localStorage or sessionStorage. Refresh token in an httpOnly cookie.
- Every task ends with the verify commands above, run by you, and a summary of what was NOT verified.
- No `next/font/google` (builds must work offline).
