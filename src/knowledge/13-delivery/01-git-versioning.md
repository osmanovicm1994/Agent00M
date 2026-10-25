# Git, branches, commits, versions, releases

## Start every project in git
- `git rev-parse --is-inside-work-tree` first. Not a repo: `git init -b main`. A project without git has no undo; the agent warns about it.
- First commit contains `.gitignore`, `.nvmrc`, `.env.example`, `README.md`.
- `.gitignore` always: `node_modules/`, `.next/`, `dist/`, `build/`, `coverage/`, `.env`, `.env.*`, `!.env.example`, `*.log`, `.DS_Store`, `test-results/`, `playwright-report/`.
- Prisma 7 writes its client to `src/generated/prisma`. Either ignore it and run `npx prisma generate` before every typecheck/build (CI, Docker, fresh clone), or commit it. Choose one and write the choice in `docs/PROJECT.md`.
- A scaffolder may run `git init` itself. If the project root is already a repo, scaffold with `--disable-git` (create-next-app) or `--skip-git` (Nest CLI) so there is no repo inside a repo.

## Branches
- `main` is always green (typecheck, tests, build pass). Work happens on `feature/<name>` (kebab-case). In team mode each task gets `task/<area>-<what>` (for example `task/auth-model`) cut from the feature branch.
- Merge with `git merge --no-ff <branch>` so history shows the feature, then delete the merged branch. Resolve a conflict by reading both sides; never pick one blindly.
- The agent never pushes, force-pushes, rebases shared history or runs `git reset --hard` / `git clean -fd` without approval. Provide the push command for the person.

## Commits (Conventional Commits)
- Format: `type(scope): subject`. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`. Subject imperative, lowercase, no period, at most 72 characters. Body (optional) explains WHY. Breaking change: `feat(api)!: ...` plus a `BREAKING CHANGE:` line.
- One logical change per commit; commit only when the slice's gate is green. Example: `feat(auth): add register action with zod validation`.
- Never commit secrets, `.env`, build output or lockfile-less dependency changes.

## Versions (SemVer)
- `MAJOR.MINOR.PATCH`. Start at `0.1.0` and stay `0.y.z` until the public interface is stable. Breaking change -> MAJOR (or MINOR while 0.y), new feature -> MINOR, fix -> PATCH. Pre-release: `1.0.0-rc.1`.
- Release from a clean `main`: update `CHANGELOG.md`, then `npm version minor -m "chore(release): %s"` (bumps `package.json`, commits, tags `vX.Y.Z`).
- `CHANGELOG.md` in Keep a Changelog form: `## [Unreleased]` on top, then `## [0.2.0] - 2026-10-24` with `### Added`, `### Changed`, `### Fixed`, `### Removed`.
- Apps are not published to npm: keep `"private": true` in `package.json`.

## Reproducible installs
- Commit the lockfile (`package-lock.json`). Local: `npm install <pkg>`. CI and Docker: `npm ci` (fails when lockfile and package.json disagree, which is the point).
- Pin the runtime: `.nvmrc` (for example `22`) and `"engines": { "node": ">=22.12" }`. Add `engine-strict=true` to `.npmrc` so a wrong Node fails at install with a clear message instead of later.
- Dependency policy: install fast-moving majors with an explicit major (`prisma@7`, `@prisma/client@7`); `@latest` may be a release candidate. Check `npm view <pkg> version engines.node peerDependencies` before adding. Upgrade ONE package per commit (`chore(deps): bump <pkg> to <v>`) and run the full gate.
- Never change versions to silence an error you have not read.

## Databases and APIs are versioned too
- Migrations are append-only files in `prisma/migrations/`; never edit an applied one, add a new one.
- Public HTTP APIs: prefix `/api/v1/...` once other clients depend on them; a breaking change gets `/api/v2`.
- Environments: development (local), test (disposable database), production (never touched by the agent).
