# Local infrastructure, environment files, Docker, CI

## Environment files
- `.env.example` (committed): every variable NAME with a harmless placeholder and a one-line comment (`# comment` is fine in .env files, but NOT in schema.prisma). `.env` / `.env.local` (never committed, never read or printed by the agent): real values.
- Read config through one module (`src/lib/env.ts`) that parses `process.env` with zod and throws a clear message naming the missing variable. Next.js loads `.env.local` itself; Prisma's config needs `import "dotenv/config"`.
- Ports: web 3000, api 3001, Postgres 5432 (change the host side only: `"5433:5432"`). If a port is taken, find the owner (`lsof -i :3000`), tell the person, do not kill unknown processes.

## Local Postgres with Docker (only when the project has no database yet and Docker is installed)
`docker-compose.yml`:
```yaml
services:
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 5s
      timeout: 3s
      retries: 10
volumes:
  pgdata:
```
- `.env.example`: `DATABASE_URL=postgresql://app:app@localhost:5432/app` (local development credentials only).
- Commands: `docker compose config` (validate), `docker compose up -d db`, `docker compose ps` (wait for `healthy`), then `npx prisma migrate dev`. Stop with `docker compose stop db`. Never `docker compose down -v` (deletes the data) without approval.
- `docker: command not found` or the daemon is not running: say so and stop that step. Prisma validate/generate and the whole build still work without a database.

## Dockerfile for the Next.js app (multi-stage, standalone output)
- Set `output: "standalone"` in `next.config.ts` (keep the scaffold's other options). Stages: `deps` (`npm ci`), `build` (copy source, `npx prisma generate`, `npm run build`), `run` (copy `.next/standalone`, `.next/static`, `public`; `USER node`; `CMD ["node", "server.js"]`, `EXPOSE 3000`). Use the same Node major as `.nvmrc` (`FROM node:22-alpine`).
- Add `.dockerignore`: `node_modules`, `.next`, `.git`, `.env*`, `*.log`. Secrets come in at run time (`--env-file`), never baked into the image.
- `docker build` only when the person asked and Docker works; otherwise write the file and say it was not built.

## GitHub Actions: `.github/workflows/ci.yml`
```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: apps/web
    env:
      DATABASE_URL: postgresql://app:app@localhost:5432/app
      SESSION_SECRET: ci-only-secret-not-used-anywhere-else
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
          cache-dependency-path: apps/web/package-lock.json
      - run: npm ci
      - run: npx prisma generate
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
      - run: npm run build
```
- Adjust `working-directory` and `.nvmrc` path to the real layout. Add a `services: postgres:` block and `npx prisma migrate deploy` only when tests need a database. Add a Playwright job after the unit job passes.
- The agent writes the workflow; it does not push, so the first run happens when the person pushes.

## Deploy readiness checklist (report, do not execute)
Build passes from a clean clone; `.env.example` complete; migrations committed; `npx prisma migrate deploy` is the production migration command; health endpoint `/api/health` returns 200 without touching secrets; README lists run, test and deploy commands; version tagged.
