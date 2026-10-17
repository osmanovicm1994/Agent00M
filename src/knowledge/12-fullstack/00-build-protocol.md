# Building a Full-Stack Project (new project or large feature)

## 1. Foundation first
- Before feature code, write `docs/PROJECT.md` (stack with versions, folder layout, naming, env variable NAMES, the commands that verify the project) and `docs/PLAN.md` (a checklist of small tasks). Tick tasks off and note decisions as you go; if you are resumed, read both first.
- Typical layout: `apps/web` (Next.js), `apps/api` (NestJS), shared types in `packages/*` or generated from the API's OpenAPI document. Follow the layout already on disk if there is one.

## 2. Vertical slices
- Build one feature end to end (database model, API endpoint with validation and tests, web page, e2e test), verify it, then the next. Do not build all models, then all endpoints, then all pages.
- Every slice ends green: typecheck, lint, unit tests, build. Run them yourself and fix failures before moving on.

## 3. Never code a fast-moving API from memory
- Read the installed version (`package.json`, lockfile) and say which major you assume. If you are not certain about a call (Next.js, NestJS, Prisma, Tailwind, the AWS SDK change often), check the docs tool or `web_research` before writing it. Prefer what the installed package's own README or types show.

## 4. Scaffolding runs non-interactively
- A scaffolder that asks a question fails here (no input). Run `<tool> --help` once, then pass every choice as a flag. Install and build commands can take minutes; do not set a short timeout for them.
- Scaffold into a clean directory first, inspect the result with `get_directory_tree`, then adapt it; do not scaffold over existing files.

## 5. Secrets and environments
- Real secrets are never written, printed or committed. Create `.env.example` with names and harmless placeholders, read config through one typed config module, and tell the user which values to supply.
- Separate development, test and production databases and buckets. Never use a production connection string while building.

## 6. What the agent does not do alone
- No deploy, no push, no dropping data, no production credentials. Produce scripts and a runbook; the user runs them.

## 7. Finish
- Report: what was built, which commands verified it (with results), what was NOT verified (visual check, real devices, production behavior), and the next task from `docs/PLAN.md`.
