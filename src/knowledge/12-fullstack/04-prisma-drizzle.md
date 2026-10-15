# Prisma and Drizzle (PostgreSQL)

Use the ORM the project already has. Check its installed major first: Prisma 7 and newer moved connection settings into `prisma.config.ts` and use driver adapters, so older `schema.prisma` examples may be wrong. Confirm with `npx prisma --version` and the docs tool.

## Both
- Schema is the source of truth; change it through migrations only (see `06-database/02-migration-safety.md`). Never edit an applied migration; never run a reset or `db push --force` against anything but a disposable local or branch database.
- One database client per process (a provider/singleton in Nest, a module-level instance in Next.js with a guard against hot-reload duplicates). Close it on shutdown.
- Map ORM types to DTOs at the boundary. Use transactions for multi-step writes. Select only needed columns on hot paths; load relations deliberately to avoid N+1.
- Add indexes for foreign keys and filter/sort columns; use unique constraints and handle their errors (`P2002` in Prisma; the Postgres `23505` code in Drizzle).
- Seeds are idempotent and never contain real data or secrets.

## Prisma workflow
- `npx prisma init --datasource-provider postgresql`; edit the schema; `npx prisma migrate dev --name <change>` locally (creates and applies the migration, regenerates the client); `npx prisma migrate deploy` in CI and production; `npx prisma generate` after dependency installs.
- With a pooled connection (Neon, PgBouncer) migrations need the DIRECT connection (see `05-neon-postgres.md`).
- "Client not generated" or type errors after a schema change: run `generate`.

## Drizzle workflow
- Schema in TypeScript (`pgTable`), `drizzle.config.ts` with the dialect and credentials from env; `drizzle-kit generate` creates SQL migrations, `drizzle-kit migrate` applies them (review the SQL; avoid `push` outside local prototyping).
- Pick the driver to match the runtime: `node-postgres`/`postgres` for a long-running server, the Neon serverless/HTTP driver for edge or serverless.
