# Delivery roadmap: empty folder to shippable app

Work in phases. Every phase ends with a GATE: a command that must exit 0. Do not start the next phase on a red gate. Most of your steps belong to building; a failed gate gets two fix attempts, then look it up in `13-delivery/05-known-fixes.md`, then report. Never spend more steps on one failure than on a feature.

## Phase 0. Preflight (once, 5 commands)
- `node -v && npm -v` and compare with `13-delivery/02-versions-2026.md`. A Node that is too old is the person's to fix (say the exact command and stop); never upgrade Node or npm yourself.
- `git rev-parse --is-inside-work-tree`. If not a repo: `git init -b main` (see `01-git-versioning.md`). Write `.nvmrc`, `.gitignore`, `.env.example` first.
- Read any spec file the user named (docs/*.md, context.md) completely before choosing anything.
GATE: node satisfies the table, git works.

## Phase 1. Plan on disk
- `docs/PROJECT.md`: stack with exact versions, folder layout, env variable NAMES, verify commands. `docs/PLAN.md`: at most 8 vertical slices, each with one acceptance check you can run.
GATE: both files exist and match the spec's wording (names, languages, rules).

## Phase 2. Skeleton
- Scaffold with the exact command in `12-fullstack/09-scaffolding.md`, into a lowercase folder. Install ALL planned dependencies in ONE command (`13-delivery/02-versions-2026.md` lists the pins). Add scripts: `typecheck`, `test`, `lint`, `build`.
- Remove scaffold demo content; keep the build green.
- Run `npm ls --depth=0` after the install: it must list no `missing`, `invalid` or `UNMET` lines. Replace the starter page and the "Create Next App" title before the gate (a build that still shows them is not a skeleton, it is the unchanged scaffold).
GATE: `npm ls --depth=0`, `npm run typecheck` and `npm run build` exit 0. Commit `chore: scaffold app`.

## Phase 3. Data layer
- Database: use what exists (hosted URL in `.env`, a compose file, local Postgres). To start one locally see `04-local-infra-ci.md`. Write `schema.prisma` + `prisma.config.ts` (`13-delivery/03-recipe-nextjs-prisma-auth.md`), then `npx prisma validate`, `npx prisma generate`, and `npx prisma migrate dev --name init` only when a database answers.
GATE: validate and generate exit 0; migration applied OR reported as "not applied: no database reachable".

## Phase 4. Auth (only if the spec has accounts)
- Follow the session recipe (03), or the NextAuth + roles recipe (06) when the spec names NextAuth, roles or per-user data. Hash passwords, validate input with zod on the server, never trust the client.
GATE: a test or script registers, logs in, and is refused on a wrong password.

## Phase 5. Feature slices, one at a time
- Each slice: model -> server code with validation -> page -> test. Write whole files; read the file before changing it.
- After EACH slice: `npm run typecheck && npm run lint && npm test && npm run build`, then a commit `feat(<area>): <what>`.
GATE: all four green. Do not batch several slices before running them.

## Phase 6. Quality
- One end-to-end smoke test of the main flow (Playwright), keyboard and label check on forms, empty/loading/error states, `README.md` with the exact run steps.
GATE: smoke test passes, README commands copy-paste work.

## Phase 7. Release
- `npm version 0.1.0 --no-git-tag-version` (or `minor`), `CHANGELOG.md`, tag `v0.1.0` (see `01-git-versioning.md`), `Dockerfile` and CI from `04-local-infra-ci.md`. Never push or deploy; give the person the commands.
GATE: `npm ci && npm run build` works from a clean checkout.

## Token discipline
- One install per phase, one command per call, whole-file writes. Do not list node_modules; read installed package docs through their own README or `node_modules/next/dist/docs/`.
- After 2 identical outcomes (same error, same listing), change the approach or report. Looking again is not progress.
- Final answer: what was built, commands that verified it with exit codes, what was NOT verified, next step.
