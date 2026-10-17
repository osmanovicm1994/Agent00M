# Docker and VPS Deployment

The agent prepares files and scripts; a person runs deployments. Never run `ssh`, `scp`, `docker` commands against a server, or anything with production credentials from the agent session.

## Dockerfiles
- Multi-stage builds: a build stage installs dev dependencies and builds; the runtime stage copies only the output and production dependencies. Pin base image versions (a specific Node LTS tag, slim or alpine), not `latest`.
- Run as a non-root user, set `NODE_ENV=production`, add `HEALTHCHECK` (or a compose healthcheck), `.dockerignore` (node_modules, .git, .env*, build caches, tests).
- Next.js: use the standalone output for a small image if the project enables it. NestJS: run `node dist/main.js`, not `npm run start:dev`. Never bake secrets into an image or build args.
- Prisma in containers: run `prisma generate` in the build stage; run `prisma migrate deploy` as a separate one-off step before starting the new version, not on every container start of several replicas.

## Compose
- One service per process (web, api, reverse proxy; a database only for local dev, since production uses Neon). `depends_on` with `condition: service_healthy`, restart policy, resource limits, named volumes for data, `env_file` for configuration (the file lives on the server, not in git).
- Validate with `docker compose config` (safe, offline) and `docker compose build`.

## VPS runbook (generate it, do not execute it)
- One-time: non-root deploy user with SSH keys only, firewall (22, 80, 443), automatic security updates, Docker installed, a reverse proxy (Caddy for automatic HTTPS, or nginx + certbot) in front of the containers, log rotation, backups, monitoring/uptime check.
- Each deploy: build and push images (from CI), pull on the server, run migrations, `docker compose up -d`, check health endpoints, keep the previous image tag for rollback.
- Provide scripts for deploy, rollback and a smoke test (`curl` the health URL); make them fail on the first error (`set -euo pipefail`) and print what they will do before doing it.

## Configuration
- A table of every environment variable (name, purpose, where it is set, required in which environment) in `docs/DEPLOYMENT.md`. Secrets only on the server or in the CI secret store.
